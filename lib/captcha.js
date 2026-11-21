// Aliyun slider captcha handling for chat.z.ai signup.
//
// The site requires an Aliyun noCaptcha token (`captcha_verify_param`) on
// POST /api/v1/auths/signup. This module drives a real browser: it autofills
// the form, triggers the slider, waits for the operator to solve it, and
// captures either the browser's own successful signup response or the raw
// captcha token (for replay through the API client).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { BASE, UA } from './zai.js';
import { solveSliderAuto, passedSignal } from './slider.js';
import { proxyForPlaywright } from './proxy.js';

// Injected before any page script: records captcha_verify_param from any
// outgoing signup/signin request body and presents a consistent browser
// fingerprint. Playwright's default headless flags are a strong bot signal
// for Aliyun, so mask them in addition to `navigator.webdriver`.
const HOOK_JS = `
window.__captchaParam = null;
try {
  Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } });
  Object.defineProperty(navigator, 'languages', { get: function () { return ['en-US', 'en']; } });
  Object.defineProperty(navigator, 'language', { get: function () { return 'en-US'; } });
  Object.defineProperty(navigator, 'platform', { get: function () { return 'Win32'; } });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: function () { return 8; } });
  Object.defineProperty(navigator, 'deviceMemory', { get: function () { return 8; } });
  if (!window.chrome) window.chrome = {};
  window.chrome.runtime = window.chrome.runtime || {};
  Object.defineProperty(navigator, 'userAgentData', {
    get: function () {
      return {
        brands: [
          { brand: 'Chromium', version: '125' },
          { brand: 'Google Chrome', version: '125' },
          { brand: 'Not?A_Brand', version: '8' }
        ],
        mobile: false,
        platform: 'Windows',
        getHighEntropyValues: function () { return Promise.resolve({}); }
      };
    }
  });
  var _origQuery = navigator.permissions.query.bind(navigator.permissions);
  navigator.permissions.query = function (p) {
    if (p && p.name === 'notifications') return Promise.resolve({ state: Notification.permission });
    return _origQuery(p);
  };
} catch (e) {}
var _origSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send = function (body) {
  try {
    if (typeof body === 'string') {
      try {
        var parsed = JSON.parse(body);
        if (parsed && parsed.captcha_verify_param) {
          window.__captchaParam = parsed.captcha_verify_param;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return _origSend.apply(this, arguments);
};
`;

// Discover an installed Chromium browser from environment variables, standard
// per-OS locations and PATH. No user-specific or machine-specific path is
// stored in the repository.
export function resolveBrowserChannel() {
  const pf = process.env.ProgramFiles;
  const pf86 = process.env['ProgramFiles(x86)'];
  const local = process.env.LOCALAPPDATA;
  const home = process.env.HOME || process.env.USERPROFILE;
  const join = (base, ...parts) => (base ? path.join(base, ...parts) : null);

  const candidates = [
    ['chrome', join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', '/usr/bin/google-chrome'],
    ['chrome', '/usr/bin/chromium'],
    ['chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    ['msedge', join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['msedge', join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['msedge', join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['msedge', '/usr/bin/microsoft-edge'],
    ['msedge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  ];

  for (const [channel, file] of candidates) {
    if (file && existsSync(file)) return channel;
  }
  return null;
}

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    throw new Error('playwright-core not installed — run: npm install');
  }
}

async function captchaPassed(page) {
  return passedSignal(page);
}

async function captchaVisible(page) {
  for (const frame of page.frames()) {
    try {
      const n = await frame
        .locator('#aliyunCaptcha-window-float:visible, #aliyunCaptcha-sliding-slider:visible')
        .count();
      if (n > 0) return true;
    } catch {
      /* frame may be gone */
    }
  }
  return false;
}

async function triggerCaptcha(page, log) {
  const selectors = [
    '#captcha-element',
    '.captcha-element',
    '#aliyunCaptcha-start-icon',
    '.aliyunCaptcha-start-icon',
    '#aliyunCaptcha-captcha-body',
    '.aliyunCaptcha-captcha-body',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel);
      if ((await el.count()) > 0 && (await el.first().isVisible())) {
        await el.first().click({ timeout: 3000 });
        log(`  [captcha] trigger clicked: ${sel}`);
        await page.waitForTimeout(2000);
        return true;
      }
    } catch {
      /* try next selector */
    }
  }
  log('  [captcha] trigger not found — click the captcha widget manually if it does not appear');
  return false;
}

