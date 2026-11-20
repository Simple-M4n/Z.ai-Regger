// HTTP transport built on node:http/https with HTTP(S) and SOCKS proxy support.
// No external dependencies: all requests in the tool go through this module.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import tls from 'node:tls';
import { proxyInfo } from './proxy.js';

const proxyDebug = process.env.ZAI_PROXY_DEBUG ? (...args) => console.error('[proxy]', ...args) : () => {};

export class HttpError extends Error {
  constructor(message, info = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = info.status ?? null;
    this.body = info.body ?? null;
    this.url = info.url ?? null;
    this.code = info.code ?? null;
  }
}

// Errors that occur before the request could have reached the server:
// safe to retry, the payload was never delivered.
const RETRYABLE_MESSAGES = [
  /disconnected before secure TLS connection/i,
  /proxy CONNECT (failed|timeout)/i,
  /socks proxy (failed|timeout|rejected|auth|no acceptable)/i,
  /request timeout after/i,
];
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

export function isRetryableConnectError(err) {
  if (!err) return false;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return RETRYABLE_MESSAGES.some((re) => re.test(msg));
}

function proxyAuthHeader(info) {
  if (info.username || info.password) {
    const cred = `${info.username}:${info.password}`;
    return `Basic ${Buffer.from(cred).toString('base64')}`;
  }
  return null;
}

// Open a CONNECT tunnel through an HTTP/HTTPS proxy to host:port.
function connectTunnel(info, host, port, timeout, insecure) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    const auth = proxyAuthHeader(info);
    if (auth) headers['Proxy-Authorization'] = auth;

    const lib = info.type === 'https' ? https : http;
    const req = lib.request({
      hostname: info.host,
      port: info.port,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      timeout,
      rejectUnauthorized: !insecure,
    });

    const fail = (err) => {
      try { req.destroy(); } catch { /* ignore */ }
      reject(err);
    };

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new HttpError(`proxy CONNECT failed: HTTP ${res.statusCode}`, { url: `${host}:${port}` }));
        return;
      }
      resolve(socket);
    });
    req.on('timeout', () => fail(new HttpError('proxy CONNECT timeout', { url: `${host}:${port}` })));
    req.on('error', fail);
    req.end();
  });
}

// https.Agent whose connections are established through the proxy tunnel + TLS.
function tunnelAgent(info, insecure, timeout) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (opts, cb) => {
    const host = opts.hostname || opts.host;
    const port = opts.port || 443;
    const servername = opts.servername || host;
    connectTunnel(info, host, port, timeout, insecure)
      .then((raw) => {
        const ts = tls.connect({ socket: raw, servername, rejectUnauthorized: !insecure });
        ts.once('secureConnect', () => cb(null, ts));
        ts.once('error', (err) => cb(err));
      })
      .catch((err) => cb(err));
    return undefined;
  };
  return agent;
}

// ── SOCKS4 / SOCKS5 (no external dependency) ────────────────────────

function sockError(message) {
  return new HttpError(`socks proxy ${message}`);
}

function ipv6Bytes(ip) {
  const halves = ip.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  const buf = Buffer.alloc(16);
  groups.slice(0, 8).forEach((g, i) => buf.writeUInt16BE(parseInt(g || '0', 16), i * 2));
  return buf;
}

function socks5Address(host) {
  if (net.isIPv4(host)) return Buffer.concat([Buffer.from([1]), Buffer.from(host.split('.').map(Number))]);
  if (net.isIPv6(host)) return Buffer.concat([Buffer.from([4]), ipv6Bytes(host)]);
  return Buffer.concat([Buffer.from([3, Math.min(255, Buffer.byteLength(host))]), Buffer.from(host, 'utf8')]);
}

