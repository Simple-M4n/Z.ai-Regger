// HTTP transport built on node:http/https with optional HTTP(S) proxy support.
// No external dependencies: all requests in the tool go through this module.

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

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
  /request timeout after/i,
];
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']);

export function isRetryableConnectError(err) {
  if (!err) return false;
  if (err.code && RETRYABLE_CODES.has(err.code)) return true;
  const msg = String(err.message || '');
  return RETRYABLE_MESSAGES.some((re) => re.test(msg));
}

function proxyAuthHeader(proxyUrl) {
  if (proxyUrl.username || proxyUrl.password) {
    const cred = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
    return `Basic ${Buffer.from(cred).toString('base64')}`;
  }
  return null;
}

// Open a CONNECT tunnel through an HTTP proxy to host:port.
function connectTunnel(proxyUrl, host, port, timeout) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:${port}` };
    const auth = proxyAuthHeader(proxyUrl);
    if (auth) headers['Proxy-Authorization'] = auth;

    const req = http.request({
      host: proxyUrl.hostname,
      port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      timeout,
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
function tunnelAgent(proxyUrl, insecure, timeout) {
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (opts, cb) => {
    const host = opts.hostname || opts.host;
    const port = opts.port || 443;
    const servername = opts.servername || host;
    connectTunnel(proxyUrl, host, port, timeout)
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

export class Transport {
  constructor({ proxy = null, timeout = 30000, insecure = false, onRetry = null } = {}) {
    this.proxy = proxy ? new URL(proxy) : null;
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

      if (this.proxy && isHttps) {
        opts.agent = tunnelAgent(this.proxy, this.insecure, timeout);
      } else if (this.proxy && !isHttps) {
        // plain http through proxy: absolute-form request to the proxy itself
        opts.hostname = this.proxy.hostname;
        opts.port = this.proxy.port || 80;
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
