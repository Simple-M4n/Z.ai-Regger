// ZCode driver.
//
// ZCode has no public browser workspace: https://zcode.z.ai is a login/marketing
// site, and the real agent UI runs locally (`zcode --web`, default port 3030).
// This driver therefore works in two stages:
//   1. complete the real Z.AI SSO at zcode.z.ai (email + password + slider +
//      OAuth consent), using the same browser context for both stages;
//   2. open the local ZCode web UI and drive its composer through the stable
//      data-testid attributes published by the ZCode source tree.

import { resolveBrowserChannel } from './captcha.js';
import { solveSliderAuto } from './slider.js';
import { jwtInfo } from './store.js';
import { UA } from './zai.js';

const HOOK_JS = `
try { Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } }); } catch (e) {}
`;

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:3030';

// Login buttons on the ZCode landing page (Chinese and English variants).
const ZAI_LOGIN_BUTTONS = [
  'button:has-text("Z.ai 账号登录")',
  'button:has-text("使用 Z.ai 账号登录")',
  'button:has-text("Sign in with Z.ai")',
  'button:has-text("Login with Z.ai")',
  'button:has-text("Continue with Z.ai")',
  'button:has-text("Z.ai Account")',
  '[data-testid="oauth-login-button"]',
];

const EMAIL_LOGIN_BUTTONS = [
  'button:has-text("Continue with Email"):visible',
  'button:has-text("Sign in with Email"):visible',
  'button:has-text("邮箱登录"):visible',
];

const SIGNIN_BUTTONS = [
  'button:has-text("Sign in"):visible',
  'button[type="submit"]:visible',
];

const CONTINUE_BUTTONS = [
  'button:has-text("Continue"):visible',
  'button:has-text("继续"):visible',
];

const LOCAL_LOGIN_SELECTORS = [
  '[data-testid="login-trigger"]:visible',
  '[data-testid="login-menu-item"]:visible',
  '[data-testid="oauth-login-button"]:visible',
  'button:has-text("Log in"):visible',
  'button:has-text("登录"):visible',
];

const NEW_TASK_SELECTORS = [
  '[data-testid="virtual-project-new-task"]:visible',
  '[data-testid="task-new-button"]:visible',
  'button:has-text("New Task"):visible',
  'button:has-text("新建任务"):visible',
];

// data-testid values are taken from packages/shared/src/test-ids.ts of ZCode.
const COMPOSER_SELECTORS = [
  '[data-testid="v4-composer-input"]',
  '[data-testid="chat-input"]',
  'textarea#chat-input',
  'textarea[placeholder*="Ask" i]',
  'textarea[placeholder*="message" i]',
  'textarea',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
  '.cm-content',
];

const SEND_SELECTORS = [
  '[data-testid="v4-composer-send"]:visible',
  '[data-testid="chat-send-button"]:visible',
  'button[aria-label*="Send" i]:visible',
  'button:has-text("Send"):visible',
  'button:has-text("发送"):visible',
];

// ── small locator helpers ───────────────────────────────────────────

// OAuth URLs contain the other host inside query parameters, so navigation
// state must be decided from hostname + pathname, never from the raw URL.
function currentRoute(page) {
  try {
    const parsed = new URL(page.url());
    return { host: parsed.hostname, path: parsed.pathname };
  } catch {
    return { host: '', path: '' };
  }
}

async function findVisible(page, selectors) {
  for (const selector of selectors) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0 && (await loc.isVisible({ timeout: 600 }))) return loc;
    } catch {
      /* selector may be invalid on this page; try the next one */
    }
  }
  return null;
}

async function clickVisible(page, selectors, log = () => {}) {
  const loc = await findVisible(page, selectors);
  if (!loc) return false;
  try {
    await loc.click({ timeout: 6000 });
    log(`  [zcode] clicked ${await loc.evaluate((e) => e.getAttribute('data-testid') || e.tagName)}`);
    return true;
  } catch {
    return false;
  }
}