// Returns a raw TCP socket after the SOCKS handshake succeeds.
function connectSocks(info, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: info.host, port: info.port });
    let stage = '';
    let pending = Buffer.alloc(0);
    let settled = false;

    const fail = (err) => {
      proxyDebug('fail', String(err?.message || err));
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err instanceof Error ? err : sockError(String(err)));
    };
    const finish = () => {
      proxyDebug('socks handshake done');
      if (settled) return;
      settled = true;
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      socket.setTimeout(0);
      resolve(socket);
    };
    const send = (buf, next) => {
      proxyDebug('send', next, `${buf.length} bytes`);
      stage = next;
      socket.write(buf);
    };

    const request5 = () => {
      const addr = socks5Address(host);
      const bytes = addr.subarray(1); // strip the ATYP byte; it goes in the header
      const req = Buffer.alloc(4 + bytes.length + 2);
      req[0] = 5; req[1] = 1; req[2] = 0; req[3] = addr[0];
      bytes.copy(req, 4);
      req.writeUInt16BE(port, req.length - 2);
      send(req, 'reply5');
    };
    const request4 = () => {
      const useDomain = info.remoteDns || !net.isIPv4(host);
      const user = Buffer.from(info.username || 'anonymous', 'utf8');
      const head = Buffer.alloc(8);
      head[0] = 4; head[1] = 1;
      head.writeUInt16BE(port, 2);
      if (useDomain) head.fill(0, 4, 8), (head[7] = 1);
      else Buffer.from(host.split('.').map(Number)).copy(head, 4);
      const tail = useDomain
        ? Buffer.concat([user, Buffer.from([0]), Buffer.from(host, 'utf8'), Buffer.from([0])])
        : Buffer.concat([user, Buffer.from([0])]);
      send(Buffer.concat([head, tail]), 'reply4');
    };

    const onData = (chunk) => {
      proxyDebug('recv', stage, `${chunk.length} bytes`);
      pending = Buffer.concat([pending, chunk]);
      if (stage === 'methods') {
        if (pending.length < 2) return;
        const method = pending[1];
        pending = pending.subarray(2);
        if (method === 0xff) return fail(sockError('no acceptable authentication method'));
        if (method === 2) {
          if (!info.username) return fail(sockError('server requested authentication'));
          const u = Buffer.from(info.username, 'utf8');
          const p = Buffer.from(info.password || '', 'utf8');
          send(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]), 'auth');
        } else {
          request5();
        }
        return;
      }
      if (stage === 'auth') {
        if (pending.length < 2) return;
        const ok = pending[1] === 0;
        pending = pending.subarray(2);
        if (!ok) return fail(sockError('authentication failed'));
        request5();
        return;
      }
      if (stage === 'reply5') {
        if (pending.length < 5) return;
        const code = pending[1];
        let size = 4;
        if (pending[3] === 1) size += 4;
        else if (pending[3] === 3) size += 1 + pending[4];
        else if (pending[3] === 4) size += 16;
        else return fail(sockError(`invalid reply (ATYP ${pending[3]})`));
        size += 2;
        if (pending.length < size) return;
        pending = Buffer.alloc(0);
        if (code !== 0) return fail(sockError(`connect rejected (code ${code})`));
        finish();
        return;
      }
      if (stage === 'reply4') {
        if (pending.length < 8) return;
        const ok = pending[1] === 0x5a;
        pending = Buffer.alloc(0);
        if (!ok) return fail(sockError('connect rejected'));
        finish();
      }
    };

    socket.on('data', onData);
    socket.on('error', fail);
    socket.setTimeout(timeout, () => fail(sockError('timeout')));
    socket.once('connect', () => {
      if (info.type === 'socks5' || info.type === 'socks5h') {
        send(info.username ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0]), 'methods');
      } else {
        request4();
      }
    });
  });
}

// Agent that opens every connection through a SOCKS proxy.
function socksAgent(info, isHttps, insecure, timeout) {
  const Agent = isHttps ? https.Agent : http.Agent;
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = (opts, cb) => {
    const host = opts.hostname || opts.host;
    const port = opts.port || (isHttps ? 443 : 80);
    proxyDebug('agent createConnection', host, port, info.type);
    connectSocks(info, host, port, timeout)
      .then((raw) => {
        if (!isHttps) {
          cb(null, raw);
          return;
        }
        const ts = tls.connect({ socket: raw, servername: opts.servername || host, rejectUnauthorized: !insecure });
        ts.once('secureConnect', () => cb(null, ts));
        ts.once('error', cb);
      })
      .catch(cb);
    return undefined;
  };
  return agent;
}

