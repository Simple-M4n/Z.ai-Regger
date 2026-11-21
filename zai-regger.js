#!/usr/bin/env node
// zai-regger — automated Z.AI account registration.
// The only control surface is config.json plus CLI flags. There is no
// interactive shell, chat client or slash-command mode.
//
// Flow per account:
//   1. create/choose a mailbox            (mailtm | tempmail | guerrilla | cfmail | manual)
//   2. signup with Aliyun slider captcha  (browser solve | pre-solved param | none)
//   3. poll the mailbox for the verification mail, extract the link/token
//   4. verify_email + finish_signup       -> JWT
//   5. persist the account to the output file

import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

import { loadConfig, ACCOUNTS_FILE } from './lib/store.js';
import { ZaiClient, extractJwt, classifyFailure, BASE } from './lib/zai.js';
import { solveSignupCaptcha, finishSignupBrowser, resolveBrowserChannel } from './lib/captcha.js';
import { buildProvider, extractVerify, randStr, randPassword } from './lib/mail.js';
import { Transport, sleep } from './lib/http.js';
import { normalizeProxy, normalizeProxyType, proxyForPlaywright, describeProxy } from './lib/proxy.js';

const USAGE = `
zai-regger — automated registration for ${BASE}

Usage: node zai-regger.js [options]

Every setting can be set in config.json; CLI flags override the JSON file for
that run. The tool only registers accounts — there is no chat or interactive
command mode.

Config:
  --config FILE            alternative config.json path (env: ZAI_REGGER_CONFIG)

Account / batch:
  --mode NAME              ZChat | ZCode (default from config.json)
  --count N                accounts to register (default 1)
  --provider K             mailtm | tempmail | guerrilla | cfmail | manual
  --email ADDR             explicit email (single account / manual mode)
  --password PW            password (default: random per account)
  --name NAME              username (default: email local part)
  --out FILE               output file (default accounts.json)
  --interval SEC           pause between accounts (default 65)

Captcha:
  --captcha MODE           auto | browser | param | none (default auto)
                           auto:    background Chrome/Edge solves the slider
                           browser: visible window, you solve the slider
                           param:   reuse a pre-solved captcha_verify_param
  --auto-attempts N        auto-solver tries per account (default 10)
  --captcha-file FILE      file with captcha_verify_param for --captcha param
  --captcha-timeout SEC    max wait for slider (default 300)

Mailbox:
  --email-timeout SEC      wait for verification mail (default 180)
  --no-wait-email          stop after signup, skip verification
  --mail-base URL          cfmail: instance base URL
  --mail-pass PASS         cfmail: site password
  --mail-domain DOM        cfmail: address domain

Network / browser:
  --proxy URL              http(s)://[user:pass@]host:port or
                           socks4:// / socks4a:// / socks5:// / socks5h://
  --proxy-type TYPE        http | https | socks4 | socks4a | socks5 | socks5h
                           (used when --proxy is a bare host:port)
  --proxy-bypass LIST      comma-separated hosts bypassing the proxy (browser)
  --insecure               skip TLS certificate verification
  --browser CHANNEL        chrome | msedge | chromium (default: autodetect)
  --headed                 visible browser window instead of headless

Misc:
  --selftest               connectivity + mailbox smoke test, no registration
  -h, --help               this help
`;

function fail(msg) {
  console.error(`error: ${msg}`);
  process.exit(2);
}