// ── stage 1: Z.AI SSO ───────────────────────────────────────────────

async function loginViaZai(page, account, { loginTimeoutMs, log, onStatus }) {
  if (!account?.email || !account?.password) {
    throw new Error('ZCode login needs an account with an email and password');
  }
  const deadline = Date.now() + loginTimeoutMs;
  let lastUrl = '';
  let signInAttempts = 0;

  // The captcha widget can vanish during navigation, which the solver treats
  // as a pass. Only a real route change proves that sign-in succeeded.
  const ssoSolved = () => {
    const { host, path } = currentRoute(page);
    return /oauth\/authorize/.test(path) || (host === 'zcode.z.ai' && !/\/login/.test(path));
  };

  while (Date.now() < deadline) {
    const url = page.url();
    const { host, path } = currentRoute(page);
    if (url !== lastUrl) {
      log(`  [zcode] SSO page: ${url.slice(0, 150)}`);
      lastUrl = url;
    }

    if (host === 'zcode.z.ai' && /\/login(?:[/?]|$)/.test(path)) {
      onStatus('Opening Z.AI login…');
      const clicked = await clickVisible(page, ZAI_LOGIN_BUTTONS, log);
      if (!clicked) await page.waitForTimeout(1200);
      await page.waitForTimeout(1200);
      continue;
    }

    if (host === 'chat.z.ai' && /^\/auth(?:[/?]|$)/.test(path)) {
      // Sign-in form -------------------------------------------------
      if ((await page.locator('input[name="email"]:visible').count()) > 0) {
        onStatus('Signing in to Z.AI…');
        await page.locator('input[name="email"]').fill(account.email);
        await page.locator('input[name="current-password"]').fill(account.password);
        await clickVisible(page, SIGNIN_BUTTONS, log);
        signInAttempts += 1;
        await page.waitForTimeout(2500);

        onStatus('Solving login captcha…');
        const outcome = await solveSliderAuto({
          page,
          referer: 'https://chat.z.ai/',
          attempts: 6,
          log,
          isSolved: ssoSolved,
        });
        log(`  [zcode] login slider: ${outcome}`);

        // Resubmit only while still on the sign-in form. Clicking again after
        // the page has navigated triggers a fresh, unnecessary captcha.
        if (!ssoSolved() && signInAttempts < 3) {
          await clickVisible(page, SIGNIN_BUTTONS, log);
          await page.waitForTimeout(2000);
        }
        continue;
      }

      // OAuth consent ------------------------------------------------
      if (/oauth\/authorize/.test(path)) {
        onStatus('Authorizing ZCode…');
        const checkbox = await findVisible(page, ['[role="checkbox"]:visible']);
        if (checkbox) {
          const checked = await checkbox.getAttribute('aria-checked');
          if (checked !== 'true') await checkbox.click().catch(() => {});
        }
        await clickVisible(page, CONTINUE_BUTTONS, log);
        await page.waitForTimeout(3000);
        continue;
      }

      // Provider selection ("Continue with Email") -------------------
      await clickVisible(page, EMAIL_LOGIN_BUTTONS, log);
      await page.waitForTimeout(1500);
      continue;
    }

    if (host === 'zcode.z.ai' && !/\/login(?:[/?]|$)/.test(path)) {
      log('  [zcode] Z.AI SSO complete');
      return true;
    }

    await page.waitForTimeout(1000);
  }
  return false;
}

// ── stage 2: local ZCode web UI ─────────────────────────────────────

async function findComposer(page) {
  for (const selector of COMPOSER_SELECTORS) {
    try {
      const loc = page.locator(selector).first();
      if ((await loc.count()) > 0 && (await loc.isVisible({ timeout: 800 }))) {
        const editable =
          (await loc.getAttribute('contenteditable')) === 'true' ||
          (await loc.evaluate((e) => /^(INPUT|TEXTAREA)$/.test(e.tagName) || !!e.isContentEditable).catch(() => false));
        return { locator: loc, selector, editable };
      }
    } catch {
      /* next selector */
    }
  }
  return null;
}

