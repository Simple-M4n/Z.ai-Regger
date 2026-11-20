#!/usr/bin/env node
// zai-regger — interactive TUI for ZChat and ZCode, account registration and settings.
// Plain text sends directly to the active mode; slash commands handle tools and settings.

import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import path from 'node:path';

import { api, getLimits, getModels, getProfile, formatLimits } from './lib/api.js';
import { openZChatSession } from './lib/chat.js';
import { openZCodeSession } from './lib/code.js';
import {
  ROOT_DIR,
  CONFIG_FILE,
  MODES,
  MODEL_NAMES,
  MODEL_ALIASES,
  loadAccounts,
  loadConfig,
  saveConfig,
  saveState,
  findAccount,
  usableAccounts,
  jwtInfo,
  getWorkspace,
} from './lib/store.js';

const PROJECT_DIR = ROOT_DIR;
const IS_TTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
let debugEnabled = Boolean(process.env.ZAI_REGGER_DEBUG);

const AGENTS = ['Build', 'Plan', 'Chat'];
const BRAND = 'zai-regger';
const VERSION = '1.0.0';
const PLACEHOLDER = 'Ask anything… "Fix a TODO in the codebase"';

const LOGO = [
  '█▀▀▀  █     █  █  ▀█▀   █▀▀█  █▀▀ ',
  '█ ▀█  █     █  █   █    █▀▀█  █▀▀ ',
  '▀▀▀▀  ▀▀▀▀   ▀▀   ▀▀▀   ▀▀▀▀  ▀▀▀ ',
];

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_MS = 80;

const COMMAND_PALETTE = [
  ['/new', 'Start a new conversation'],
  ['/newacc', 'Register account(s) via regger'],
  ['/switch', 'Switch active account (/switch <number|email|last>)'],
  ['/accounts', 'List accounts and JWT status'],
  ['/status', 'View account status, quota and subscription limits'],
  ['/mode', 'Set reasoning effort (low, high, max)'],
  ['/target', 'Switch platform (/target ZCode|ZChat)'],
  ['/zcode', 'Switch to ZCode (zcode.z.ai)'],
  ['/zchat', 'Switch to ZChat (chat.z.ai)'],
  ['/config', 'Show config.json path and active settings'],
  ['/models', 'Fetch available models from API'],
  ['/agents', 'Switch agent role (Build, Plan, Chat)'],
  ['/exit', 'Exit zai-regger'],
];

// ── Colors & Styling (Monochrome Theme) ───────────────────────────

const rawColors = IS_TTY
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[38;2;160;160;160m',
      dark: '\x1b[38;2;100;100;100m',
      border: '\x1b[38;2;75;75;75m',
      brand: '\x1b[38;2;245;245;245m',
      brandBold: '\x1b[1;38;2;255;255;255m',
      white: '\x1b[38;2;250;250;250m',
      gray: '\x1b[38;2;175;175;175m',
      yellow: '\x1b[38;2;220;220;220m',
      cyan: '\x1b[38;2;200;200;200m',
      green: '\x1b[38;2;245;245;245m',
      red: '\x1b[38;2;160;160;160m',
      purple: '\x1b[38;2;180;180;180m',
      badgeBg: '\x1b[48;2;30;30;30m',
      selBg: '\x1b[48;2;240;240;240m\x1b[38;2;15;15;15m',
      selBar: '\x1b[48;2;244;162;97m\x1b[38;2;15;15;15m\x1b[1m',
      black: '\x1b[38;2;15;15;15m',
      // Agent specific colors:
      agentBuild: '\x1b[38;2;249;115;22m', // Orange
      agentPlan: '\x1b[38;2;59;130;246m',   // Blue
      agentChat: '\x1b[38;2;156;163;175m',  // Gray
    }
  : {};

const C = new Proxy(rawColors, {
  get: (target, prop) => (typeof prop === 'string' && prop in target ? target[prop] : ''),
});

function agentColor(name) {
  if (name === 'Build') return C.agentBuild;
  if (name === 'Plan') return C.agentPlan;
  if (name === 'Chat') return C.agentChat;
  return C.white;
}

const hideCursor = () => (IS_TTY ? '\x1b[?25l' : '');
const showCursor = () => (IS_TTY ? '\x1b[?25h' : '');
const enterAltScreen = () => (IS_TTY ? '\x1b[?1049h' : '');
const exitAltScreen = () => (IS_TTY ? '\x1b[?1049l' : '');
const mouseOn = () => '';
const mouseOff = () => (IS_TTY ? '\x1b[?1000l\x1b[?1002l\x1b[?1006l' : '');

