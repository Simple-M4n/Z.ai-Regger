// Configuration and account storage for zai-regger.
// All paths are derived at runtime from the module location and the current
// user's environment. Nothing in this repository is tied to a specific machine.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProxy, normalizeProxyType } from './proxy.js';

export const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const envPath = (name) => (process.env[name] ? path.resolve(process.env[name]) : null);

export const CONFIG_FILE = envPath('ZAI_REGGER_CONFIG') || path.join(ROOT_DIR, 'config.json');

const APPDATA_DIR =
  process.env.APPDATA ||
  (process.platform === 'darwin'
    ? path.join(process.env.HOME || '', 'Library', 'Application Support')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || '', '.config')));

export const APP_DATA_DIR = path.join(APPDATA_DIR, 'Z.ai-Regger');

// Real accounts are written outside the repository by default. Override with
// ZAI_REGGER_ACCOUNTS or --out if you need a different file.
export const ACCOUNTS_FILE = envPath('ZAI_REGGER_ACCOUNTS') || path.join(APP_DATA_DIR, 'accounts.json');

export const DEFAULT_CONFIG = {
  // Target platform label recorded on every registered account. Both modes
  // use the same Z.AI signup flow at chat.z.ai.
  mode: 'ZChat',
  headless: true, // false = visible browser window
  proxy: null, // canonical type://[user:pass@]host:port, or null
  proxyType: null, // default type for a bare host:port proxy
  proxyFile: null, // file with a proxy list, rotated per account
  proxyBypass: null, // comma-separated hosts bypassing the proxy (browser only)
  browser: null, // null = autodetect | chrome | msedge | chromium
  provider: 'tempmail', // mail provider used by the registrar
  captcha: 'auto', // auto | browser | param | none
  autoAttempts: 10,
  interval: 65,
  insecure: false,
  verbose: false,
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
  cfg.browser = cfg.browser ? String(cfg.browser).toLowerCase() : null;
  cfg.captcha = ['auto', 'browser', 'param', 'none'].includes(String(cfg.captcha).toLowerCase())
    ? String(cfg.captcha).toLowerCase()
    : 'auto';
  cfg.proxyType = normalizeProxyType(cfg.proxyType);
  cfg.proxyFile = cfg.proxyFile ? String(cfg.proxyFile) : null;
  cfg.proxyBypass = cfg.proxyBypass ? String(cfg.proxyBypass) : null;
  cfg.proxy = normalizeProxy(cfg.proxy, cfg.proxyType);
  return cfg;
}

export function loadConfig(file = CONFIG_FILE) {
  return normalizeConfig(readJson(file, {}) || {});
}