async function fillForm(page, { name, email, password }, log) {
  try {
    const el = await page.waitForSelector(
      'input[name="name"], input[placeholder*="name" i], input[placeholder*="名称"]',
      { timeout: 5000 }
    );
    await el.fill(name);
    log(`  [form] name: ${name}`);
  } catch {
    const inputs = await page.$$("input[type='text'], input:not([type])");
    if (inputs[0]) await inputs[0].fill(name);
  }

  try {
    const el = await page.waitForSelector(
      'input[type="email"], input[name="email"], input[placeholder*="email" i], input[placeholder*="邮箱"]',
      { timeout: 5000 }
    );
    await el.fill(email);
    log(`  [form] email: ${email}`);
  } catch {
    const inputs = await page.$$("input[type='text'], input:not([type])");
    const target = inputs[1] || inputs[0];
    if (target) await target.fill(email);
  }

  try {
    const el = await page.waitForSelector('input[type="password"]', { timeout: 5000 });
    await el.fill(password);
    log('  [form] password filled');
  } catch {
    log('  [form] password field not found');
  }
}

async function clickSubmit(page, log) {
  const selectors = [
    'button[type="submit"]',
    'button:has-text("Sign up")',
    'button:has-text("注册")',
    'button:has-text("Create")',
    'button:has-text("创建")',
    'button:has-text("Sign in")',
    'button:has-text("登录")',
  ];
  for (const sel of selectors) {
    try {
      const btn = page.locator(sel);
      if ((await btn.count()) > 0 && (await btn.first().isVisible())) {
        await btn.first().click({ timeout: 3000 });
        log(`  [form] submit clicked: ${sel}`);
        return true;
      }
    } catch {
      /* try next selector */
    }
  }
  log('  [form] submit button not found — click it manually');
  return false;
}

/**
 * Open the signup page, autofill, wait for the operator to solve the slider.
 * Returns { signupResponse, captchaParam, signupError } — the caller prefers
 * signupResponse, falls back to replaying signup with captchaParam.
 */