function stripAnsi(str) {
  return String(str || '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

function formatWorkspace(p) {
  if (!p) p = getWorkspace();
  const norm = path.normalize(p);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home && norm.toLowerCase().startsWith(home.toLowerCase())) {
    return `~${norm.slice(home.length).replace(/\\/g, '/')}`;
  }
  return norm.replace(/\\/g, '/');
}

function visibleWidth(str) {
  return stripAnsi(str).length;
}

// ── Markdown Formatter ───────────────────────────────────────────

function formatMarkdown(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const out = [];
  let inCode = false;
  let codeLang = '';

  for (const rawLine of lines) {
    if (rawLine.startsWith('```')) {
      if (!inCode) {
        inCode = true;
        codeLang = rawLine.slice(3).trim() || 'code';
        out.push(`${C.border}╭─ ${C.brand}${codeLang} ${C.border}${'─'.repeat(Math.max(2, 54 - codeLang.length))}${C.reset}`);
      } else {
        inCode = false;
        out.push(`${C.border}╰${'─'.repeat(58)}${C.reset}`);
      }
      continue;
    }

    if (inCode) {
      out.push(`${C.border}│ ${C.white}${rawLine}${C.reset}`);
      continue;
    }

    let line = rawLine;
    if (line.startsWith('# ')) {
      out.push(`${C.brandBold}■ ${line.slice(2)}${C.reset}`);
      continue;
    }
    if (line.startsWith('## ')) {
      out.push(`${C.bold}${C.cyan}▸ ${line.slice(3)}${C.reset}`);
      continue;
    }
    if (line.startsWith('### ')) {
      out.push(`${C.bold}${C.white}${line.slice(4)}${C.reset}`);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const match = line.match(/^(\s*)([-*]\s+)(.*)$/);
      if (match) {
        line = `${match[1]}  ${C.brand}•${C.reset} ${match[3]}`;
      }
    }

    // Inline bold: **bold**
    line = line.replace(/\*\*([^*]+)\*\*/g, `${C.bold}${C.white}$1${C.reset}`);
    // Inline code: `code`
    line = line.replace(/`([^`]+)`/g, `${C.cyan}$1${C.reset}`);

    out.push(`${C.white}${line}${C.reset}`);
  }

  if (inCode) {
    out.push(`${C.border}╰${'─'.repeat(58)}${C.reset}`);
  }
  return out;
}

// ── State ────────────────────────────────────────────────────────

const state = {
  config: loadConfig(),
  accounts: loadAccounts(),
  active: null,
  session: null,
  sessionAccountEmail: null,
  sessionMode: null,
  input: '',
  cursor: 0,
  history: [],
  historyIndex: -1,
  savedInput: '',
  transcript: [],
  scroll: 0,
  busy: false,
  busyLabel: '',
  agent: 'Build',
  palette: null,
  latestThought: null,
  thoughtStartRow: null,
  thoughtEndRow: null,
  cachedModels: null,
  spinner: 0,
};

const currentModelName = () => MODEL_NAMES[state.config.model] || state.config.model;

function initialize() {
  const usable = usableAccounts(state.accounts);
  state.active = findAccount(state.accounts, state.config.accountId) ||
    usable[usable.length - 1] || null;
  if (state.active) {
    state.config.accountId = state.active.email || String(state.active.index);
  }
}

function persist() {
  saveState({ accountId: state.config.accountId });
  saveConfig(state.config);
}

// Flags are convenience overrides; every value is persisted to config.json so
// the JSON file stays the single source of truth.
function applyCliOverrides() {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        mode: { type: 'string' },
        proxy: { type: 'string' },
        browser: { type: 'string' },
        headed: { type: 'boolean' },
        headless: { type: 'boolean' },
        config: { type: 'string' },
      },
      allowPositionals: true,
    });
  } catch {
    return;
  }
  const v = parsed.values;
  if (!v.mode && !v.proxy && !v.browser && !v.headed && !v.headless && !v.config) return;

  if (v.config) state.config = loadConfig(path.resolve(v.config));
  if (v.mode) {
    const key = String(v.mode).toLowerCase().replace(/[^a-z]/g, '');
    state.config.mode = key === 'zcode' ? 'ZCode' : 'ZChat';
  }
  if (v.proxy != null) {
    state.config.proxy = ['none', 'off', 'null', ''].includes(String(v.proxy).toLowerCase())
      ? null
      : String(v.proxy);
  }
  if (v.browser) state.config.browser = String(v.browser).toLowerCase();
  if (v.headed) state.config.headless = false;
  if (v.headless) state.config.headless = true;
  persist();
}

function print(kind, text) {
  const prefixMap = {
    info: `${C.dim}`,
    ok: `${C.bold}${C.white}✓ ${C.reset}${C.white}`,
    warn: `${C.dim}⚠ ${C.reset}${C.dim}`,
    err: `${C.bold}${C.white}✗ ${C.reset}${C.white}`,
    user: `${C.bold}${C.white}> ${C.reset}${C.white}`,
    thought: `${C.dim}`,
    reg: `${C.dark}`,
  };

  const pfx = prefixMap[kind] || C.white;
  const rawLines = String(text ?? '').split(/\r?\n/);
  const formatted = rawLines.map((line) => `${pfx}${line}${C.reset}`);

  if (!IS_TTY) {
    for (const line of formatted) console.log(line);
    return;
  }

  state.transcript.push(...formatted);
  const max = Math.max(200, state.config.maxTranscript || 2000);
  const removed = Math.max(0, state.transcript.length - max);
  if (removed) {
    state.transcript.splice(0, removed);
  }
  state.scroll = 0;
  render();
}

function dbg(text) {
  if (debugEnabled) print('reg', String(text).trim());
}

// ── Palette & Agents ─────────────────────────────────────────────

function openPalette(kind, filter = '') {
  state.palette = { kind, filter, index: 0 };
  render();
}

function closePalette() {
  if (!state.palette) return;
  state.palette = null;
  render();
}

async function openModelsPalette() {
  if (state.active?.token && (!state.cachedModels || !state.cachedModels.length)) {
    try {
      const apiModels = await getModels(state.config, state.active).catch(() => null);
      if (apiModels && apiModels.length > 0) {
        state.cachedModels = apiModels.map((m) => ({
          id: m.id,
          name: MODEL_NAMES[m.id] || m.name || m.id,
          desc: m.efforts?.length ? m.efforts.join('/') : 'low/high/max',
        }));
      }
    } catch {}
  }
  if (!state.cachedModels || !state.cachedModels.length) {
    state.cachedModels = [
      { id: 'x-preview-l', name: 'GLM-5.3-Flash', desc: 'low/high/max' },
      { id: 'glm-5.3', name: 'GLM-5.3', desc: 'low/high/max' },
      { id: 'glm-5.2', name: 'GLM-5.2', desc: 'low/high/max' },
    ];
  }
  const curIdx = state.cachedModels.findIndex((m) => m.id === state.config.model);
  state.palette = {
    kind: 'models',
    index: curIdx >= 0 ? curIdx : 0,
    filter: '',
  };
  render();
}

function openModePalette() {
  const modes = [
    { id: 'low', name: 'low', desc: 'Minimal thinking, fastest responses' },
    { id: 'high', name: 'high', desc: 'Balanced deep reasoning (High)' },
    { id: 'max', name: 'max', desc: 'Maximum thinking effort (Max)' },
  ];
  const curIdx = modes.findIndex((m) => m.id === state.config.effort);
  state.palette = {
    kind: 'mode',
    index: curIdx >= 0 ? curIdx : 1,
    filter: '',
  };
  render();
}

function openSwitchPalette() {
  state.accounts = loadAccounts();
  if (!state.accounts.length) {
    print('warn', 'accounts.json is empty. Use /newacc to register an account.');
    return;
  }
  const curIdx = state.accounts.findIndex((a) => a.email === state.active?.email);
  state.palette = {
    kind: 'switch',
    index: curIdx >= 0 ? curIdx : 0,
    filter: '',
  };
  render();
}

function paletteItems() {
  if (!state.palette) return [];
  if (state.palette.kind === 'agents') {
    const desc = {
      Build: 'Implement code and execute actions',
      Plan: 'Think deeply and outline strategy',
      Chat: 'Direct conversational assistance',
    };
    return AGENTS.map((a) => ({
      label: a,
      desc: desc[a],
      value: a,
      isCurrent: a === state.agent,
    }));
  }
  if (state.palette.kind === 'models') {
    const list = state.cachedModels || [
      { id: 'x-preview-l', name: 'GLM-5.3-Flash', desc: 'Free' },
      { id: 'glm-5.3', name: 'GLM-5.3', desc: 'Free' },
      { id: 'glm-5.2', name: 'GLM-5.2', desc: 'Free' },
    ];
    const q = String(state.palette.filter || '').replace(/^\//, '').toLowerCase();
    return list
      .filter((m) => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      .map((m) => ({
        label: m.name || m.id,
        desc: m.desc || 'Free',
        value: m.id,
        isCurrent: m.id === state.config.model,
      }));
  }
  if (state.palette.kind === 'mode') {
    const modes = [
      { id: 'low', name: 'Low', desc: 'Fastest' },
      { id: 'high', name: 'High', desc: 'High reasoning' },
      { id: 'max', name: 'Max', desc: 'Maximum effort' },
    ];
    return modes.map((m) => ({
      label: m.name,
      desc: m.desc,
      value: m.id,
      isCurrent: m.id === state.config.effort,
    }));
  }
  if (state.palette.kind === 'switch') {
    return state.accounts.map((a, i) => {
      const isCur = a.email === state.active?.email;
      const info = jwtInfo(a.token);
      const tag = a.status === 'complete'
        ? info.valid ? 'Valid' : info.expired ? 'Expired' : '?'
        : a.status || '?';
      return {
        label: `#${i + 1}  ${a.email || 'no-email'}`,
        desc: tag,
        value: a,
        isCurrent: isCur,
      };
    });
  }
  const q = String(state.palette.filter || '').replace(/^\//, '').toLowerCase();
  return COMMAND_PALETTE
    .filter(([cmd, desc]) => !q || cmd.toLowerCase().includes(q) || desc.toLowerCase().includes(q))
    .map(([cmd, desc]) => ({
      label: cmd,
      desc,
      value: cmd,
      isCurrent: false,
    }));
}