function parseCli() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        config: { type: 'string' },
        mode: { type: 'string' },
        count: { type: 'string' },
        provider: { type: 'string' },
        email: { type: 'string' },
        password: { type: 'string' },
        name: { type: 'string' },
        out: { type: 'string' },
        interval: { type: 'string' },
        captcha: { type: 'string' },
        'auto-attempts': { type: 'string' },
        'captcha-file': { type: 'string' },
        'captcha-timeout': { type: 'string' },
        'email-timeout': { type: 'string' },
        'no-wait-email': { type: 'boolean' },
        'mail-base': { type: 'string' },
        'mail-pass': { type: 'string' },
        'mail-domain': { type: 'string' },
        proxy: { type: 'string' },
        'proxy-type': { type: 'string' },
        'proxy-bypass': { type: 'string' },
        insecure: { type: 'boolean' },
        browser: { type: 'string' },
        headed: { type: 'boolean' },
        headless: { type: 'boolean' },
        selftest: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (err) {
    console.error(String(err.message || err));
    console.error(USAGE);
    process.exit(2);
  }

  const opt = parsed.values;
  if (opt.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const defaults = loadConfig(opt.config ? path.resolve(opt.config) : undefined);
  const pick = (key, fallback) => (opt[key] !== undefined ? opt[key] : fallback);

  const modeKey = String(pick('mode', defaults.mode || 'ZChat')).toLowerCase().replace(/[^a-z]/g, '');
  if (!['zchat', 'zcode'].includes(modeKey)) fail('--mode must be ZChat | ZCode');
  const mode = modeKey === 'zcode' ? 'ZCode' : 'ZChat';

  const count = Number.parseInt(pick('count', '1'), 10);
  if (!Number.isInteger(count) || count < 1) fail('--count must be a positive integer');
  const interval = Number.parseInt(pick('interval', String(defaults.interval ?? 65)), 10);
  if (!Number.isInteger(interval) || interval < 0) fail('--interval must be a non-negative integer');

  const captcha = pick('captcha', defaults.captcha || 'auto');
  if (!['auto', 'browser', 'param', 'none'].includes(captcha)) fail('--captcha must be auto | browser | param | none');
  const provider = pick('provider', defaults.provider || 'tempmail');
  if (!['mailtm', 'tempmail', 'guerrilla', 'cfmail', 'manual'].includes(provider)) {
    fail('--provider must be mailtm | tempmail | guerrilla | cfmail | manual');
  }
  const autoAttempts = Number.parseInt(pick('auto-attempts', String(defaults.autoAttempts ?? 10)), 10);
  if (!Number.isInteger(autoAttempts) || autoAttempts < 1) fail('--auto-attempts must be a positive integer');

  const captchaFile = pick('captcha-file', null);
  if (captcha === 'param' && !captchaFile && count > 1) {
    fail('--captcha param with --count > 1 needs --captcha-file (one fresh token per account)');
  }

  let proxyType;
  let proxy;
  try {
    proxyType = opt['proxy-type'] ? normalizeProxyType(opt['proxy-type']) : defaults.proxyType || null;
    proxy = normalizeProxy(pick('proxy', defaults.proxy ?? null), proxyType);
  } catch (err) {
    fail(err.message);
  }

  const headless = opt.headed ? false : opt.headless ? true : defaults.headless !== false;
  return {
    mode,
    proxyType,
    proxyBypass: pick('proxy-bypass', defaults.proxyBypass || null),
    proxy,
    count,
    provider,
    email: opt.email || null,
    password: opt.password || null,
    name: opt.name || null,
    out: path.resolve(pick('out', ACCOUNTS_FILE)),
    interval,
    captcha,
    autoAttempts,
    captchaFile,
    captchaTimeout: Number.parseInt(pick('captcha-timeout', '300'), 10) * 1000,
    emailTimeout: Number.parseInt(pick('email-timeout', '180'), 10) * 1000,
    noWaitEmail: !!opt['no-wait-email'],
    mailBase: opt['mail-base'] || null,
    mailPass: opt['mail-pass'] || null,
    mailDomain: opt['mail-domain'] || null,
    insecure: opt.insecure !== undefined ? !!opt.insecure : !!defaults.insecure,
    browser: opt.browser || defaults.browser || null,
    headless,
    selftest: !!opt.selftest,
  };
}

const ts = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`[${ts()}] ${msg}`);

// Transport-level retry notification (connect-phase failures only).
const onRetry = (url, err, attempt, backoff) =>
  log(`    [retry ${attempt}] ${err.code || 'net'} ${String(err.message).slice(0, 90)} — waiting ${backoff}ms (${url.replace(/^https?:\/\//, '').slice(0, 60)})`);

// ── selftest: connectivity + mailbox, no registration ───────────

