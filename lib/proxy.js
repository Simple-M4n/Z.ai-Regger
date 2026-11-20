// Proxy configuration shared by the Node HTTP transport and Playwright.
//
// Supported types: http, https, socks4, socks4a, socks5, socks5h.
// The config value can be either a URL string ("socks5://user:pass@host:1080")
// or an object ({ type, host, port, username, password }). Both are normalized
// to a canonical URL string so every consumer gets the scheme explicitly.

const OFF = new Set(['', 'none', 'off', 'null', 'direct', 'no']);

const TYPE_ALIASES = {
  http: 'http',
  https: 'https',
  socks: 'socks5',
  socks5: 'socks5',
  socks5h: 'socks5h',
  socks4: 'socks4',
  socks4a: 'socks4a',
};

export const PROXY_TYPES = Object.values(TYPE_ALIASES).filter((v, i, a) => a.indexOf(v) === i);
export const SOCKS_TYPES = new Set(['socks4', 'socks4a', 'socks5', 'socks5h']);

const DEFAULT_PORTS = { http: 80, https: 443, socks4: 1080, socks4a: 1080, socks5: 1080, socks5h: 1080 };

export function normalizeProxyType(value) {
  if (value == null || value === '') return null;
  const key = String(value).toLowerCase().replace(/^socks5h?$/, (m) => m).replace(/[\s:_/-]/g, '');
  const type = TYPE_ALIASES[key] || TYPE_ALIASES[String(value).toLowerCase().trim()];
  if (!type) throw new Error(`unsupported proxy type: ${value} (use ${PROXY_TYPES.join(', ')})`);
  return type;
}

function decode(value) {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// Returns a canonical proxy URL string, or null when proxying is disabled.
// `defaultType` is used for bare "host:port" values (and can be overridden by
// --proxy-type in the CLI).
export function normalizeProxy(value, defaultType = null) {
  if (value == null) return null;
  if (typeof value === 'string' && OFF.has(value.trim().toLowerCase())) return null;
  if (typeof value !== 'string' && typeof value !== 'object') throw new Error('proxy must be a URL string or an object');

  let type;
  let host;
  let port;
  let username = '';
  let password = '';

  if (typeof value === 'object') {
    type = normalizeProxyType(value.type || defaultType || 'http');
    host = value.host || value.hostname;
    port = value.port;
    username = value.username || value.user || '';
    password = value.password || value.pass || '';
  } else {
    const text = value.trim();
    const match = text.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (match) {
      let parsed;
      try {
        parsed = new URL(text);
      } catch {
        throw new Error(`invalid proxy URL: ${text}`);
      }
      type = normalizeProxyType(parsed.protocol.slice(0, -1));
      host = parsed.hostname;
      port = parsed.port || DEFAULT_PORTS[type];
      username = decode(parsed.username);
      password = decode(parsed.password);
    } else {
      type = normalizeProxyType(defaultType || 'http');
      const bare = text.match(/^\[([^\]]+)\]:(\d+)$/) || text.match(/^([^:/]+):(\d+)$/);
      if (!bare) throw new Error(`invalid proxy address: ${text} (use type://host:port)`);
      host = bare[1];
      port = bare[2];
    }
  }

  if (!host) throw new Error('proxy is missing a host');
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(`invalid proxy port: ${port}`);
  }

  const auth = username ? `${encode(username)}${password ? `:${encode(password)}` : ''}@` : '';
  return `${type}://${auth}${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${portNum}`;
}

export function proxyInfo(value, defaultType = null) {
  const url = normalizeProxy(value, defaultType);
  if (!url) return null;
  const parsed = new URL(url);
  const type = parsed.protocol.slice(0, -1);
  return {
    url,
    type,
    host: parsed.hostname.replace(/^\[|\]$/g, ''),
    port: Number(parsed.port || DEFAULT_PORTS[type]),
    username: decode(parsed.username),
    password: decode(parsed.password),
    isSocks: SOCKS_TYPES.has(type),
    remoteDns: type === 'socks5h' || type === 'socks4a',
  };
}

// Credentials are kept out of logs and TUI output.
export function describeProxy(value) {
  const info = proxyInfo(value);
  if (!info) return 'none';
  return `${info.type}://${info.host}:${info.port}${info.username ? ' (auth)' : ''}`;
}

export function proxyForPlaywright(value, bypass = null) {
  const info = proxyInfo(value);
  if (!info) return undefined;
  const result = { server: `${info.type}://${info.host}:${info.port}` };
  if (info.username) result.username = info.username;
  if (info.password) result.password = info.password;
  if (bypass) result.bypass = String(bypass);
  return result;
}