// ── Viewport & Rendering ─────────────────────────────────────────

function getDimensions() {
  const cols = Math.max(65, process.stdout.columns || 100);
  const rows = Math.max(16, process.stdout.rows || 30);
  const indent = 2;
  const boxWidth = Math.max(40, cols - 4);
  return { cols, rows, boxWidth, indent };
}

function viewport(rows) {
  const items = state.palette ? paletteItems() : [];
  const paletteHeight = state.palette
    ? 4 + Math.min(8, items.length)
    : 0;

  let thoughtLines = 0;
  if (state.latestThought && state.latestThought.expanded) {
    const all = String(state.latestThought.text || '').split(/\r?\n/);
    thoughtLines = Math.min(10, all.length) + 2;
  }

  // 6 composer lines + top status bar + extras
  const composerHeight = 6;
  const topBarHeight = state.transcript.length > 0 ? 2 : 0;
  const fixed = composerHeight + topBarHeight + (state.busy ? 1 : 0) + paletteHeight + thoughtLines;
  const viewHeight = Math.max(2, rows - fixed);

  const total = state.transcript.length;
  const maxScroll = Math.max(0, total - viewHeight);
  state.scroll = Math.min(Math.max(0, state.scroll), maxScroll);
  const end = total - state.scroll;
  const start = Math.max(0, end - viewHeight);

  return {
    lines: state.transcript.slice(start, end),
    start,
    end,
    total,
    maxScroll,
    viewHeight,
  };
}

function scrollBy(delta) {
  const before = state.scroll;
  state.scroll += delta;
  if (state.scroll !== before) render();
}