async function handleLocalLogin(page, account, opts) {
  if (!(await findVisible(page, LOCAL_LOGIN_SELECTORS))) return false;
  opts.log('  [zcode] local UI requires login');
  const popupPromise = page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null);
  await clickVisible(page, LOCAL_LOGIN_SELECTORS, opts.log);
  const popup = await popupPromise;
  const target = popup || page;
  await target.waitForLoadState('domcontentloaded').catch(() => {});
  if (/zcode\.z\.ai|chat\.z\.ai/.test(target.url())) {
    await loginViaZai(target, account, opts);
    if (popup) {
      await popup.close().catch(() => {});
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
  return true;
}

async function openLocalWorkspace(page, { localUrl, account, log, onStatus, loginTimeoutMs }) {
  const target = localUrl || DEFAULT_LOCAL_URL;
  log(`  [zcode] opening local web UI: ${target}`);
  onStatus('Connecting to local ZCode UI…');
  try {
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (err) {
    const reason = String(err?.message || err).split(/\r?\n/)[0];
    throw new Error(
      `ZCode local web UI is not reachable at ${target} (${reason}). ` +
        'Start it with `zcode --web`, then set "zcodeLocalUrl" in config.json ' +
        'if it runs on a different address.'
    );
  }

  const deadline = Date.now() + Math.max(30000, loginTimeoutMs);
  let lastAction = 0;
  while (Date.now() < deadline) {
    const composer = await findComposer(page);
    if (composer) {
      log(`  [zcode] composer ready: ${composer.selector}`);
      return composer;
    }
    if (Date.now() - lastAction > 3000) {
      lastAction = Date.now();
      if (await handleLocalLogin(page, account, { log, onStatus, loginTimeoutMs })) continue;
      await clickVisible(page, NEW_TASK_SELECTORS, log);
    }
    await page.waitForTimeout(1000);
  }
  throw new Error(
    `ZCode local web UI did not show a composer at ${target}. ` +
      'Check that ZCode is running (`zcode --web`) and signed in.'
  );
}

// ── reply detection in the agent timeline ───────────────────────────

async function generationActive(page) {
  return page
    .evaluate(() => {
      const ids = ['v4-stop', 'chat-stop-button', 'chat-loading'];
      for (const id of ids) {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (el && el.getClientRects().length) return true;
      }
      return false;
    })
    .catch(() => false);
}

async function timelineText(page) {
  return page
    .evaluate(() => {
      const el =
        document.querySelector('[data-testid="v4-timeline"]') ||
        document.querySelector('[data-testid="chat-messages"]') ||
        document.querySelector('[data-testid="chat-view"]');
      return el ? (el.innerText || '').trim() : '';
    })
    .catch(() => '');
}

async function lastAssistantText(page) {
  return page
    .evaluate(() => {
      // ZCode v4 renders assistant text inside a stable
      // [data-conversation-selectable="true"] wrapper (ConversationRowView).
      const selectors = [
        '[data-conversation-selectable="true"]',
        '[data-testid^="chat-assistant-message"]',
        '[data-testid^="v4-row-"].group\\/assistant-row',
      ];
      for (const selector of selectors) {
        const nodes = [...document.querySelectorAll(selector)].filter((e) => e.getClientRects().length);
        if (nodes.length) {
          const text = (nodes[nodes.length - 1].innerText || '').trim();
          if (text) return text;
        }
      }
      const rows = [...document.querySelectorAll('[data-testid="v4-row"]')].filter(
        (e) => e.getClientRects().length
      );
      if (rows.length) return (rows[rows.length - 1].innerText || '').trim();
      return '';
    })
    .catch(() => '');
}

async function liveStatus(page) {
  return page
    .evaluate(() => {
      const nodes = [...document.querySelectorAll('[data-testid^="v4-row"]')].filter(
        (e) => e.getClientRects().length
      );
      for (let i = nodes.length - 1; i >= 0; i--) {
        const text = (nodes[i].innerText || '').replace(/\s+/g, ' ').trim();
        if (text && text.length < 120) return `ZCode: ${text}`;
      }
      return null;
    })
    .catch(() => null);
}

// ── public session factory ──────────────────────────────────────────

export async function openCodeSession({
  url = 'https://zcode.z.ai/login',
  localUrl = DEFAULT_LOCAL_URL,
  token = null,
  account = null,
  model = 'x-preview-l',
  effort = 'max',
  headless = true,
  proxy = null,
  browser = null,
  loginTimeoutMs = 180000,
  log = () => {},
  onStatus = () => {},
}) {
  const debug = process.env.ZAI_REGGER_DEBUG ? log : () => {};
  const pw = await import('playwright-core');
  const channel = browser || resolveBrowserChannel();
  if (!channel) throw new Error('Chrome/Edge not found — ZCode requires a browser');

  const launchOptions = {
    channel,
    headless,
    args: ['--disable-blink-features=AutomationControlled'],
  };
  if (proxy) launchOptions.proxy = { server: proxy };
  const browserHandle = await pw.chromium.launch(launchOptions);

  try {
    const context = await browserHandle.newContext({
      userAgent: UA,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await page.addInitScript(HOOK_JS);

    const info = jwtInfo(token);
    debug(`  [zcode] opening ${url} as ${info.email || info.id || (account?.email || 'account')}`);

    // Stage 1: Z.AI SSO on zcode.z.ai.
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    const signedIn = await loginViaZai(page, account, { loginTimeoutMs, log: debug, onStatus });
    if (!signedIn) {
      throw new Error(
        `Z.AI login did not complete (last URL: ${page.url()}). ` +
          'Check the account credentials and captcha settings in config.json.'
      );
    }

    // Stage 2: the actual agent UI, served locally by `zcode --web`.
    const composer = await openLocalWorkspace(page, {
      localUrl,
      account,
      log: debug,
      onStatus,
      loginTimeoutMs,
    });
    onStatus('ZCode ready');

    let closed = false;

    async function send(message, { timeoutMs = 180000 } = {}) {
      if (closed) throw new Error('ZCode session is closed');
      const before = await timelineText(page);

      if (composer.editable) {
        await composer.locator.click({ timeout: 5000 });
        await page.keyboard.insertText(message);
      } else {
        await composer.locator.fill(message);
      }
      const sent = await clickVisible(page, SEND_SELECTORS, debug);
      if (!sent) await page.keyboard.press('Enter');
      debug('  [zcode] prompt sent, waiting for the agent');

      // Wait until the timeline changes or a stop/loading indicator appears.
      const startedAt = Date.now();
      let started = false;
      while (Date.now() - startedAt < 30000) {
        if ((await generationActive(page)) || (await timelineText(page)) !== before) {
          started = true;
          break;
        }
        await page.waitForTimeout(300);
      }

      let stable = 0;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const active = await generationActive(page);
        if (!active && started) {
          stable += 1;
          if (stable >= 3) break;
        } else {
          stable = 0;
        }
        const status = await liveStatus(page);
        if (status) onStatus(status);
        await page.waitForTimeout(500);
      }

      const content = await lastAssistantText(page);
      if (content) return { content, status: 200 };
      return {
        content: '',
        status: 0,
        error: 'No assistant reply detected in the ZCode workspace',
        raw: (await timelineText(page)).slice(-500),
      };
    }

    return {
      page,
      send,
      model,
      effort,
      mode: 'ZCode',
      async close() {
        if (closed) return;
        closed = true;
        await browserHandle.close().catch(() => {});
      },
    };
  } catch (err) {
    await browserHandle.close().catch(() => {});
    throw err;
  }
}

export const openZCodeSession = openCodeSession;