async function selftest(cfg) {
  let failures = 0;
  const check = (name, ok, detail) => {
    log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  const mail = new Transport({ proxy: cfg.proxy, timeout: 20000, insecure: cfg.insecure });
  const d = await mail.json('https://api.mail.tm/domains').catch((e) => ({ status: 0, text: e.message }));
  const domain = d.data?.['hydra:member']?.[0]?.domain || '';
  check('mail.tm reachable', d.status === 200 && !!domain, `HTTP ${d.status}, domain=${domain || 'n/a'}`);

  const zai = new ZaiClient({ ...cfg, onRetry });
  const c = await zai.config().catch((e) => ({ status: 0, text: e.message }));
  check('chat.z.ai reachable', c.status === 200, `HTTP ${c.status}`);

  if (cfg.provider !== 'manual') {
    const provider = buildProvider(cfg.provider, cfg);
    try {
      const inbox = await provider.createInbox();
      check(`mailbox via ${cfg.provider}`, !!inbox.address, inbox.address);
    } catch (err) {
      check(`mailbox via ${cfg.provider}`, false, err.message);
    }
  }

  const channel = cfg.browser || resolveBrowserChannel();
  check('browser available', !!channel, channel || 'none found (install Chrome/Edge or pass --browser)');
  if (channel) {
    try {
      const pw = await import('playwright-core');
      const launchOptions = {
        channel,
        headless: true,
        proxy: proxyForPlaywright(cfg.proxy, cfg.proxyBypass),
        args: ['--disable-blink-features=AutomationControlled'],
      };
      const b = await pw.chromium.launch(launchOptions);
      await b.close();
      check('playwright-core launch', true, `channel=${channel}, proxy=${describeProxy(cfg.proxy)}`);
    } catch (err) {
      check('playwright-core launch', false, err.message.split('\n')[0]);
    }
  }

  log(failures === 0 ? 'selftest: all checks passed' : `selftest: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

// ── captcha param plumbing ──────────────────────────────────────

async function readCaptchaParam(cfg) {
  if (cfg.captchaFile) {
    const raw = fs.readFileSync(cfg.captchaFile, 'utf8').trim();
    try {
      const parsed = JSON.parse(raw);
      const param = parsed.captcha_verify_param || parsed.param || parsed.token;
      if (param) return String(param);
    } catch {
      /* plain text token */
    }
    if (raw) return raw;
    throw new Error(`captcha file ${cfg.captchaFile} is empty`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const param = (await rl.question('  [captcha] paste captcha_verify_param: ')).trim();
    if (!param) throw new Error('empty captcha_verify_param');
    return param;
  } finally {
    rl.close();
  }
}

// ── single registration ─────────────────────────────────────────

async function registerOne(cfg, provider, rec) {
  const zai = new ZaiClient({ ...cfg, onRetry });

  // 1. mailbox
  log(`[1] mailbox via ${provider.name}`);
  const inbox = await provider.createInbox();
  rec.email = inbox.address;

  const name = cfg.name || sanitizeName(inbox.address.split('@')[0]) || `user${randStr(6)}`;
  const password = cfg.password || randPassword();
  rec.name = name;
  rec.password = password;
  log(`    ${rec.email}  name=${name}`);

  // 2. captcha + signup
  let signupRes;
  if (cfg.captcha === 'auto' || cfg.captcha === 'browser') {
    log(
      cfg.captcha === 'auto'
        ? '[2] browser captcha — auto-solving the slider'
        : '[2] browser captcha — solve the slider manually in the opened window'
    );
    const solved = await solveSignupCaptcha({
      email: rec.email,
      password,
      name,
      proxy: cfg.proxy,
      proxyBypass: cfg.proxyBypass,
      channel: cfg.browser,
      headless: cfg.captcha === 'browser' ? false : cfg.headless,
      timeoutMs: cfg.captchaTimeout,
      mode: cfg.captcha,
      autoAttempts: cfg.autoAttempts,
      insecure: cfg.insecure,
      onRetry,
      log,
    });
    if (solved.signupResponse) {
      signupRes = { status: 200, data: solved.signupResponse, text: JSON.stringify(solved.signupResponse) };
    } else if (solved.signupError) {
      signupRes = { status: solved.signupError.status, data: solved.signupError.data, text: JSON.stringify(solved.signupError.data) };
    } else if (solved.captchaParam) {
      log('    replaying signup through the API with the captured token');
      signupRes = await zai.signup({ name, email: rec.email, password, captchaParam: solved.captchaParam });
    } else {
      throw new Error('captcha was not solved');
    }
  } else if (cfg.captcha === 'param') {
    log('[2] signup with pre-solved captcha param');
    const param = await readCaptchaParam(cfg);
    signupRes = await zai.signup({ name, email: rec.email, password, captchaParam: param });
  } else {
    log('[2] signup without captcha (mode: none)');
    signupRes = await zai.signup({ name, email: rec.email, password });
  }

  if (!signupRes || signupRes.status >= 400) {
    const f = classifyFailure(signupRes);
    const err = new Error(`signup: ${f.kind} — ${f.message}`);
    err.kind = f.kind;
    throw err;
  }
  rec.signup = signupRes.data;
  log(`    signup OK (HTTP ${signupRes.status})`);

  if (cfg.noWaitEmail) {
    rec.status = 'email_pending';
    log('[3] --no-wait-email: stopping before verification');
    return rec;
  }

  // 3. verification mail
  log(`[3] waiting for verification mail (up to ${cfg.emailTimeout / 1000}s)`);
  const mail = await provider.waitForVerifyMail(inbox, { timeout: cfg.emailTimeout, log });
  if (!mail) {
    rec.status = 'email_pending';
    throw new Error('verification mail timeout');
  }

  const v = extractVerify(mail.content);
  if (!v || !v.token) {
    rec.status = 'email_pending';
    throw new Error('verify link/token not found in the mail');
  }
  const username = v.username || name;
  const vemail = v.email || rec.email;
  log(`    token=${v.token.slice(0, 24)}...`);

  // 4. verify + finish -> JWT
  log('[4] verify_email + finish_signup');
  const r1 = await zai.verifyEmail({ username, email: vemail, token: v.token }).catch((e) => ({ status: 0, text: e.message }));
  log(`    verify_email: HTTP ${r1.status}${r1.status >= 400 ? ` ${String(r1.text).slice(0, 140)}` : ''}`);

  let fin = await zai.finishSignup({ username, email: vemail, token: v.token, password }).catch((e) => ({ status: 0, text: e.message }));
  let jwt = extractJwt(fin.data);
  log(`    finish_signup: HTTP ${fin.status}${jwt ? ' (jwt ok)' : ''}`);

  if (!jwt && v.url) {
    log('    API finish failed — falling back to browser activation');
    try {
      const bfin = await finishSignupBrowser({
        verifyUrl: v.url,
        password,
        proxy: cfg.proxy,
        proxyBypass: cfg.proxyBypass,
        channel: cfg.browser,
        headless: cfg.headless,
        log,
      });
      jwt = extractJwt(bfin);
      if (bfin) fin = { status: 200, data: bfin };
    } catch (err) {
      log(`    browser activation failed: ${err.message}`);
    }
  }

  if (!jwt && fin.status >= 200 && fin.status < 300) {
    log('    last resort: signin to obtain the token');
    const si = await zai.signin({ email: rec.email, password }).catch((e) => ({ status: 0, text: e.message }));
    jwt = extractJwt(si.data);
    if (!jwt && si.status >= 400) {
      const f = classifyFailure(si);
      log(`    signin: ${f.kind} — ${f.message} (account is registered; captcha may be required for signin)`);
    }
  }

  if (jwt) {
    rec.token = jwt;
    rec.status = 'complete';
    log(`    DONE  token=${jwt.slice(0, 28)}...`);
  } else {
    rec.status = 'verified_no_token';
    log('    account verified but no JWT captured — check the mailbox/account manually');
  }
  return rec;
}

function sanitizeName(local) {
  const cleaned = String(local || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  return cleaned.length >= 3 ? cleaned : null;
}

// ── output persistence ──────────────────────────────────────────

function loadResults(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveResults(file, results) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(results, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ── main ────────────────────────────────────────────────────────

async function main() {
  const cfg = parseCli();

  if (cfg.selftest) {
    await selftest(cfg);
    return;
  }

  const provider = buildProvider(cfg.provider, {
    proxy: cfg.proxy,
    insecure: cfg.insecure,
    onRetry,
    base: cfg.mailBase,
    sitePassword: cfg.mailPass,
    domain: cfg.mailDomain,
    email: cfg.email,
  });

  log(`zai-regger: ${cfg.count} account(s), mode=${cfg.mode}, provider=${cfg.provider}, captcha=${cfg.captcha}` +
      `, proxy=${describeProxy(cfg.proxy)}`);
  if ((cfg.captcha === 'auto' || cfg.captcha === 'browser') && !cfg.browser && !resolveBrowserChannel()) {
    fail('no Chrome/Edge found — pass --browser chrome|msedge or install a browser');
  }

  const results = loadResults(cfg.out);
  let ok = 0;

  for (let i = 1; i <= cfg.count; i++) {
    const rec = {
      index: results.length + 1,
      mode: cfg.mode,
      status: 'pending',
      created_at: new Date().toISOString(),
    };
    log(`──── account ${i}/${cfg.count} (${cfg.mode}) ────`);
    try {
      await registerOne(cfg, provider, rec);
      if (rec.status === 'complete') ok += 1;
    } catch (err) {
      rec.status = rec.status === 'pending' ? 'failed' : rec.status;
      rec.error = String(err.message || err);
      log(`FAILED: ${rec.error}`);
      if (err.kind === 'waf_block') {
        log('Aliyun WAF blocked this IP — stopping the batch to avoid a longer ban; retry later or use --proxy');
        break;
      }
    }
    results.push(rec);
    try {
      saveResults(cfg.out, results);
    } catch (err) {
      log(`could not write ${cfg.out}: ${err.message}`);
    }

    if (i < cfg.count) {
      log(`rate-limit pause ${cfg.interval}s before the next account...`);
      const until = Date.now() + cfg.interval * 1000;
      while (Date.now() < until) {
        const left = Math.ceil((until - Date.now()) / 1000);
        process.stdout.write(`\r[${ts()}] ${left}s left   `);
        await sleep(1000);
      }
      process.stdout.write('\n');
    }
  }

  const done = results.filter((r) => r.status === 'complete').length;
  log(`summary: ${done} complete in ${cfg.out} (this run: ${ok}/${cfg.count})`);
  process.exit(ok === cfg.count ? 0 : 1);
}

main().catch((err) => {
  console.error(`fatal: ${err.stack || err.message || err}`);
  process.exit(1);
});