function render() {
  if (!IS_TTY) return;
  const { cols, rows, boxWidth, indent } = getDimensions();
  const pad = ' '.repeat(indent);
  const vp = viewport(rows);
  const out = [];

  state.thoughtRow = null;

  if (state.transcript.length === 0) {
    // ── Welcome Screen (Centered Hero) ───────────────────────────
    const logoWidth = LOGO[0].length;
    const logoPad = ' '.repeat(Math.max(1, Math.floor((cols - logoWidth) / 2)));
    const emptyRows = Math.max(1, Math.floor((rows - 18) / 2));

    for (let i = 0; i < emptyRows; i++) out.push('');

    LOGO.forEach((line) => {
      out.push(`${logoPad}${C.brandBold}${line}${C.reset}`);
    });

    const sub = `Z.AI Engine · ${state.config.mode} · Account Registration · v${VERSION}`;
    const subPad = ' '.repeat(Math.max(1, Math.floor((cols - sub.length) / 2)));
    out.push('');
    out.push(`${subPad}${C.dim}${sub}${C.reset}`);
    out.push('');

    const accountStr = state.active ? state.active.email : 'No account';
    const pills = `${agentColor(state.agent)}● Agent: ${state.agent}${C.reset}${C.dim}   Model: ${C.white}${currentModelName()}${C.reset}${C.dim}   Account: ${C.white}${accountStr}${C.reset}`;
    const pillVisible = `● Agent: ${state.agent}   Model: ${currentModelName()}   Account: ${accountStr}`;
    const pillPad = ' '.repeat(Math.max(1, Math.floor((cols - pillVisible.length) / 2)));
    out.push(`${pillPad}${pills}`);
    out.push('');

    const hints = [
      ['/new', 'Start a new conversation'],
      ['/switch', 'Switch active account'],
      ['/newacc', 'Register account automatically'],
      ['/status', 'Check quota and limits'],
    ];

    hints.forEach(([cmd, desc]) => {
      const line = `  ${cmd.padEnd(12)} ${desc}`;
      const hPad = ' '.repeat(Math.max(1, Math.floor((cols - 50) / 2)));
      out.push(`${hPad}${C.brand}${cmd.padEnd(12)}${C.reset} ${C.dim}${desc}${C.reset}`);
    });

    out.push('');
  } else {
    // ── Active Chat Screen (Top Status Bar + Messages) ───────────
    const statusLeft = ` ${BRAND} v${VERSION}  │  ${C.white}${state.config.mode}${C.reset}${C.dim}  │  ${agentColor(state.agent)}${state.agent}${C.reset}${C.dim}  │  ${C.white}${currentModelName()}${C.reset}`;
    const statusRight = state.active ? `${state.active.email} ` : 'No account ';
    const space = Math.max(1, cols - visibleWidth(statusLeft) - visibleWidth(statusRight));

    out.push(`${C.badgeBg}${C.dim}${statusLeft}${' '.repeat(space)}${C.dim}${statusRight}${C.reset}`);
    out.push(`${C.border}${'─'.repeat(cols)}${C.reset}`);

    // Render message lines & Thought block
    const thoughtColor = '\x1b[38;2;217;119;6m';
    vp.lines.forEach((line) => {
      if (line && typeof line === 'object' && line.type === 'thought') {
        if (!state.latestThought) return;
        state.thoughtStartRow = out.length;
        if (!state.latestThought.expanded) {
          out.push(`${pad}${thoughtColor}+ Thought · ${state.latestThought.seconds}s${C.reset}`);
          state.thoughtEndRow = out.length - 1;
        } else {
          out.push(`${pad}${thoughtColor}- Thought · ${state.latestThought.seconds}s${C.reset}`);
          const thoughtLines = String(state.latestThought.text || '').split(/\r?\n/);
          thoughtLines.forEach((t) => {
            out.push(`${pad}${C.border}│${C.reset} ${C.dim}${t}${C.reset}`);
          });
          state.thoughtEndRow = out.length - 1;
        }
        out.push('');
      } else {
        out.push(`${pad}${line}`);
      }
    });
  }

  // ── Busy Indicator ─────────────────────────────────────────────
  if (state.busy) {
    out.push(`${pad}${C.yellow}${SPINNER[state.spinner]} ${state.busyLabel}${C.reset}`);
  }

  // ── Command Palette / Agent / Model / Mode / Switch Selector (OpenCode Style) ──
  if (state.palette) {
    const isAgents = state.palette.kind === 'agents';
    const isModels = state.palette.kind === 'models';
    const isMode = state.palette.kind === 'mode';
    const isSwitch = state.palette.kind === 'switch';
    const title = isAgents
      ? 'Agents'
      : isModels
        ? 'Select model'
        : isMode
          ? 'Select effort'
          : isSwitch
            ? 'Select account'
            : 'Commands';
    const items = paletteItems();
    const w = boxWidth;

    out.push('');
    const escHint = 'esc';
    const headGap = Math.max(2, w - visibleWidth(title) - visibleWidth(escHint));
    out.push(`${pad}${C.bold}${C.white}${title}${' '.repeat(headGap)}${C.dim}${escHint}${C.reset}`);

    const searchPrompt = isModels || state.palette.kind === 'commands'
      ? `${C.dim}Search ${state.palette.filter || ''}${C.reset}`
      : '';
    if (searchPrompt) {
      out.push(`${pad}${searchPrompt}`);
    }

    if (items.length === 0) {
      out.push(`${pad}${C.dim}  No matches found${C.reset}`);
    } else {
      const pageSize = 8;
      let offset = 0;
      if (state.palette.index >= pageSize) {
        offset = Math.min(items.length - pageSize, state.palette.index - pageSize + 1);
      }
      const visibleItems = items.slice(offset, offset + pageSize);

      visibleItems.forEach((item, idx) => {
        const actualIdx = offset + idx;
        const sel = actualIdx === state.palette.index;
        const icon = item.isCurrent ? '● ' : '  ';
        const label = item.label;
        const desc = item.desc || '';
        const gap = Math.max(2, w - visibleWidth(icon) - visibleWidth(label) - visibleWidth(desc));
        const lineContent = `${icon}${label}${' '.repeat(gap)}${desc}`;

        if (sel) {
          out.push(`${pad}${C.selBar}${lineContent}${C.reset}`);
        } else {
          const dotColor = item.isCurrent ? C.agentBuild : C.dim;
          out.push(`${pad}${dotColor}${icon}${C.white}${label}${' '.repeat(gap)}${C.dim}${desc}${C.reset}`);
        }
      });
    }
    out.push('');
  }

  // ── Input Composer ─────────────────────────────────────────────
  const barBorder = '▀'.repeat(boxWidth - 1);
  const promptChars = [...state.input];
  let renderedInput = '';

  if (promptChars.length === 0) {
    renderedInput = `${C.white}▌${C.reset}${C.dim}${PLACEHOLDER}${C.reset}`;
  } else {
    const cur = Math.max(0, Math.min(state.cursor, promptChars.length));
    const before = promptChars.slice(0, cur).join('');
    const after = promptChars.slice(cur).join('');
    renderedInput = `${C.white}${before}▌${after}${C.reset}`;
  }

  out.push(`${pad}${C.border}┃${C.reset}`);
  out.push(`${pad}${C.border}┃${C.reset}  ${renderedInput}`);
  out.push(`${pad}${C.border}┃${C.reset}`);
  out.push(
    `${pad}${C.border}┃${C.reset}  ${agentColor(state.agent)}● ${C.bold}${state.agent}${C.reset} ${C.dim}·${C.reset} ${C.white}${currentModelName()}${C.reset}`
  );
  out.push(`${pad}${C.border}╹${barBorder}${C.reset}`);

  // Footer line
  const folder = formatWorkspace(getWorkspace(state.config));
  const hints = 'shift+tab agents   ctrl+p commands';
  const scrollText = vp.maxScroll ? `· ${vp.start + 1}-${vp.end}/${vp.total}` : '';
  const rightPart = scrollText ? `${hints}  ${scrollText}` : hints;
  const gap = Math.max(1, boxWidth - visibleWidth(folder) - visibleWidth(rightPart));
  out.push(
    `${pad}${C.dim}${folder}${' '.repeat(gap)}${C.dark}${hints}${scrollText ? `  ${C.dim}${scrollText}` : ''}${C.reset}`
  );

  // Smooth flicker-free repaint
  process.stdout.write(`\x1b[H${hideCursor()}${out.map((l) => l + '\x1b[K').join('\n')}\x1b[J`);
}

