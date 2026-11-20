// ZChat driver (https://chat.z.ai): a persistent Playwright page logged in with
// the account's JWT. The web UI signs every completion request and solves an
// Aliyun captcha before sending, so chatting through the real page is the
// reliable path (raw POST /api/chat/completions answers 404 without it).

import { resolveBrowserChannel } from './captcha.js';
import { sliderVisible, solveSliderAuto } from './slider.js';
import { jwtInfo } from './store.js';
import { BASE, UA } from './zai.js';

const HOOK_JS = `
try { Object.defineProperty(navigator, 'webdriver', { get: function () { return undefined; } }); } catch (e) {}
`;

// Flags that suppress onboarding / "what's new" overlays which otherwise cover
// the composer. Keys taken from the production frontend bundle.
function initStorage(cfg) {
  try {
    localStorage.setItem('token', cfg.token);
    localStorage.setItem('last_mode', 'agent');
    localStorage.setItem('last_selected_agent_model', JSON.stringify([cfg.model]));
    localStorage.setItem('last_reasoning_effort', cfg.effort);
    localStorage.setItem('guide_to_slide_scene', '1');
    localStorage.setItem('whats_new_2026_11_seen_users', JSON.stringify([cfg.userId]));
    localStorage.setItem('paid_transition_notice_2026_11_shown', String(cfg.userId || '1'));
    localStorage.setItem('new_product_launch_dismissed', 'true');
  } catch {
    /* storage may be unavailable on the first about:blank pass */
  }
}

async function dismissCaptcha(page) {
  try {
    await page.evaluate(() => {
      const closeBtn = document.querySelector('#aliyunCaptcha-btn-close, .aliyunCaptcha-btn-close, [id*="Captcha"] button[aria-label*="close" i]');
      if (closeBtn) closeBtn.click();
      const mask = document.querySelector('#aliyunCaptcha-mask');
      if (mask) mask.remove();
      const win = document.querySelector('#aliyunCaptcha-window-popup');
      if (win) win.remove();
    });
  } catch {}
}

async function dismissDialogs(page, log) {
  for (let round = 0; round < 3; round++) {
    const closed = await page.evaluate(() => {
      const labels = /^(got it|ok|close|skip|next|dismiss|确认|知道了|关闭|跳过|下一步)$/i;
      const roots = document.querySelectorAll(
        '[data-slot="dialog-overlay"][data-state="open"], [role="dialog"]'
      );
      let clicked = false;
      for (const root of roots) {
        for (const btn of root.querySelectorAll('button, [role="button"]')) {
          const text = (btn.innerText || btn.getAttribute('aria-label') || '').trim();
          if (text && labels.test(text)) {
            btn.click();
            clicked = true;
            break;
          }
        }
        if (clicked) break;
        const x = root.querySelector('button[aria-label*="Close" i], [data-slot="dialog-close"]');
        if (x) {
          x.click();
          clicked = true;
          break;
        }
      }
      return clicked;
    });
    if (!closed) break;
    debug('  [chat] dismissed dialog');
    await page.waitForTimeout(400);
  }
}

// The Aliyun popup can be present as a "security verification" modal before
// its draggable knob has rendered. Detect that modal too, otherwise the solver
// is never started and the completion stays blocked forever.
async function captchaPromptVisible(page) {
  return page
    .evaluate(() => {
      const text = document.body.innerText || '';
      if (/please complete security verification|please drag the slider|请完成安全验证|按住滑块|滑动验证/i.test(text)) return true;
      return [...document.querySelectorAll('[id*="aliyunCaptcha-window"], [class*="aliyunCaptcha-window"]')].some(
        (e) => !!e.getClientRects().length
      );
    })
    .catch(() => false);
}

