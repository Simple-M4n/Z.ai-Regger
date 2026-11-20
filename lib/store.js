// Configuration and account storage for zai-regger.
// All paths are derived at runtime from the module location and the current
// user's environment. Nothing in this repository is tied to a specific machine.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const envPath = (name) => (process.env[name] ? path.resolve(process.env[name]) : null);

export const CONFIG_FILE =
  envPath('ZAI_REGGER_CONFIG') || path.join(ROOT_DIR, 'config.json');

const APPDATA_DIR =
  process.env.APPDATA ||
  (process.platform === 'darwin'
    ? path.join(process.env.HOME || '', 'Library', 'Application Support')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config')));

export const APP_DATA_DIR = path.join(APPDATA_DIR, 'Z.ai-Regger');
const EXTERNAL_ACCOUNTS_FILE = path.join(APP_DATA_DIR, 'accounts.json');
const LOCAL_ACCOUNTS_FILE = path.join(ROOT_DIR, 'accounts.local.json');

// Real credentials never need to live in the repository. An accounts.json in
// the OS app-data directory is detected automatically; env vars win over it.
export const ACCOUNTS_FILE =
  envPath('ZAI_REGGER_ACCOUNTS') ||
  (fs.existsSync(EXTERNAL_ACCOUNTS_FILE) ? EXTERNAL_ACCOUNTS_FILE : path.join(ROOT_DIR, 'accounts.json'));

export const DEFAULT_WORKSPACE = path.join(APPDATA_DIR, 'Z.ai-Regger', 'Workspace');
export const STATE_FILE = path.join(APP_DATA_DIR, 'state.json');

export function loadState() {
  const value = readJson(STATE_FILE, {});
  return value && typeof value === 'object' ? value : {};
}

export function saveState(value) {
  writeJson(STATE_FILE, value);
}

export const MODES = ['ZChat', 'ZCode'];
export const MODEL_NAMES = {
  'x-preview-l': 'GLM-5.3-Flash',
  'glm-5.3': 'GLM-5.3',
  'glm-5.2': 'GLM-5.2',
};
export const MODEL_ALIASES = {
  'glm-5.3-flash': 'x-preview-l',
  glm53flash: 'x-preview-l',
  flash: 'x-preview-l',
};

export const DEFAULT_CONFIG = {
  // "ZChat" uses https://chat.z.ai, "ZCode" uses https://zcode.z.ai/login.
  mode: 'ZChat',
  accountId: null,

  model: 'x-preview-l',
  effort: 'max', // low | high | max
  headless: true, // false = open a visible browser window
  proxy: null, // null or "http(s)://[user:pass@]host:port"
  browser: null, // null = autodetect | chrome | msedge | chromium

  provider: 'tempmail', // mail provider used by regger
  captcha: 'auto', // auto | browser | param | none
  autoAttempts: 6,
  interval: 65,
  insecure: false,

  maxTranscript: 2000,
  // ZCode SSO entry point and the local web UI started by `zcode --web`.
  zcodeUrl: 'https://zcode.z.ai/login',
  zcodeLocalUrl: 'http://127.0.0.1:3030',
  loginTimeoutMs: 180000,
};

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export function normalizeConfig(input = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...(input || {}) };
  const rawMode = String(cfg.mode || '').toLowerCase().replace(/[^a-z]/g, '');
  cfg.mode = rawMode === 'zcode' ? 'ZCode' : 'ZChat';
  cfg.effort = ['low', 'high', 'max'].includes(String(cfg.effort).toLowerCase())
    ? String(cfg.effort).toLowerCase()
    : 'max';
  cfg.browser = cfg.browser ? String(cfg.browser).toLowerCase() : null;
  cfg.proxy = cfg.proxy ? String(cfg.proxy) : null;
  cfg.captcha = ['auto', 'browser', 'param', 'none'].includes(String(cfg.captcha).toLowerCase())
    ? String(cfg.captcha).toLowerCase()
    : 'auto';
  if (!cfg.zcodeUrl) cfg.zcodeUrl = DEFAULT_CONFIG.zcodeUrl;
  if (!cfg.zcodeLocalUrl) cfg.zcodeLocalUrl = DEFAULT_CONFIG.zcodeLocalUrl;
  return cfg;
}

export function loadConfig(file = CONFIG_FILE) {
  const cfg = normalizeConfig(readJson(file, {}) || {});
  const state = loadState();
  if (state.accountId) cfg.accountId = state.accountId;
  return cfg;
}

export function saveConfig(cfg, file = CONFIG_FILE) {
  const clean = { ...cfg };
  // Never write machine-specific values or account identifiers into the
  // publishable config file. The active account lives in app-data state.json.
  delete clean.workspace;
  clean.accountId = null;
  writeJson(file, clean);
  return clean;
}

// Workspace is derived from the OS. It can be overridden in config.json with a
// relative path, but the default never contains a user-specific absolute path.
export function getWorkspace(cfg = {}) {
  const value = cfg.workspace;
  if (!value) return DEFAULT_WORKSPACE;
  return path.isAbsolute(value) ? value : path.join(ROOT_DIR, value);
}

export function ensureWorkspace(cfg = {}) {
  const dir = getWorkspace(cfg);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}

// accounts.json is the committed, empty template. accounts.local.json is an
// optional git-ignored override for real local credentials.
export function loadAccounts() {
  const committed = readJson(ACCOUNTS_FILE, []);
  const local = readJson(LOCAL_ACCOUNTS_FILE, []);
  const all = [...(Array.isArray(committed) ? committed : []), ...(Array.isArray(local) ? local : [])];
  const byEmail = new Map();
  all.forEach((acc, i) => {
    if (!acc) return;
    const key = acc.email || `__${i}`;
    if (!byEmail.has(key)) byEmail.set(key, acc);
  });
  return [...byEmail.values()];
}

// Accept an email (exact, case-insensitive), a 1-based index, or "last".
export function findAccount(accounts, selector) {
  if (!selector) return null;
  const key = String(selector).toLowerCase().trim();
  if (key === 'last') {
    for (let i = accounts.length - 1; i >= 0; i--) {
      if (accounts[i].status === 'complete' && accounts[i].token) return accounts[i];
    }
    return null;
  }
  const num = Number.parseInt(key, 10);
  if (!Number.isNaN(num) && num >= 1 && num <= accounts.length) {
    return accounts[num - 1] || null;
  }
  return accounts.find((a) => String(a.email || '').toLowerCase() === key) || null;
}

export function usableAccounts(accounts) {
  return accounts.filter((a) => a && a.status === 'complete' && a.token);
}

// Decode the JWT payload (no verification — display only).
export function jwtInfo(token) {
  if (!token || typeof token !== 'string') return { valid: false, reason: 'no token' };
  const parts = token.split('.');
  if (parts.length < 2) return { valid: false, reason: 'not a JWT' };
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const exp = payload.exp ? Number(payload.exp) * 1000 : null;
    const expired = exp ? Date.now() > exp : false;
    return {
      valid: !expired,
      expired,
      id: payload.id || payload.sub || null,
      email: payload.email || null,
      expiresAt: exp ? new Date(exp).toISOString() : null,
    };
  } catch (err) {
    return { valid: false, reason: `decode failed: ${err.message}` };
  }
}

export function accountLabel(acc, index) {
  if (!acc) return '— none —';
  const info = jwtInfo(acc.token);
  const flag = info.valid ? 'OK' : info.expired ? 'JWT expired' : 'JWT ?';
  return `#${index != null ? index + 1 : acc.index || '?'} ${acc.email || '?'} [${flag}]`;
}