// ── Spinner ──────────────────────────────────────────────────────

let spinnerTimer = null;
function startSpinner() {
  if (spinnerTimer) return;
  state.spinner = 0;
  spinnerTimer = setInterval(() => {
    state.spinner = (state.spinner + 1) % SPINNER.length;
    render();
  }, SPINNER_MS);
}

function stopSpinner() {
  if (spinnerTimer) clearInterval(spinnerTimer);
  spinnerTimer = null;
}

async function withBusy(label, fn) {
  state.busy = true;
  state.busyLabel = label;
  startSpinner();
  render();
  try {
    return await fn();
  } catch (err) {
    const cleanMsg = String(err?.message || err).split(/\r?\n/)[0];
    print('err', `Error: ${cleanMsg}`);
    await closeSession();
    return null;
  } finally {
    stopSpinner();
    state.busy = false;
    state.busyLabel = '';
    render();
  }
}

function setBusyLabel(label) {
  if (!state.busy || state.busyLabel === label) return;
  state.busyLabel = label;
  render();
}

// ── Chat Session ─────────────────────────────────────────────────

async function ensureSession() {
  if (
    state.session &&
    state.sessionAccountEmail === state.active?.email &&
    state.sessionMode === state.config.mode
  ) {
    return state.session;
  }
  if (state.session) await closeSession();
  if (!state.active?.token) {
    print('err', 'No account selected. Use /accounts, then /switch <n>.');
    return null;
  }
  const common = {
    token: state.active.token,
    account: state.active,
    model: state.config.model,
    effort: state.config.effort,
    headless: state.config.headless,
    proxy: state.config.proxy,
    browser: state.config.browser,
    log: dbg,
    onStatus: setBusyLabel,
  };
  const isCode = state.config.mode === 'ZCode';
  const session = await withBusy(
    isCode ? 'Connecting to ZCode…' : 'Connecting to ZChat…',
    () =>
      isCode
        ? openZCodeSession({
            ...common,
            url: state.config.zcodeUrl,
            localUrl: state.config.zcodeLocalUrl,
            loginTimeoutMs: state.config.loginTimeoutMs,
          })
        : openZChatSession(common)
  );
  if (session) {
    state.session = session;
    state.sessionAccountEmail = state.active.email;
    state.sessionMode = state.config.mode;
  }
  return session;
}

async function closeSession() {
  if (!state.session) return;
  await state.session.close().catch(() => {});
  state.session = null;
  state.sessionAccountEmail = null;
  state.sessionMode = null;
}

async function sendChat(text, { quiet = false } = {}) {
  const session = await ensureSession();
  if (!session) return;
  if (!quiet) print('user', text);

  const started = Date.now();
  const result = await withBusy('Thinking…', () => session.send(text));
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (!result) return;
  if (result.error) {
    print('err', result.error);
    await closeSession();
    return;
  }

  if (result.reasoning) {
    state.latestThought = {
      seconds,
      text: result.reasoning,
      expanded: false,
    };
    state.transcript.push({ type: 'thought' });
  }

  if (result.content) {
    const formatted = formatMarkdown(result.content);
    state.transcript.push(...formatted);
    state.scroll = 0;
    render();
  } else {
    print('warn', `No content received (HTTP ${result.status})${result.raw ? ` · ${result.raw}` : ''}`);
  }
}

function toggleThought() {
  if (!state.latestThought) {
    print('warn', 'No reasoning captured yet.');
    return;
  }
  state.latestThought.expanded = !state.latestThought.expanded;
  state.scroll = 0;
  render();
}

// ── Accounts & Settings ──────────────────────────────────────────

async function listAccounts() {
  if (!state.accounts.length) {
    print('warn', 'accounts.json is empty. Use /new to register an account.');
    return;
  }
  print('info', 'Registered Accounts:');
  state.accounts.forEach((a, i) => {
    const mark = a === state.active ? `${C.green}●${C.reset}` : ' ';
    const info = jwtInfo(a.token);
    const tag =
      a.status === 'complete'
        ? info.valid
          ? `${C.green}JWT Valid${C.reset}`
          : info.expired
            ? `${C.red}JWT Expired${C.reset}`
            : `${C.yellow}JWT ?${C.reset}`
        : `${C.dark}${a.status}${C.reset}`;
    print('info', `  ${mark} ${String(i + 1).padStart(2)}  ${(a.email || '—').padEnd(30)} ${tag}`);
  });
}

async function selectAccount(acc) {
  if (!acc) return;
  await closeSession();
  state.active = acc;
  state.config.accountId = acc.email || String(acc.index);
  persist();
  const info = jwtInfo(acc.token);
  const tag = info.valid ? '' : info.expired ? ' (JWT expired)' : ' (JWT unknown)';
  print('ok', `Account selected: ${acc.email}${tag}`);
}