// Extract assistant text from the web app's SSE stream. Live format:
//   data: {"type":"chat:completion","data":{"delta_content":"…","phase":"thinking"}}
// Older/OpenAI-shaped chunks (`choices[0].delta.content`) are still accepted.
export function parseCompletion(text) {
  let content = '';
  let reasoning = '';
  let lastPhase = '';

  const append = (value, isThinking, phase = '') => {
    if (typeof value !== 'string' || !value) return;
    if (isThinking) {
      reasoning += value;
    } else {
      if (lastPhase && phase && lastPhase !== phase && content && !content.endsWith('\n')) {
        content += '\n\n';
      }
      content += value;
      lastPhase = phase;
    }
  };

  const consumeOpenAi = (delta) => {
    if (!delta || typeof delta !== 'object') return;
    append(delta.content, false, 'content');
    append(delta.reasoning_content ?? delta.reasoning, true, 'thinking');
  };

  const consumeZai = (chunk) => {
    if (!chunk || typeof chunk !== 'object') return;
    const phase = String(chunk.phase || '').toLowerCase();
    const thinking = ['thinking', 'think', 'reasoning'].includes(phase);
    const delta = chunk.delta_content ?? chunk.delta ?? chunk.content;
    if (typeof delta === 'string') {
      // a final `content` event may repeat the whole answer — do not duplicate
      if (delta.startsWith(content) && delta.length >= content.length && !chunk.delta_content) {
        content = delta;
      } else {
        append(delta, thinking, phase || 'content');
      }
    } else if (Array.isArray(delta)) {
      append(delta.map((p) => (typeof p === 'string' ? p : p?.text || '')).join(''), thinking, phase || 'content');
    }
  };

  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue;
    }
    if (obj.type === 'chat:completion' || obj.data) consumeZai(obj.data || obj);
    for (const choice of obj.choices || []) consumeOpenAi(choice.delta || choice.message);
  }
  const direct = trimmedJson(text);
  if (direct && direct.type === 'chat:completion') consumeZai(direct.data || direct);

  // Cleanly split any squished tool outputs from final assistant answer:
  // e.g. "print123.pyГотово" -> "print123.py\n\nГотово"
  const formattedContent = content
    .replace(/(File created successfully at:[^\n]+?)([A-ZА-ЯЁ])/g, '$1\n\n$2')
    .replace(/(\.[a-zA-Z0-9_-]+)(Готово|Успешно|Выполнено|[A-ZА-ЯЁ][a-zа-яё]{2,})/g, '$1\n\n$2')
    .replace(/(---[^\n]+---)([^\n])/g, '$1\n$2')
    .replace(/(\bPrint\([^)]+\))([A-ZА-ЯЁ])/g, '$1\n\n$2');

  return { content: formattedContent.trim(), reasoning: reasoning.trim() };
}