export class Transport {
  constructor({ proxy = null, timeout = 30000, insecure = false, onRetry = null } = {}) {
    this.proxy = proxyInfo(proxy);
    this.timeout = timeout;
    this.insecure = insecure;
    this.onRetry = onRetry;
  }

  // Returns { status, headers, body (Buffer) }. Follows up to `redirects`
  // redirects and retries connect-phase failures (`retries` times).
  async request(url, opts = {}) {
    const { retries = 3 } = opts;
    const attempts = Math.max(1, retries);
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this._requestOnce(url, opts);
      } catch (err) {
        lastErr = err;
        if (attempt === attempts || !isRetryableConnectError(err)) throw err;
        const backoff = 400 * attempt;
        if (this.onRetry) this.onRetry(url, err, attempt, backoff);
        await sleep(backoff);
      }
    }
    throw lastErr;
  }

  async _requestOnce(url, { method = 'GET', headers = {}, body = null, timeout = this.timeout, redirects = 3 } = {}) {
    let current = url;
    let curMethod = method;
    let curBody = body;
    for (let hop = 0; hop <= redirects; hop++) {
      const res = await this._raw(current, { method: curMethod, headers, body: curBody, timeout });
      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        if (curMethod !== 'GET' && res.status !== 307 && res.status !== 308) {
          curMethod = 'GET';
          curBody = null;
        }
        current = new URL(res.headers.location, current).toString();
        continue;
      }
      return res;
    }
    throw new HttpError('too many redirects', { url });
  }

  _raw(url, { method, headers, body, timeout }) {
    return new Promise((resolve, reject) => {
      let u;
      try {
        u = new URL(url);
      } catch (err) {
        reject(new HttpError(`invalid URL: ${url}`));
        return;
      }
      const isHttps = u.protocol === 'https:';
      const port = u.port ? Number(u.port) : isHttps ? 443 : 80;
      const reqPath = (u.pathname || '/') + (u.search || '');

      const reqHeaders = { ...headers, Host: u.host, 'Accept-Encoding': 'identity' };
      const payload = body == null ? null : Buffer.from(body);
      if (payload) reqHeaders['Content-Length'] = String(payload.length);

      const opts = {
        hostname: u.hostname,
        port,
        path: reqPath,
        method,
        headers: reqHeaders,
        timeout,
      };
      if (this.insecure) opts.rejectUnauthorized = false;

      if (this.proxy?.isSocks) {
        opts.agent = socksAgent(this.proxy, isHttps, this.insecure, timeout);
      } else if (this.proxy && isHttps) {
        opts.agent = tunnelAgent(this.proxy, this.insecure, timeout);
      } else if (this.proxy && !isHttps) {
        // plain http through proxy: absolute-form request to the proxy itself
        opts.hostname = this.proxy.host;
        opts.port = this.proxy.port;
        opts.path = url;
        const auth = proxyAuthHeader(this.proxy);
        if (auth) reqHeaders['Proxy-Authorization'] = auth;
      }

      const lib = isHttps ? https : http;
      const req = lib.request(opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: buf,
            text: buf.toString('utf8'),
          });
        });
      });
      req.on('timeout', () => req.destroy(new HttpError(`request timeout after ${timeout}ms`, { url })));
      req.on('error', (err) => {
        if (err instanceof HttpError) {
          reject(err);
          return;
        }
        const he = new HttpError(err.message, { url, code: err.code });
        reject(he);
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  // Convenience: parse JSON body, never throws on non-2xx.
  // Returns { status, data, text, headers }.
  async json(url, opts = {}) {
    const res = await this.request(url, opts);
    const text = res.text;
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { status: res.status, data, text, headers: res.headers };
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