async function runRegger(count = 1) {
  await closeSession();
  const before = new Set(usableAccounts(state.accounts).map((a) => a.email));
  const args = [
    'regger.js',
    '--count',
    String(count),
    '--captcha',
    'auto',
    '--provider',
    state.config.provider,
    '--auto-attempts',
    String(state.config.autoAttempts),
  ];
  if (!state.config.headless) args.push('--headed');
  if (state.config.proxy) args.push('--proxy', state.config.proxy);

  const code = await withBusy(`Registering ${count} account(s) via regger…`, () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd: PROJECT_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const feed = (buf) => {
        for (const line of String(buf).split(/\r?\n/)) {
          if (line.trim()) dbg(line);
        }
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', (err) => {
        print('err', `regger: ${err.message}`);
        resolve(1);
      });
      child.on('close', (c) => resolve(c ?? 0));
    })
  );

  state.accounts = loadAccounts();
  const fresh = usableAccounts(state.accounts).find((a) => !before.has(a.email));
  if (fresh) {
    await selectAccount(fresh);
  } else {
    print('warn', `Registration finished (exit ${code}). No new usable account found.`);
  }
}

function listModelsInline() {
  const rows = Object.entries(MODEL_NAMES).map(([id, name]) => `${id} (${name})`);
  print('info', `Available models: ${rows.join(' · ')}`);
  print('info', 'Type /model <id> to switch.');
}

async function setModel(id) {
  const key = MODEL_ALIASES[String(id || '').toLowerCase()] || id;
  if (!MODEL_NAMES[key]) {
    print('warn', `Unknown model: ${id}.`);
    listModelsInline();
    return;
  }
  if (state.config.model !== key) {
    state.config.model = key;
    persist();
    await closeSession();
  }
  print('ok', `Model switched to: ${MODEL_NAMES[key]}`);
}

async function setMode(effort) {
  const e = String(effort || '').toLowerCase();
  if (!['low', 'high', 'max'].includes(e)) {
    openModePalette();
    return;
  }
  if (state.config.effort !== e) {
    state.config.effort = e;
    persist();
    await closeSession();
  }
  print('ok', `Reasoning effort set to: ${e}`);
}

async function setTarget(mode) {
  const key = String(mode || '').toLowerCase().replace(/[^a-z]/g, '');
  const target = key === 'zcode' ? 'ZCode' : key === 'zchat' ? 'ZChat' : null;
  if (!target) {
    print('info', `Targets: ${MODES.join(' · ')}`);
    print('info', 'Use /target ZCode or /target ZChat to switch.');
    return;
  }
  if (state.config.mode !== target) {
    await closeSession();
    state.config.mode = target;
    persist();
  }
  print('ok', `Target switched to: ${target}`);
}

function showConfig() {
  print('info', `Config file: ${CONFIG_FILE}`);
  print('info', `Target: ${state.config.mode}  ·  Headless: ${state.config.headless}  ·  Proxy: ${state.config.proxy || 'none'}`);
  print('info', `Browser: ${state.config.browser || 'autodetect'}  ·  Provider: ${state.config.provider}  ·  Captcha: ${state.config.captcha}`);
  print('info', `Model: ${currentModelName()}  ·  Effort: ${state.config.effort}  ·  Workspace: ${formatWorkspace(getWorkspace(state.config))}`);
  if (state.config.mode === 'ZCode') {
    print('info', `ZCode SSO: ${state.config.zcodeUrl}  ·  Local UI: ${state.config.zcodeLocalUrl}`);
  }
}

function showLimits() {
  return withBusy('Fetching limits & quota…', async () => {
    print('info', formatLimits(await getLimits(state.config, state.active)));
  });
}

function showModels() {
  return withBusy('Fetching models from API…', async () => {
    const models = await getModels(state.config, state.active);
    for (const m of models) {
      const mark = m.id === state.config.model ? `${C.green}●${C.reset}` : ' ';
      const efforts = m.efforts.length ? m.efforts.join('/') : '—';
      print('info', `  ${mark} ${m.id.padEnd(16)} ${m.name.padEnd(20)} ${efforts}`);
    }
  });
}

function showMe() {
  return withBusy('Fetching profile…', async () => {
    const me = await getProfile(state.config, state.active);
    print('info', `User ID: ${me.id || '—'}  Email: ${me.email || '—'}  Role: ${me.role || 'user'}`);
  });
}

async function httpRequest(parts) {
  const method = (parts[0] || 'GET').toUpperCase();
  const target = parts[1];
  if (!target) {
    print('warn', 'Usage: /http GET /api/models  or  /http POST /path \'{"key":"val"}\'');
    return;
  }
  let body = null;
  const rawBody = parts.slice(2).join(' ');
  if (rawBody) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      print('err', 'Invalid JSON body.');
      return;
    }
  }
  const res = await withBusy(`${method} ${target}`, () =>
    api(state.config, state.active, { method, path: target, body })
  );
  if (!res) return;
  print(res.status >= 400 ? 'err' : 'ok', `HTTP ${res.status} · ${target}`);
  const pretty = res.data != null ? JSON.stringify(res.data, null, 2) : res.text;
  print('info', pretty.length > 5000 ? `${pretty.slice(0, 5000)}\n… [truncated]` : pretty);
}

// ── Dispatcher ───────────────────────────────────────────────────

const HELP = COMMAND_PALETTE.map(([cmd, desc]) => `  ${cmd.padEnd(14)} ${desc}`).join('\n');