function trimmedJson(text) {
  const s = String(text || '').trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export async function openChatSession({
  token,
  model = 'x-preview-l',
  effort = 'max',
  headless = true,
  proxy = null,
  browser = null,
  log = () => {},
  onStatus = () => {},
}) {
  // Normal UI stays quiet; set ZAI_REGGER_DEBUG=1 for driver diagnostics.
  const debug = process.env.ZAI_REGGER_DEBUG ? log : () => {};

  const pw = await import('playwright-core');
  const channel = browser || resolveBrowserChannel();
  if (!channel) throw new Error('Chrome/Edge not found — chat requires a browser');

  const browserHandle = await pw.chromium.launch({
    channel,
    headless,
    proxy: proxy ? { server: proxy } : undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const context = await browserHandle.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(HOOK_JS);
  const info = jwtInfo(token);
  await page.addInitScript(initStorage, {
    token,
    model,
    effort,
    userId: info.id || 'zai-regger',
  });

  let capture = null;
  page.on('response', async (resp) => {
    if (!/\/api\/(?:v\d+\/)?chat\/completions/.test(resp.url())) return;
    const slot = { status: resp.status(), text: '', done: false };
    capture = slot;
    try {
      slot.text = await resp.text();
    } catch (err) {
      slot.text = `[response read failed: ${err.message}]`;
    }
    slot.done = true;
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /captcha|verification/i.test(msg.text())) {
      debug(`  [chat] browser: ${msg.text().slice(0, 160)}`);
    }
  });

  debug(`  [chat] opening ${BASE} as ${info.email || info.id || 'account'} (${model}, ${effort})`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await dismissDialogs(page, debug);
  await dismissCaptcha(page);

  const editor = page.locator('textarea#chat-input');
  try {
    await editor.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    throw new Error('chat composer did not appear — check the account/browser');
  }

  let generation = 0;
  let closed = false;

  async function send(message, { timeoutMs = 180000 } = {}) {
    if (closed) throw new Error('chat session is closed');
    const thisGen = ++generation;
    capture = null;
    await dismissDialogs(page, debug);
    await dismissCaptcha(page);
    try {
      await editor.click({ timeout: 3000 });
    } catch {
      await dismissCaptcha(page);
      await editor.focus().catch(() => {});
    }
    await editor.fill(message);
    await page.keyboard.press('Enter');
    debug('  [chat] message sent, waiting for completion');

    const deadline = Date.now() + timeoutMs;
    let captchaRound = 0;
    let lastLen = 0;
    let lastSolveAt = 0;
    while (Date.now() < deadline && generation === thisGen) {
      if (capture?.done) {
        const parsed = parseCompletion(capture.text);
        if (parsed.content) return { ...parsed, status: capture.status };
        // stream finished but no text — surface the raw tail for diagnosis
        return { content: '', reasoning: parsed.reasoning, status: capture.status, raw: capture.text.slice(-500) };
      }
      const visible = (await sliderVisible(page).catch(() => false)) || (await captchaPromptVisible(page));
      if (visible && Date.now() - lastSolveAt > 8000) {
        captchaRound += 1;
        lastSolveAt = Date.now();
        onStatus('Solving captcha…');
        debug(`  [chat] captcha #${captchaRound} — solving slider`);
        const outcome = await solveSliderAuto({
          page,
          referer: `${BASE}/`,
          attempts: 6,
          log: debug,
          isSolved: () => !!(capture && capture.done),
        });
        debug(`  [chat] slider: ${outcome}`);
        if (outcome !== 'passed') {
          await dismissCaptcha(page);
          return {
            content: '',
            status: 0,
            error: `captcha not solved: ${outcome}`,
          };
        }
        onStatus('Thinking…');
        await page.waitForTimeout(1000);
        continue;
      }

      // Live status polling from the page DOM so the user sees tool calls and agent actions:
      try {
        const liveAction = await page.evaluate(() => {
          // Look for active tool / step badges or executing indicators
          const badges = document.querySelectorAll(
            '[class*="tool" i], [class*="step" i], [class*="action" i], [class*="executing" i], [class*="status" i], [data-slot*="status"]'
          );
          for (let i = badges.length - 1; i >= 0; i--) {
            const t = (badges[i].innerText || '').replace(/\s+/g, ' ').trim();
            if (t && t.length > 2 && t.length < 80 && !/^(new chat|share|connect|like|copy|regenerate)/i.test(t)) {
              return t;
            }
          }
          // Look for active reasoning / thinking preview
          const thoughts = document.querySelectorAll('[class*="thought" i], [class*="thinking" i]');
          if (thoughts.length) {
            const last = thoughts[thoughts.length - 1];
            const lines = (last.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
            if (lines.length) return `Thinking: ${lines[lines.length - 1].slice(0, 50)}`;
          }
          return null;
        });
        if (liveAction && onStatus) {
          onStatus(liveAction);
        }
      } catch {}

      if (Date.now() - lastLen > 20000) {
        lastLen = Date.now();
        debug('  [chat] still waiting for completion');
      }
      await page.waitForTimeout(400);
    }
    return { content: '', status: 0, error: 'response timeout' };
  }

  return {
    page,
    send,
    model,
    effort,
    async close() {
      if (closed) return;
      closed = true;
      await browserHandle.close().catch(() => {});
    },
  };
}

export const openZChatSession = openChatSession;