export async function solveSignupCaptcha({
  email,
  password,
  name,
  proxy = null,
  proxyBypass = null,
  channel = null,
  headless = false,
  timeoutMs = 300000,
  mode = 'auto',
  autoAttempts = 10,
  insecure = false,
  onRetry = null,
  log = console.log,
}) {
  const pw = await loadPlaywright();
  const ch = channel || resolveBrowserChannel();
  if (!ch) throw new Error('No Chrome/Edge found — pass --browser chrome or --browser msedge');

  const result = { signupResponse: null, captchaParam: null, signupError: null };
  const browser = await pw.chromium.launch({
    headless,
    channel: ch,
    proxy: proxyForPlaywright(proxy, proxyBypass),
    // Playwright adds --enable-automation by default; Aliyun's WAF reads it.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--disable-features=AutomationControlled'],
  });

  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'light',
    });
    const page = await ctx.newPage();
    await page.addInitScript(HOOK_JS);

    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (!/\/api\/v1\/auths\/signup/.test(url) || resp.request().method() !== 'POST') return;

        const pd = resp.request().postData();
        if (pd) {
          try {
            const body = JSON.parse(pd);
            if (body && body.captcha_verify_param) {
              result.captchaParam = body.captcha_verify_param;
              log(`  [captcha] token captured from request (len=${result.captchaParam.length})`);
            }
          } catch {
            /* not json */
          }
        }

        let bodyText = '';
        try {
          bodyText = await resp.text();
        } catch {
          /* empty body */
        }
        const hadToken = !!(pd && (() => {
          try {
            return !!JSON.parse(pd).captcha_verify_param;
          } catch {
            return false;
          }
        })());

        if (resp.status() >= 200 && resp.status() < 300) {
          try {
            result.signupResponse = JSON.parse(bodyText);
            log('  [signup] browser signup response captured');
          } catch {
            /* empty body */
          }
        } else {
          log(`  [signup] HTTP ${resp.status()} token=${hadToken ? 'yes' : 'no'} ${bodyText.slice(0, 240)}`);
          if (hadToken && !result.signupResponse) {
            // a failure AFTER the captcha token was attached is a real
            // rejection (rate limit, email taken, captcha rejected, ...)
            try {
              result.signupError = { status: resp.status(), data: JSON.parse(bodyText || 'null') };
            } catch {
              result.signupError = { status: resp.status(), data: null };
            }
          }
        }
      } catch {
        /* listener must never throw */
      }
    });

    log(`  [browser] opening ${BASE}/auth?action=signup (${ch}${headless ? ', headless' : ''})`);
    await page.goto(`${BASE}/auth?action=signup`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    await page.bringToFront().catch(() => {});

    await fillForm(page, { name, email, password }, log);
    await page.waitForTimeout(800);
    await clickSubmit(page, log);
    await page.waitForTimeout(2000);

    // sticky: once the slider is known to be solved, keep re-submitting even
    // if the success text disappears before the signup request goes out
    let captchaSolved = false;
    const start = Date.now();
    let nextTrigger = start + 10000;
    let nextSubmit = start;
    let triggerAttempts = 0;
    let hookCheck = start;

    if (!result.signupResponse && !(await captchaVisible(page))) {
      await triggerCaptcha(page, log);
    }

    if (mode === 'auto' && !result.signupResponse) {
      log(`  [auto] auto-solving the slider (up to ${autoAttempts} attempts)`);
      const autoOutcome = await solveSliderAuto({
        page,
        proxy,
        insecure,
        onRetry,
        referer: `${BASE}/auth`,
        attempts: autoAttempts,
        log,
        // A captured captcha_verify_param is a real pass signal too: the
        // browser hook records it from the signup request before the response
        // arrives. Relying only on signupResponse made the solver finish on a
        // cosmetic widget close while no token existed.
        isSolved: () => !!result.signupResponse || !!result.captchaParam,
      });
      if (autoOutcome === 'passed') {
        log('  [auto] slider passed — waiting for the signup request');
        captchaSolved = true;
        // the page may fire signup itself once the token arrives; press
        // Create Account only if nothing went out, and never double-send
        const ownSubmitDeadline = Date.now() + 4000;
        while (
          Date.now() < ownSubmitDeadline &&
          !result.signupResponse &&
          !result.captchaParam &&
          !result.signupError
        ) {
          await page.waitForTimeout(300);
        }
        if (!result.signupResponse && !result.captchaParam && !result.signupError) {
          await clickSubmit(page, log);
        }
        nextSubmit = Date.now() + 8000;
      } else if (headless) {
        log(`  [auto] ${autoOutcome} — headless run, no window to fall back to; retrying is up to the caller`);
      } else {
        log(`  [auto] ${autoOutcome} — finish the slider manually in the browser window`);
      }
    } else if (mode !== 'auto') {
      log(
        `  [captcha] solve the slider in the browser window (waiting up to ${Math.round(timeoutMs / 1000)}s)`
      );
    }

    while (Date.now() - start < timeoutMs) {
      if (result.signupResponse) break;
      if (result.captchaParam && result.signupError) break;
      if (page.isClosed() || !browser.isConnected()) throw new Error('browser closed during captcha');
      if (!page.url().includes('/auth')) throw new Error('page left /auth during captcha — retry this account');

      // fallback: read the token from the in-page hook
      if (!result.captchaParam && Date.now() - hookCheck > 1500) {
        hookCheck = Date.now();
        try {
          const hooked = await page.evaluate(() => window.__captchaParam);
          if (hooked) {
            result.captchaParam = hooked;
            log(`  [captcha] token captured from page hook (len=${hooked.length})`);
          }
        } catch {
          /* page navigating */
        }
      }

      const now = Date.now();
      if (await captchaPassed(page)) captchaSolved = true;
      if (captchaSolved) {
        if (now >= nextSubmit) {
          await clickSubmit(page, log);
          nextSubmit = now + 8000;
        }
      } else if (now >= nextTrigger && !(await captchaVisible(page)) && !result.captchaParam) {
        if (triggerAttempts < 3) {
          await page.bringToFront().catch(() => {});
          await triggerCaptcha(page, log);
          triggerAttempts += 1;
          nextTrigger = now + 15000;
        }
      }

      // token captured, browser did not auto-submit — give it a moment, then
      // return so the caller can replay signup over the API.
      if (result.captchaParam && !result.signupResponse && !result.signupError && now - start > 5000) {
        const waitedForAuto = 8000;
        const deadline = now + waitedForAuto;
        while (Date.now() < deadline && !result.signupResponse && !result.signupError) {
          await page.waitForTimeout(500);
        }
        break;
      }

      await page.waitForTimeout(500);
    }

    if (!result.signupResponse && !result.captchaParam && !result.signupError) {
      throw new Error(`captcha not solved within ${Math.round(timeoutMs / 1000)}s`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  return result;
}

/**
 * Fallback activation: open the mail's verification link in a browser, fill
 * the password fields, press "finish signup", capture the response JWT.
 */
export async function finishSignupBrowser({
  verifyUrl,
  password,
  proxy = null,
  proxyBypass = null,
  channel = null,
  headless = false,
  timeoutMs = 90000,
  log = console.log,
}) {
  const pw = await loadPlaywright();
  const ch = channel || resolveBrowserChannel();
  if (!ch) throw new Error('No Chrome/Edge found — pass --browser chrome or --browser msedge');

  const browser = await pw.chromium.launch({
    headless,
    channel: ch,
    proxy: proxyForPlaywright(proxy, proxyBypass),
    // Playwright adds --enable-automation by default; Aliyun's WAF reads it.
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--disable-features=AutomationControlled'],
  });

  try {
    const ctx = await browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      colorScheme: 'light',
    });
    const page = await ctx.newPage();
    let captured = null;

    page.on('response', async (resp) => {
      try {
        if (/\/api\/v1\/auths\/finish_signup/.test(resp.url()) && resp.request().method() === 'POST') {
          if (resp.status() >= 200 && resp.status() < 300) {
            captured = await resp.json();
            log('  [finish] browser finish_signup response captured');
          }
        }
      } catch {
        /* ignore */
      }
    });

    log('  [browser] opening verification link...');
    await page.goto(verifyUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const pwInputs = await page.$$('input[type="password"]');
    if (pwInputs.length >= 2) {
      await pwInputs[0].fill(password);
      await pwInputs[1].fill(password);
      log('  [form] password + confirmation filled');
    } else {
      for (const inp of pwInputs) await inp.fill(password);
      log(`  [form] filled ${pwInputs.length} password field(s)`);
    }
    await page.waitForTimeout(800);

    const clicked = await clickSubmit(page, log);
    if (!clicked) log('  [form] finish button not found — click it manually');

    const deadline = Date.now() + timeoutMs;
    while (!captured && Date.now() < deadline) {
      await page.waitForTimeout(500);
    }
    return captured;
  } finally {
    await browser.close().catch(() => {});
  }
}