async function dispatch(line) {
  const text = String(line).trim();
  if (!text) return false;
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  if (!cmd.startsWith('/')) {
    await sendChat(text);
    return true;
  }

  switch (cmd) {
    case '/new':
      await closeSession();
      state.transcript = [];
      state.latestThought = null;
      state.scroll = 0;
      print('ok', 'New conversation started.');
      return true;

    case '/newacc':
      await runRegger(Math.max(1, Number.parseInt(parts[1], 10) || 1));
      return true;

    case '/switch': {
      if (!parts[1]) {
        openSwitchPalette();
        return true;
      }
      const acc = findAccount(state.accounts, parts[1]);
      if (!acc) {
        print('warn', `Account "${parts[1]}" not found.`);
        openSwitchPalette();
      } else {
        await selectAccount(acc);
      }
      return true;
    }

    case '/accounts':
      await listAccounts();
      return true;

    case '/status':
      return withBusy('Fetching account status…', async () => {
        if (!state.active) {
          print('warn', 'No account selected. Use /switch or /newacc.');
          return;
        }
        try {
          const [limits, profile] = await Promise.all([
            getLimits(state.config, state.active).catch(() => null),
            getProfile(state.config, state.active).catch(() => null),
          ]);
          print('info', `Account: ${state.active.email} (Role: ${profile?.role || 'user'})`);
          print('info', `Target: ${state.config.mode}  ·  Model: ${currentModelName()}  ·  Effort: ${state.config.effort}  ·  Agent: ${state.agent}`);
          if (limits) {
            print('info', formatLimits(limits));
          }
        } catch (err) {
          print('err', `Failed to fetch status: ${err.message}`);
        }
      });

    case '/mode':
      if (!parts[1]) {
        openModePalette();
      } else {
        await setMode(parts[1]);
      }
      return true;

    case '/target':
      await setTarget(parts[1]);
      return true;

    case '/zcode':
      await setTarget('ZCode');
      return true;

    case '/zchat':
      await setTarget('ZChat');
      return true;

    case '/config':
      showConfig();
      return true;

    case '/models':
    case '/model':
      await openModelsPalette();
      return true;

    case '/agents':
      openPalette('agents');
      return true;

    case '/exit':
      await shutdown();
      return true;

    default:
      print('warn', `Unknown command: ${cmd}. Available: ${COMMAND_PALETTE.map(([c]) => c).join(', ')}`);
      return true;
  }
}

// ── Interactive Input Handling ───────────────────────────────────

async function submitInput() {
  const line = state.input;
  closePalette();
  state.input = '';
  state.cursor = 0;
  state.historyIndex = -1;
  state.savedInput = '';

  if (line.trim()) {
    state.history.push(line);
    if (state.history.length > 100) state.history.shift();
  }

  render();
  await dispatch(line);
  render();
}

async function onKey(str, key) {
  if (!key) return;
  if (key.ctrl && (key.name === 'c' || key.name === 'd')) {
    await shutdown();
    return;
  }
  if (state.busy) return;

  // Shortcuts
  if (key.ctrl && key.name === 'p') {
    openPalette('commands');
    return;
  }
  if (key.name === 'tab' && key.shift) {
    openPalette('agents');
    return;
  }

  // Scrolling
  if (key.name === 'pageup') {
    scrollBy(viewport(process.stdout.rows || 30).viewHeight);
    return;
  }
  if (key.name === 'pagedown') {
    scrollBy(-viewport(process.stdout.rows || 30).viewHeight);
    return;
  }

  // Cursor Left / Right
  if (key.name === 'left') {
    if (state.cursor > 0) {
      state.cursor -= 1;
      render();
    }
    return;
  }
  if (key.name === 'right') {
    if (state.cursor < [...state.input].length) {
      state.cursor += 1;
      render();
    }
    return;
  }

  // Home / End
  if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
    state.cursor = 0;
    render();
    return;
  }
  if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
    state.cursor = [...state.input].length;
    render();
    return;
  }

  // Ctrl+U: clear line
  if (key.ctrl && key.name === 'u') {
    state.input = '';
    state.cursor = 0;
    closePalette();
    render();
    return;
  }

  // Ctrl+W: delete word
  if (key.ctrl && key.name === 'w') {
    const chars = [...state.input];
    const before = chars.slice(0, state.cursor).join('');
    const after = chars.slice(state.cursor).join('');
    const trimmed = before.replace(/\s*\S+\s*$/, '');
    state.input = trimmed + after;
    state.cursor = [...trimmed].length;
    render();
    return;
  }

  // Up / Down
  if (key.name === 'up' || key.name === 'down') {
    if (state.palette) {
      const items = paletteItems();
      if (items.length) {
        state.palette.index =
          (state.palette.index + (key.name === 'down' ? 1 : -1) + items.length) % items.length;
        render();
      }
    } else {
      // History navigation
      if (key.name === 'up') {
        if (state.historyIndex === -1 && state.history.length > 0) {
          state.savedInput = state.input;
          state.historyIndex = state.history.length - 1;
          state.input = state.history[state.historyIndex];
          state.cursor = [...state.input].length;
          render();
        } else if (state.historyIndex > 0) {
          state.historyIndex -= 1;
          state.input = state.history[state.historyIndex];
          state.cursor = [...state.input].length;
          render();
        }
      } else if (key.name === 'down') {
        if (state.historyIndex !== -1) {
          if (state.historyIndex < state.history.length - 1) {
            state.historyIndex += 1;
            state.input = state.history[state.historyIndex];
            state.cursor = [...state.input].length;
            render();
          } else {
            state.historyIndex = -1;
            state.input = state.savedInput;
            state.cursor = [...state.input].length;
            render();
          }
        }
      }
    }
    return;
  }

  // Return key
  if (state.palette && key.name === 'return') {
    const items = paletteItems();
    const picked = items[state.palette.index];
    if (!picked) return;
    if (state.palette.kind === 'agents') {
      state.agent = picked.value;
      closePalette();
      print('ok', `Agent: ${state.agent}`);
    } else if (state.palette.kind === 'models') {
      closePalette();
      await setModel(picked.value);
    } else if (state.palette.kind === 'mode') {
      closePalette();
      await setMode(picked.value);
    } else if (state.palette.kind === 'switch') {
      closePalette();
      await selectAccount(picked.value);
    } else {
      state.input = `${picked.value} `;
      state.cursor = [...state.input].length;
      closePalette();
      render();
    }
    return;
  }

  if (key.name === 'return') {
    await submitInput();
    return;
  }

  // Escape
  if (key.name === 'escape') {
    closePalette();
    state.input = '';
    state.cursor = 0;
    render();
    return;
  }

  // Backspace
  if (key.name === 'backspace') {
    if (state.cursor > 0) {
      const chars = [...state.input];
      chars.splice(state.cursor - 1, 1);
      state.input = chars.join('');
      state.cursor -= 1;
      if (state.palette?.kind === 'commands') {
        if (!state.input.startsWith('/')) {
          closePalette();
        } else {
          state.palette.filter = state.input;
          state.palette.index = 0;
        }
      }
      render();
    }
    return;
  }

  // Delete key
  if (key.name === 'delete') {
    const chars = [...state.input];
    if (state.cursor < chars.length) {
      chars.splice(state.cursor, 1);
      state.input = chars.join('');
      if (state.palette?.kind === 'commands') {
        if (!state.input.startsWith('/')) {
          closePalette();
        } else {
          state.palette.filter = state.input;
          state.palette.index = 0;
        }
      }
      render();
    }
    return;
  }

  // Tab key
  if (key.name === 'tab') {
    if (state.input.startsWith('/') && !state.input.includes(' ')) {
      const match = COMMAND_PALETTE.map(([cmd]) => cmd).find((c) =>
        c.startsWith(state.input.toLowerCase())
      );
      if (match) {
        state.input = `${match} `;
        state.cursor = [...state.input].length;
        closePalette();
        render();
      }
    }
    return;
  }

  // Thought shortcut 't'
  if (
    key.name === 'char' &&
    !state.palette &&
    state.input === '' &&
    (str === 't' || str === 'T')
  ) {
    toggleThought();
    return;
  }

  // Character typing (supports Russian, Cyrillic, UTF-8)
  if (typeof str === 'string' && str.length > 0 && !key.ctrl && !key.meta) {
    const chars = [...state.input];
    chars.splice(state.cursor, 0, ...str);
    state.input = chars.join('');
    state.cursor += [...str].length;

    if (state.input.startsWith('/')) {
      state.palette = { kind: 'commands', filter: state.input, index: 0 };
    } else if (state.palette?.kind === 'commands') {
      closePalette();
    }
    render();
  }
}

// ── Raw ANSI Input Parser ────────────────────────────────────────

const decoder = new StringDecoder('utf8');
let inputBuffer = '';
const MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const CSI_NAMES = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'tab',
  '1~': 'home',
  '3~': 'delete',
  '4~': 'end',
  '5~': 'pageup',
  '6~': 'pagedown',
  '7~': 'home',
  '8~': 'end',
};

function parseInput(str) {
  const events = [];
  let i = 0;
  while (i < str.length) {
    const tail = str.slice(i);
    const ch = str[i];
    if (ch === '\x1b') {
      if (tail === '\x1b') {
        events.push({ type: 'key', name: 'escape' });
        i += 1;
        continue;
      }
      const mouse = MOUSE_RE.exec(tail);
      if (mouse) {
        events.push({
          type: 'mouse',
          button: Number(mouse[1]),
          col: Number(mouse[2]),
          row: Number(mouse[3]),
          press: mouse[4] === 'M',
        });
        i += mouse[0].length;
        continue;
      }
      if (tail.startsWith('\x1b[')) {
        const seq = /^\x1b\[([0-9;?]*)([A-Za-z~])/.exec(tail);
        if (seq) {
          const name = CSI_NAMES[`${seq[1]}${seq[2]}`] || CSI_NAMES[seq[2]] || seq[2];
          events.push({ type: 'key', name, shift: seq[2] === 'Z' });
          i += seq[0].length;
          continue;
        }
        break;
      }
      events.push({ type: 'key', name: 'escape' });
      i += 1;
      continue;
    }

    const code = str.charCodeAt(i);
    if (code === 13 || code === 10) {
      events.push({ type: 'key', name: 'return' });
      i += 1;
      continue;
    }
    if (code === 8 || code === 127) {
      events.push({ type: 'key', name: 'backspace' });
      i += 1;
      continue;
    }
    if (code === 9) {
      events.push({ type: 'key', name: 'tab' });
      i += 1;
      continue;
    }
    if (code === 3 || code === 4 || code === 16) {
      events.push({
        type: 'key',
        name: code === 3 ? 'c' : code === 4 ? 'd' : 'p',
        ctrl: true,
      });
      i += 1;
      continue;
    }
    if (code < 32) {
      i += 1;
      continue;
    }

    let text = '';
    while (i < str.length) {
      const c = str[i];
      if (c === '\x1b') break;
      const cc = str.charCodeAt(i);
      if (cc < 32 || cc === 127) break;
      text += c;
      i += 1;
    }
    if (text) events.push({ type: 'key', name: 'char', str: text });
  }
  return { events, rest: str.slice(i) };
}

function onData(buf) {
  inputBuffer += decoder.write(buf);
  const { events, rest } = parseInput(inputBuffer);
  inputBuffer = rest;
  for (const ev of events) {
    if (ev.type === 'mouse') {
      if (!ev.press) continue;
      const r = ev.row - 1;
      const s = state.thoughtStartRow;
      const e = state.thoughtEndRow ?? s;
      if (
        ev.button === 0 &&
        s != null &&
        r >= s - 1 &&
        r <= e + 1
      ) {
        toggleThought();
      } else if (ev.button === 64) {
        scrollBy(3);
      } else if (ev.button === 65) {
        scrollBy(-3);
      }
      continue;
    }
    onKey(ev.str || '', ev).catch((err) => print('err', `Error: ${err?.stack || err}`));
  }
}

// ── Clean Exit ───────────────────────────────────────────────────

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopSpinner();
  await closeSession();
  if (IS_TTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write(`${showCursor()}${mouseOff()}${exitAltScreen()}\n`);
  }
  process.exit(0);
}

// ── Main Entry ───────────────────────────────────────────────────

async function main() {
  applyCliOverrides();
  initialize();

  if (!IS_TTY) {
    print('info', 'zai-regger · non-interactive mode. Type /help for commands.');
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    for await (const line of rl) {
      await dispatch(line);
      if (shuttingDown) break;
    }
    await shutdown();
    return;
  }

  process.stdout.write(`${enterAltScreen()}${mouseOff()}`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
  process.stdout.on('resize', () => {
    render();
  });
  process.on('SIGINT', () => shutdown());
  render();
}

main().catch((err) => {
  process.stdout.write(`${showCursor()}${mouseOff()}${exitAltScreen()}`);
  console.error(`zai-regger fatal: ${err?.stack || err}`);
  process.exit(1);
});
