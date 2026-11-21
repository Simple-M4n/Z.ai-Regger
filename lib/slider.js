// Automated Aliyun slider solving inside the real signup browser.
//
// Pipeline per attempt:
//   1. start the widget if it is collapsed ("click to start verification"),
//      then locate the slider (known selectors, then a geometry heuristic)
//   2. discover the puzzle background + piece images (img src / CSS background)
//   3. fetch image bytes (Node side, in-page fetch as fallback) -> data URLs
//   4. find the gap X: seam (piece edge content continues into the
//      background at the right spot) as primary, dark-hole rim and ZNCC /
//      edge scan as fallbacks for widget variants without a usable piece
//   5. human-like drag (probe that the drag engages, measure the piece/slider
//      ratio mid-drag, easing + jitter, random pacing)
//   6. observe pass/fail, retry with the next puzzle on failure

import { Transport, sleep } from './http.js';
import { UA } from './zai.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PASS_LABELS = [
  '验证通过', '验证成功', '滑动成功',
  'Slide completed', 'Slide successful', 'Verification passed', 'Verification successful',
];
const FAIL_LABELS = ['验证失败', '请重试', '再试一次', '尝试次数', 'Slide failed', 'Verification failed'];

const KNOWN_SLIDER_SELECTORS = [
  '#aliyunCaptcha-sliding-slider',
  '.aliyunCaptcha-sliding-slider',
  '#aliyunCaptcha-sliding-btn',
  '.aliyunCaptcha-sliding-btn',
  '#aliyunCaptcha-drag-btn',
  '.aliyunCaptcha-drag-btn',
  '#nc_1_n1z',
  '.nc_iconfont.btn_slide',
  '#nc_1__scale_text',
  '.btn_slide',
];

const rand = (n) => Math.random() * n;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Rank analysis candidates before dragging.
 *
 * A single metric's confidence is not enough: on inpainted puzzles the same
 * wrong offset can look strong to one method, while two weaker methods that
 * agree within a few pixels are usually right. Repeated accurate failures with
 * one method/candidate are demoted so the next attempt tries another peak.
 *
 * `exclude` holds candidates already tried on the *current* puzzle image.
 * `history` holds failures from earlier puzzles in the same signup.
 */
export function rankCandidates(candidates, history = [], exclude = []) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(
    (c) => c && Number.isFinite(Number(c.gapX))
  );
  if (!list.length) return [];

  const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
  const near = (a, b, tol) => Math.abs(Number(a.gapX) - Number(b.gapX)) <= tol;
  const conf = (c) => clamp01(c.confidence);

  const scored = list.map((c, idx) => {
    const base = conf(c);
    const supporters = list.filter((o, i) => i !== idx && near(o, c, 6));
    const tight = supporters.filter((o) => near(o, c, 3));
    const bestSupport = supporters.reduce((m, o) => Math.max(m, conf(o)), 0);
    const tightSupport = tight.reduce((m, o) => Math.max(m, conf(o)), 0);
    let score = base;

    // Independent agreement is worth more than a slightly louder lone peak.
    score += Math.min(0.26, bestSupport * 0.16 + (supporters.length >= 2 ? 0.1 : 0));
    if (tight.length) score += Math.min(0.08, tightSupport * 0.06);
    // A weak candidate no other method sees is almost always a false peak.
    if (!supporters.length && base < 0.55) score -= 0.18;

    for (const h of Array.isArray(history) ? history : []) {
      if (!h) continue;
      const sameMethod = !!h.method && h.method === c.method;
      const sameSpot = Number.isFinite(Number(h.gapX)) && near(h, c, 5);
      if (sameMethod && sameSpot) score -= h.accurate ? 0.55 : 0.3;
      else if (sameMethod) score -= h.accurate ? 0.32 : 0.18;
      else if (sameSpot) score -= h.accurate ? 0.15 : 0.08;
    }

    // Already tried against this exact image: make a fresh peak win.
    for (const e of Array.isArray(exclude) ? exclude : []) {
      if (!e) continue;
      if (near(e, c, 3) || (e.method && e.method === c.method && near(e, c, 8))) score -= 1;
    }

    return {
      ...c,
      rank: Number(score.toFixed(3)),
      supporters: supporters.map((o) => o.method || '?'),
    };
  });

  scored.sort(
    (a, b) =>
      b.rank - a.rank ||
      (b.confidence || 0) - (a.confidence || 0) ||
      (b.score || 0) - (a.score || 0)
  );
  return scored;
}

// ── persistent puzzle memory ──────────────────────────────────────
// Aliyun reuses a small pool of puzzle images. Remembering a gap that actually
// passed turns a previously random guess into a guaranteed hit when the same
// image appears again. Only a 128-bit perceptual hash + the gap index is
// stored — no image bytes, tokens or account data.

export const SLIDER_MEMORY_FILE = 'slider-memory.json';

export function sliderMemoryPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'Z.ai-Regger', SLIDER_MEMORY_FILE);
}

export function loadSliderMemory(file = sliderMemoryPath()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data?.items) ? { items: data.items } : { items: [] };
  } catch {
    return { items: [] };
  }
}

export function saveSliderMemory(memory, file = sliderMemoryPath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const items = (memory?.items || []).filter((x) => x && typeof x.fp === 'string');
    fs.writeFileSync(file, JSON.stringify({ v: 1, items: items.slice(-500) }, null, 2));
  } catch {
    /* memory is an optimisation — never fail registration over it */
  }
}

export function hammingHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = (parseInt(a[i], 16) ^ parseInt(b[i], 16)) >>> 0;
    while (x) {
      d += x & 1;
      x >>>= 1;
    }
  }
  return d;
}

/** Gaps already proven wrong on this image — retry them only as a last resort. */
export function rememberedFailures(memory, fp, maxDistance = 8) {
  if (!fp || !memory || !Array.isArray(memory.items)) return [];
  return memory.items
    .filter((x) => x && !(x.wins > 0) && hammingHex(fp, x.fp) <= maxDistance)
    .map((x) => ({ gapX: Number(x.gapX), method: x.method, accurate: true, outcome: 'failed' }))
    .filter((x) => Number.isFinite(x.gapX));
}

/** Best previously successful gap for this image, if one is known. */
export function rememberedGap(memory, fp, maxDistance = 8) {
  if (!fp || !memory || !Array.isArray(memory.items)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const item of memory.items) {
    if (!item || !(item.wins > 0) || !Number.isFinite(Number(item.gapX))) continue;
    const dist = hammingHex(fp, item.fp);
    if (dist <= maxDistance && (dist < bestDist || (dist === bestDist && item.wins > best.wins))) {
      best = item;
      bestDist = dist;
    }
  }
  return best ? Number(best.gapX) : null;
}

export function recordSliderOutcome(memory, fp, gapX, passed, method = null) {
  if (!fp || !memory || !Array.isArray(memory.items) || !Number.isFinite(Number(gapX))) return;
  let item = memory.items.find((x) => x && hammingHex(x.fp, fp) <= 8);
  if (!item) {
    item = { fp, wins: 0, losses: 0, gapX, method };
    memory.items.push(item);
  }
  if (passed) {
    item.wins = (item.wins || 0) + 1;
    item.gapX = Number(gapX);
    item.losses = Math.max(0, (item.losses || 0) - 1);
  } else {
    item.losses = (item.losses || 0) + 1;
  }
  item.ts = Date.now();
}

// ── pass/fail signals (any frame) ───────────────────────────────

async function scanLabels(page, labels) {
  for (const frame of page.frames()) {
    try {
      const hit = await frame.evaluate((lbs) => {
        const visible = (e) =>
          !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
        const nodes = document.querySelectorAll(
          '[class*="aliyun"], [id*="aliyun"], [class*="captcha"], [id*="captcha"], [class*="nc-"], [id*="nc_"]'
        );
        return [...nodes].some((e) => visible(e) && lbs.some((l) => (e.innerText || '').includes(l)));
      }, labels);
      if (hit) return true;
    } catch {
      /* frame may be navigating */
    }
  }
  return false;
}

export const passedSignal = (page) => scanLabels(page, PASS_LABELS);
const failedSignal = (page) => scanLabels(page, FAIL_LABELS);

// ── widget location ─────────────────────────────────────────────

export async function findSlider(page) {
  for (const frame of page.frames()) {
    for (const sel of KNOWN_SLIDER_SELECTORS) {
      try {
        const loc = frame.locator(sel);
        if ((await loc.count()) > 0 && (await loc.first().isVisible())) {
          return { frame, locator: loc.first(), selector: sel };
        }
      } catch {
        /* keep looking */
      }
    }
    // geometry heuristic: tag the draggable knob and pick it up by attribute
    try {
      const found = await frame.evaluate(() => {
        const cands = [...document.querySelectorAll('div,button,span,a,li')];
        for (const el of cands) {
          const r = el.getBoundingClientRect();
          if (r.width < 26 || r.width > 76 || r.height < 26 || r.height > 76) continue;
          if (Math.abs(r.width - r.height) > 8) continue;
          const hint = `${el.id} ${el.className}`.toLowerCase();
          if (!/slide|slider|drag|handler|knob|btn_slide|scale_text|nc_/.test(hint)) continue;
          if (/bg|img|pic|puzzle|canvas|mask|float/.test(hint)) continue;
          el.setAttribute('data-zai-slider', '1');
          return true;
        }
        return false;
      });
      if (found) {
        const loc = frame.locator('[data-zai-slider]');
        if ((await loc.count()) > 0 && (await loc.first().isVisible())) {
          return { frame, locator: loc.first(), selector: '[data-zai-slider]' };
        }
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export async function sliderVisible(page) {
  return (await findSlider(page)) !== null;
}

/**
 * The Aliyun widget starts collapsed ("Click to start verification") where
 * the knob is 0x0 — clicking the start bar opens the panel with the real
 * puzzle. Click once, keep the panel hovered, and wait for a slider with a
 * real bounding box. Returns the found slider or null after `timeoutMs`.
 */
export async function ensureWidgetReady(page, { log = console.log, timeoutMs = 20000 } = {}) {
  let deadline = Date.now() + timeoutMs;
  let clickedAt = 0;
  let clickTries = 0;
  while (Date.now() < deadline) {
    const found = await findSlider(page);
    if (found) {
      const box = await found.locator.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) return found;
    }
    // click the start bar (re-click if a click produced no panel), and once
    // clicked always leave a fresh window for the panel to open — the widget
    // may only show up late, after the original budget is already spent
    if (Date.now() - clickedAt > 4500 && clickTries < 3) {
      for (const sel of ['#aliyunCaptcha-captcha-text', '#aliyunCaptcha-start-icon', '#aliyunCaptcha-captcha-body']) {
        try {
          const loc = page.locator(sel).first();
          if ((await loc.count()) > 0 && (await loc.isVisible())) {
            await loc.click({ timeout: 3000 });
            log(`  [auto] widget start clicked: ${sel}`);
            clickedAt = Date.now();
            clickTries++;
            deadline = Math.max(deadline, clickedAt + 12000);
            break;
          }
        } catch {
          /* try the next selector */
        }
      }
    }
    try {
      const wrap = page.locator('#aliyunCaptcha-captcha-wrapper').first();
      if ((await wrap.count()) > 0) await wrap.hover({ timeout: 1500 });
    } catch {
      /* hover is best-effort */
    }
    await delay(400);
  }
  return null;
}

// ── image discovery (self-contained: runs inside the frame) ─────

export function discoverWidgetImages() {
  const out = { images: [], canvases: 0, dump: '' };
  // Pick the element that actually HOLDS the puzzle. The widget also renders a
  // bare #aliyunCaptcha-mask first (login/chat pages): choosing it as the root
  // silently hides every image. Prefer the puzzle image's own container.
  const puzzle = document.querySelector('#aliyunCaptcha-img, #aliyunCaptcha-puzzle');
  const root =
    (puzzle && puzzle.closest('#aliyunCaptcha-captcha-wrapper, #aliyunCaptcha-window-popup, #aliyunCaptcha-window-float, #aliyunCaptcha-float-wrapper')) ||
    document.querySelector('#aliyunCaptcha-captcha-wrapper, #aliyunCaptcha-window-popup, #aliyunCaptcha-window-float, #aliyunCaptcha-float-wrapper') ||
    document.querySelector('#aliyunCaptcha-window, [class*="aliyunCaptcha"], [id*="nc_"], [class*="nc-"]') ||
    document.body;

  // data URLs would blow the dump budget — keep the structure, drop the pixels
  out.dump = (root.outerHTML || '').replace(/src="data:[^"]+"/g, 'src="data:..."').slice(0, 6000);

  const push = (kind, src, w, h, hint, rect) => {
    if (!src) return;
    out.images.push({ kind, src, w, h, hint, rect });
  };

  for (const img of root.querySelectorAll('img')) {
    const r = img.getBoundingClientRect();
    push('img', img.currentSrc || img.src || '', img.naturalWidth || Math.round(r.width),
      img.naturalHeight || Math.round(r.height),
      `${img.id} ${img.className}`.trim(), { x: r.x, y: r.y, width: r.width, height: r.height });
  }

  // Canonical puzzle images can sit outside the resolved root on some pages.
  for (const id of ['aliyunCaptcha-img', 'aliyunCaptcha-puzzle']) {
    const img = document.getElementById(id);
    if (!img || root.contains(img)) continue;
    const r = img.getBoundingClientRect();
    push('img', img.currentSrc || img.src || '', img.naturalWidth || Math.round(r.width),
      img.naturalHeight || Math.round(r.height), `${img.id} ${img.className}`.trim(),
      { x: r.x, y: r.y, width: r.width, height: r.height });
  }

  for (const el of root.querySelectorAll('*')) {
    let bg = '';
    try {
      bg = getComputedStyle(el).backgroundImage || '';
    } catch {
      continue;
    }
    const m = bg.match(/url\(["']?(.*?)["']?\)/);
    if (m && m[1]) {
      const r = el.getBoundingClientRect();
      push('bg', m[1], Math.round(r.width), Math.round(r.height),
        `${el.id} ${el.className}`.trim(), { x: r.x, y: r.y, width: r.width, height: r.height });
    }
    if (el.tagName === 'CANVAS') out.canvases += 1;
  }

  return out;
}

// Map image pixels to rendered viewport pixels. The old code assumed
// scale = rect.width / naturalWidth with no offset. That breaks with
// object-fit: cover/contain (or a scaled-down image) and produced a constant
// aiming error even when gap analysis was exact. Also return the piece's real
// viewport position so the drag loop works in one coordinate system.
function puzzleGeometry() {
  const bg = document.querySelector('#aliyunCaptcha-img');
  const piece = document.querySelector('#aliyunCaptcha-puzzle');
  if (!bg || !piece) return null;
  const br = bg.getBoundingClientRect();
  const pr = piece.getBoundingClientRect();
  const nw = bg.naturalWidth || br.width;
  const nh = bg.naturalHeight || br.height;
  if (!nw || !br.width) return null;
  const fit = (getComputedStyle(bg).objectFit || 'fill').toLowerCase();
  let scale = br.width / nw;
  let offset = 0;
  if (fit === 'contain') {
    scale = Math.min(br.width / nw, br.height / nh);
    offset = (br.width - nw * scale) / 2;
  } else if (fit === 'cover') {
    scale = Math.max(br.width / nw, br.height / nh);
    offset = (br.width - nw * scale) / 2;
  } else if (fit === 'none') {
    scale = 1;
  } else if (fit === 'scale-down') {
    scale = Math.min(1, br.width / nw, br.height / nh);
    offset = (br.width - nw * scale) / 2;
  }
  return {
    scale,
    offset,
    bgLeft: br.left + offset,
    bgTop: br.top,
    bgWidth: br.width,
    bgHeight: br.height,
    pieceLeft: pr.left,
    pieceTop: pr.top,
  };
}

// ── gap analysis (self-contained: runs inside the frame) ────────
// bgDataUrl: the puzzle background (it carries a dark cut-out hole);
// blockDataUrl: the moving piece — its alpha channel IS the hole silhouette.
// Primary method slides that silhouette across the background and looks for
// the position where the pixels under it are much darker than the ring around
// it (correlating the piece CONTENT is useless: at the right spot the bright
// piece sits on the dark hole). ZNCC and a vertical-edge scan remain as
// fallbacks for widget variants without a visible hole.
// Returns { method, gapX, holeX?, pieceMinX?, bgW, bgH, score, confidence } or { error }.
export async function analyzeGap([bgDataUrl, blockDataUrl, opts]) {
  const load = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          resolve({ w: c.width, h: c.height, d: ctx.getImageData(0, 0, c.width, c.height).data });
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error('image decode failed'));
      img.src = src;
    });

  let bg;
  try {
    bg = await load(bgDataUrl);
  } catch (e) {
    return { error: `bg load: ${e.message || e}` };
  }
  let block = null;
  if (blockDataUrl) {
    try {
      block = await load(blockDataUrl);
    } catch {
      block = null;
    }
  }

  const lumOf = (d, i) => (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  const bgLum = (x, y) => {
    const i = (y * bg.w + x) * 4;
    return lumOf(bg.d, i);
  };

  // the hole signal even when it is too weak to act on (diagnostics)
  let holeProbe = null;
  let holeCurve = null;
  let seamProbe = null;
  let seamCurve = null;
  const holeExtras = () => ({
    ...(holeProbe ? { hole: holeProbe } : {}),
    ...(holeCurve ? { holeCurve } : {}),
    ...(seamProbe ? { seam: seamProbe } : {}),
    ...(seamCurve ? { seamCurve } : {}),
  });

  // Keep every plausible candidate instead of returning on the first method
  // that clears a fixed threshold. A low-contrast seam regularly wins over a
  // strong dark hole; the driver can then try the runner-up on the next
  // attempt. Candidates that agree with each other get a small bonus.
  const candidates = [];
  const addCandidate = (c) => {
    const g = Math.round(Number(c.gapX) * 10) / 10;
    if (!Number.isFinite(g)) return;
    candidates.push({ ...c, gapX: g });
  };
  const refineParabolic = (vals, i) => {
    if (i <= 0 || i >= vals.length - 1) return i;
    const a = vals[i - 1];
    const b = vals[i];
    const c = vals[i + 1];
    const den = a - 2 * b + c;
    if (!Number.isFinite(den) || Math.abs(den) < 1e-9) return i;
    const d = 0.5 * (a - c) / den;
    return i + Math.max(-1, Math.min(1, Number.isFinite(d) ? d : 0));
  };
  // 8x16 perceptual hash of the background — stable across identical puzzle
  // images and tolerant of tiny recompression differences.
  const fingerprint = (() => {
    const fw = 8;
    const fh = 16;
    const samples = [];
    for (let iy = 0; iy < fh; iy++) {
      for (let ix = 0; ix < fw; ix++) {
        const x = Math.min(bg.w - 1, Math.floor(((ix + 0.5) * bg.w) / fw));
        const y = Math.min(bg.h - 1, Math.floor(((iy + 0.5) * bg.h) / fh));
        samples.push(bgLum(x, y));
      }
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    let hex = '';
    for (let i = 0; i < samples.length; i += 4) {
      let n = 0;
      for (let j = 0; j < 4; j++) n = (n << 1) | (samples[i + j] > mean ? 1 : 0);
      hex += n.toString(16);
    }
    return hex;
  })();

  const finish = (fallback) => {
    const all = candidates.length ? candidates : [fallback];
    for (const c of all) {
      let agree = 0;
      for (const o of all) {
        if (o === c) continue;
        if (Math.abs(o.gapX - c.gapX) <= 6) agree = Math.max(agree, o.confidence || 0);
      }
      c.confidence = Number(Math.min(1, (c.confidence || 0) + agree * 0.12).toFixed(3));
    }
    all.sort((a, b) => b.confidence - a.confidence || (b.score || 0) - (a.score || 0));
    return { ...all[0], candidates: all, fingerprint, ...holeExtras() };
  };

  // Method 1: dark-hole alignment via the piece silhouette.
  if (block && block.w <= bg.w && block.h <= bg.h) {
    const W = block.w;
    const H = block.h;
    const n = W * H;
    const mask = new Uint8Array(n);
    let opaque = 0;
    let minX = W;
    let maxX = -1;
    let minY = H;
    let maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (block.d[(y * W + x) * 4 + 3] > 40) {
          mask[y * W + x] = 1;
          opaque++;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (opaque >= 80 && maxX >= minX && maxY >= minY) {
      // ring: empty cells within RING_R of the silhouette (the hole's rim)
      const RING_R = 12;
      const ring = new Uint8Array(n);
      for (let y = Math.max(0, minY - RING_R); y <= Math.min(H - 1, maxY + RING_R); y++) {
        for (let x = Math.max(0, minX - RING_R); x <= Math.min(W - 1, maxX + RING_R); x++) {
          const i = y * W + x;
          if (mask[i]) continue;
          let near = false;
          for (let dy = -RING_R; dy <= RING_R && !near; dy += 3) {
            const yy = y + dy;
            if (yy < 0 || yy >= H) continue;
            for (let dx = -RING_R; dx <= RING_R && !near; dx += 3) {
              const xx = x + dx;
              if (xx < 0 || xx >= W) continue;
              if (mask[yy * W + xx]) near = true;
            }
          }
          if (near) ring[i] = 1;
        }
      }

      const offs = Math.max(0, bg.w - W + 1);
      const delta = new Float64Array(offs);
      const ringMean = new Float64Array(offs);
      let bestX = -1;
      let bestD = -Infinity;
      for (let off = 0; off < offs; off++) {
        let sm = 0;
        let cm = 0;
        let sr = 0;
        let cr = 0;
        for (let y = minY; y <= maxY; y++) {
          const brow = y * bg.w + off;
          const row = y * W;
          for (let x = 0; x < W; x++) {
            const i = row + x;
            const l = lumOf(bg.d, (brow + x) * 4);
            if (mask[i]) {
              sm += l;
              cm++;
            } else if (ring[i]) {
              sr += l;
              cr++;
            }
          }
        }
        if (!cm || !cr) continue;
        delta[off] = sr / cr - sm / cm;
        ringMean[off] = sr / cr;
        if (delta[off] > bestD) {
          bestD = delta[off];
          bestX = off;
        }
      }

      // Seam: continuity between SOLID piece pixels and the background just
      // outside the silhouette. The old version sampled the anti-aliased edge
      // with a single luminance value; that made it easy to fool on dark or
      // blurred photos. Sample 2px inside/outside in 8 directions, compare RGB,
      // and weight boundaries with real texture higher.
      const SOLID = 180;
      const ERODE = 2;
      const solid = new Uint8Array(n);
      for (let i = 0; i < n; i++) solid[i] = block.d[i * 4 + 3] > SOLID ? 1 : 0;
      const isSolid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && solid[y * W + x] === 1;
      const pIdx = [];
      const oX = [];
      const oY = [];
      const wts = [];
      const dirs8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
      const gap = ERODE + 1;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (!isSolid(x, y)) continue;
          let interior = true;
          for (let dy = -ERODE; dy <= ERODE && interior; dy++) {
            for (let dx = -ERODE; dx <= ERODE; dx++) {
              if (!isSolid(x + dx, y + dy)) {
                interior = false;
                break;
              }
            }
          }
          if (!interior) continue;
          const pi = y * W + x;
          const gx = Math.abs(
            lumOf(block.d, (y * W + Math.min(W - 1, x + 1)) * 4) -
            lumOf(block.d, (y * W + Math.max(0, x - 1)) * 4)
          );
          const gy = Math.abs(
            lumOf(block.d, (Math.min(H - 1, y + 1) * W + x) * 4) -
            lumOf(block.d, (Math.max(0, y - 1) * W + x) * 4)
          );
          const wt = 1 + Math.min(3, (gx + gy) / 60);
          for (const [dx, dy] of dirs8) {
            const ox = x + dx * gap;
            const oy = y + dy * gap;
            if (isSolid(ox, oy)) continue;
            pIdx.push(pi * 4);
            oX.push(ox);
            oY.push(oy);
            wts.push(wt);
          }
        }
      }
      let seamMinX = -1;
      let seamMin = Infinity;
      if (pIdx.length >= 30) {
        const seamVals = new Float64Array(offs);
        for (let off = 0; off < offs; off++) {
          let s = 0;
          let wsum = 0;
          for (let j = 0; j < pIdx.length; j++) {
            const a = pIdx[j];
            const b = (oY[j] * bg.w + oX[j] + off) * 4;
            const d =
              (Math.abs(block.d[a] - bg.d[b]) +
                Math.abs(block.d[a + 1] - bg.d[b + 1]) +
                Math.abs(block.d[a + 2] - bg.d[b + 2])) /
              3;
            s += d * wts[j];
            wsum += wts[j];
          }
          const v = wsum ? s / wsum : Infinity;
          seamVals[off] = v;
          if (v < seamMin) {
            seamMin = v;
            seamMinX = off;
          }
        }
        const sorted = Array.from(seamVals).sort((a, b) => a - b);
        const seamMedian = sorted[Math.floor(sorted.length / 2)];
        const seamLift = seamMedian - seamMin;
        // the dip must be a valley: both flanks clearly above the minimum
        let side = 0;
        let sideN = 0;
        for (let off = Math.max(0, seamMinX - 14); off <= Math.min(offs - 1, seamMinX + 14); off++) {
          if (Math.abs(off - seamMinX) < 6) continue;
          side += seamVals[off];
          sideN++;
        }
        const valley = (sideN ? side / sideN : seamMedian) - seamMin;
        seamProbe = { x: seamMinX, min: Number(seamMin.toFixed(1)), lift: Number(seamLift.toFixed(1)), valley: Number(valley.toFixed(1)) };
        if (opts && opts.curve) {
          seamCurve = Array.from(seamVals, (v, i) => [i, Number(v.toFixed(2))])
            .sort((a, b) => a[1] - b[1])
            .slice(0, 12);
        }

        if (seamLift >= 12 && valley >= 6) {
          const seamSub = refineParabolic(seamVals, seamMinX);
          addCandidate({
            method: 'seam',
            gapX: seamSub,
            holeX: seamSub + minX,
            pieceMinX: minX,
            pieceMinY: minY,
            bgW: bg.w,
            bgH: bg.h,
            blockW: block.w,
            blockH: block.h,
            score: Number(seamMin.toFixed(1)),
            confidence: Number(Math.max(0, Math.min(1, Math.min(seamLift, valley * 1.2) / 45)).toFixed(3)),
          });
        }
      }

      // Shape-aware edge fit: the inpainted hole still has a hard CUT edge.
      // Align the silhouette outline with background gradient directions;
      // unlike "dark hole" this does not care whether the photo is dark or
      // bright at that spot.
      const bgGx = new Float64Array(bg.w * bg.h);
      const bgGy = new Float64Array(bg.w * bg.h);
      for (let y = 1; y < bg.h - 1; y++) {
        for (let x = 1; x < bg.w - 1; x++) {
          const i = y * bg.w + x;
          bgGx[i] = lumOf(bg.d, (i + 1) * 4) - lumOf(bg.d, (i - 1) * 4);
          bgGy[i] = lumOf(bg.d, (i + bg.w) * 4) - lumOf(bg.d, (i - bg.w) * 4);
        }
      }
      const edgeSamples = [];
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (!isSolid(x, y) || (x + y) % 2) continue;
          let nx = 0;
          let ny = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if ((dx === 0 && dy === 0) || isSolid(x + dx, y + dy)) continue;
              nx += dx;
              ny += dy;
            }
          }
          const len = Math.hypot(nx, ny);
          if (len > 0) edgeSamples.push({ x, y, nx: nx / len, ny: ny / len });
        }
      }
      if (edgeSamples.length >= 20) {
        const edgeVals = new Float64Array(offs);
        let edgeBestX = -1;
        let edgePeak = -1;
        for (let off = 0; off < offs; off++) {
          let s = 0;
          let c = 0;
          for (const p of edgeSamples) {
            const bx = p.x + off;
            if (bx < 1 || bx >= bg.w - 1) continue;
            const i = p.y * bg.w + bx;
            s += Math.abs(bgGx[i] * p.nx + bgGy[i] * p.ny);
            c++;
          }
          if (!c) continue;
          edgeVals[off] = s / c;
          if (edgeVals[off] > edgePeak) {
            edgePeak = edgeVals[off];
            edgeBestX = off;
          }
        }
        const edgeSorted = Array.from(edgeVals).sort((a, b) => b - a);
        const edgeMedian = edgeSorted[Math.floor(edgeSorted.length / 2)] || 0;
        const edgeLift = edgePeak - edgeMedian;
        if (edgeBestX >= 0 && edgePeak > 12 && edgeLift > 8) {
          const edgeSub = refineParabolic(edgeVals, edgeBestX);
          addCandidate({
            method: 'edgeFit',
            gapX: edgeSub,
            holeX: edgeSub + minX,
            pieceMinX: minX,
            pieceMinY: minY,
            bgW: bg.w,
            bgH: bg.h,
            blockW: block.w,
            blockH: block.h,
            score: Number(edgePeak.toFixed(2)),
            // Live runs: edgeFit was never correct when it outranked the other
            // methods. Keep it as a low-weight fallback only.
            confidence: Number(Math.max(0, Math.min(0.3, edgeLift / 160)).toFixed(3)),
          });
        }
      }

      if (bestX >= 0) {
        holeProbe = { x: bestX, score: Number(bestD.toFixed(1)) };
        if (opts && opts.curve) {
          holeCurve = Array.from(delta, (v, i) => [i, Number(v.toFixed(2))])
            .filter((p) => Number.isFinite(p[1]))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12);
        }
      }

      if (bestX >= 0 && bestD >= 18) {
        // refine: the threshold silhouette score has a flat top only while the
        // mask fully covers the hole -> take the centre of that plateau
        let refined = bestX;
        const lo = Math.max(0, bestX - 8);
        const hi = Math.min(offs - 1, bestX + 8);
        const scores = new Map();
        let topX = bestX;
        let topS = -2;
        for (let off = lo; off <= hi; off++) {
          const T = Math.min(150, Math.max(40, ringMean[off] - 25));
          let dm = 0;
          let cm = 0;
          let dr = 0;
          let cr = 0;
          for (let y = minY; y <= maxY; y++) {
            const brow = y * bg.w + off;
            const row = y * W;
            for (let x = 0; x < W; x++) {
              const i = row + x;
              const l = lumOf(bg.d, (brow + x) * 4);
              if (mask[i]) {
                cm++;
                if (l < T) dm++;
              } else if (ring[i]) {
                cr++;
                if (l < T) dr++;
              }
            }
          }
          if (!cm || !cr) continue;
          const s = dm / cm - dr / cr;
          scores.set(off, s);
          if (s > topS) {
            topS = s;
            topX = off;
          }
        }
        let l = topX;
        let r = topX;
        while (l - 1 >= lo && (scores.get(l - 1) ?? -2) >= topS - 0.03) l--;
        while (r + 1 <= hi && (scores.get(r + 1) ?? -2) >= topS - 0.03) r++;
        refined = Math.round((l + r) / 2);

        const sub = refineParabolic(delta, bestX);
        const gap = Number.isFinite(sub) ? Math.round((refined * 0.7 + sub * 0.3) * 10) / 10 : refined;
        addCandidate({
          method: 'hole',
          gapX: gap,
          holeX: gap + minX,
          pieceMinX: minX,
          pieceMinY: minY,
          bgW: bg.w,
          bgH: bg.h,
          blockW: block.w,
          blockH: block.h,
          score: Number(bestD.toFixed(1)),
          // Live runs showed score>=80 can still be a false peak on inpainted
          // photos, so never let the darkness heuristic claim full certainty.
          confidence: Number(Math.max(0, Math.min(0.82, (bestD - 18) / 62)).toFixed(3)),
        });
      }
    }
  }

  // Method 2: ZNCC of the opaque piece samples against the background.
  if (block && block.w >= 12 && block.w <= 130 && block.w <= bg.w && block.h <= bg.h) {
    const n = block.w * block.h;
    // opaque mask, then erode: the hole in the bg carries a dark outline /
    // shadow right at the piece boundary, so only interior samples correlate
    const mask = new Uint8Array(n);
    let opaqueCount = 0;
    for (let i = 0; i < n; i++) {
      if (block.d[i * 4 + 3] > 100) {
        mask[i] = 1;
        opaqueCount += 1;
      }
    }
    // Small pieces lose almost all usable samples at R=4; use a tighter
    // erosion there and accept a smaller sample set.
    const R = block.w < 26 ? 2 : 4; // erosion radius (px)
    const L = new Float64Array(n);
    const XS = new Int16Array(n);
    const YS = new Int16Array(n);
    let k = 0;
    let sum = 0;
    for (let by = 0; by < block.h; by++) {
      for (let bx = 0; bx < block.w; bx++) {
        if (!mask[by * block.w + bx]) continue;
        let interior = true;
        for (let dy = -R; dy <= R && interior; dy += 1) {
          const yy = by + dy;
          if (yy < 0 || yy >= block.h) {
            interior = false;
            break;
          }
          for (let dx = -R; dx <= R; dx += 1) {
            const xx = bx + dx;
            if (xx < 0 || xx >= block.w || !mask[yy * block.w + xx]) {
              interior = false;
              break;
            }
          }
        }
        if (!interior) continue;
        const bi = (by * block.w + bx) * 4;
        L[k] = lumOf(block.d, bi);
        XS[k] = bx;
        YS[k] = by;
        sum += L[k];
        k += 1;
      }
    }
    const m = k;
    if (m >= 24) {
      const mean = sum / m;
      let sA2 = 0;
      for (let j = 0; j < m; j++) {
        const A = L[j] - mean;
        sA2 += A * A;
      }
      const sigmaB = Math.sqrt(sA2 / m);
      if (sigmaB > 4) {
        // piece content is textured -> correlate
        const corrAt = (x, y, stride) => {
          let sa = 0;
          let sa2 = 0;
          let sg = 0;
          let sg2 = 0;
          let sag = 0;
          let c = 0;
          for (let j = 0; j < m; j += stride) {
            const a = L[j];
            const g = bgLum(x + XS[j], y + YS[j]);
            sa += a; sa2 += a * a;
            sg += g; sg2 += g * g;
            sag += a * g;
            c += 1;
          }
          if (c < 8) return -1;
          // Both means MUST be computed on the strided subset. Using the
          // full-sample mean here produced impossible correlations (>1) and
          // made low-texture pieces pick x=1 with confidence 1.
          const varA = sa2 - (sa * sa) / c;
          const varG = sg2 - (sg * sg) / c;
          if (varA <= 1e-6 || varG <= 1e-6) return -1;
          const cov = sag - (sa * sg) / c;
          return cov / (Math.sqrt(varA) * Math.sqrt(varG));
        };

        let best = { x: 0, y: 0, corr: -2 };
        let corrSum = 0;
        let corrCnt = 0;
        // position step 1: fine photo/pixel texture decorrelates within 1-2px,
        // so a coarse 3px grid can miss the true peak entirely. Cheap because
        // the samples themselves are strided.
        for (let y = 0; y + block.h <= bg.h; y += 1) {
          for (let x = 0; x + block.w <= bg.w; x += 1) {
            const c = corrAt(x, y, 3);
            if (c > best.corr) best = { x, y, corr: c };
            if (c > -1) {
              corrSum += c;
              corrCnt += 1;
            }
          }
        }
        const coarse = 3;
        for (let y = Math.max(0, best.y - coarse); y <= Math.min(bg.h - block.h, best.y + coarse); y++) {
          for (let x = Math.max(0, best.x - coarse); x <= Math.min(bg.w - block.w, best.x + coarse); x++) {
            const c = corrAt(x, y, 1);
            if (c > best.corr) best = { x, y, corr: c };
          }
        }

        // confidence = how far the winner stands above the average candidate
        // (a far-away probe is useless on smooth backgrounds, where the
        // correlation stays high everywhere)
        const meanCorr = corrCnt ? corrSum / corrCnt : 0;
        const confidence = Math.max(0, Math.min(1, best.corr - meanCorr));

        if (best.corr > 0.25 && confidence > 0.1) {
          addCandidate({
            method: 'zncc',
            gapX: best.x,
            gapY: best.y,
            bgW: bg.w,
            bgH: bg.h,
            blockW: block.w,
            blockH: block.h,
            score: Number(best.corr.toFixed(3)),
            confidence: Number(Math.min(1, confidence * 1.15).toFixed(3)),
          });
        }
      }
    }
  }

  // Method 3: vertical-edge energy scan on the background.
  const cols = new Float64Array(bg.w);
  const y0 = Math.floor(bg.h * 0.15);
  const y1 = Math.floor(bg.h * 0.85);
  for (let x = 1; x < bg.w - 1; x++) {
    let e = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * bg.w + x) * 4;
      e += Math.abs(lumOf(bg.d, i + 4) - lumOf(bg.d, i - 4));
    }
    cols[x] = e;
  }
  // smooth (box 5)
  const sm = new Float64Array(bg.w);
  for (let x = 2; x < bg.w - 2; x++) {
    sm[x] = (cols[x - 2] + cols[x - 1] + cols[x] + cols[x + 1] + cols[x + 2]) / 5;
  }
  let peakX = 0;
  let peak = -1;
  let sum2 = 0;
  let cnt = 0;
  const minX = block ? Math.min(block.w, 30) : 20;
  for (let x = minX; x < bg.w - 20; x++) {
    if (sm[x] > peak) {
      peak = sm[x];
      peakX = x;
    }
    sum2 += sm[x];
    cnt += 1;
  }
  const avg = cnt ? sum2 / cnt : 1;
  const fallback = {
    method: 'edge',
    gapX: peakX,
    bgW: bg.w,
    bgH: bg.h,
    blockW: block ? block.w : 0,
    blockH: block ? block.h : 0,
    score: Number(peak.toFixed(2)),
    confidence: Number(Math.max(0, Math.min(1, peak / (avg * 6 + 1e-6))).toFixed(3)),
  };
  return finish(fallback);
}

// ── image bytes -> data URL ─────────────────────────────────────

function sniffMime(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length > 4 && buf.toString('latin1', 0, 4) === 'GIF8') return 'image/gif';
  return 'image/png';
}

async function imageDataUrl(src, { transport, referer, frame }) {
  if (src.startsWith('data:')) return src;
  const url = src.startsWith('//') ? `https:${src}` : src;

  try {
    const res = await transport.request(url, {
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      },
      timeout: 15000,
    });
    if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
    const mime = String(res.headers['content-type'] || '').split(';')[0] || sniffMime(res.body);
    return `data:${mime};base64,${res.body.toString('base64')}`;
  } catch (err) {
    // in-page fallback (CORS is usually wide open for captcha assets)
    try {
      const fromPage = await frame.evaluate(async (u) => {
        try {
          const r = await fetch(u, { credentials: 'include' });
          if (!r.ok) return null;
          const buf = await r.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let bin = '';
          const CH = 0x8000;
          for (let i = 0; i < bytes.length; i += CH) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
          }
          return { mime: (r.headers.get('content-type') || '').split(';')[0], b64: btoa(bin) };
        } catch {
          return null;
        }
      }, url);
      if (fromPage && fromPage.b64) {
        return `data:${fromPage.mime || sniffMime(Buffer.from(fromPage.b64, 'base64'))};base64,${fromPage.b64}`;
      }
    } catch {
      /* fall through */
    }
    throw new Error(`image fetch failed: ${url} (${err.message})`);
  }
}

// Pick background + piece from the discovered candidates. The Aliyun DOM ids
// are authoritative; heuristics only cover renamed variants. The piece canvas
// is as tall as the image with the silhouette somewhere inside it, so its
// height must never be used to filter it out.
function pickImages(images) {
  const valid = images.filter((i) => i.src && i.rect && i.rect.width > 0);
  if (!valid.length) return { bg: null, block: null };

  const bg =
    valid.find((i) => /aliyunCaptcha-img\b/.test(i.hint || '')) ||
    valid.find((i) => !/logo|icon|btn|start/i.test(i.hint || '') && (i.w >= 150 || i.rect.width >= 150)) ||
    [...valid].sort((a, b) => b.w * b.h - a.w * a.h)[0];

  const block =
    valid.find((i) => i !== bg && /aliyunCaptcha-puzzle\b/.test(i.hint || '')) ||
    valid.find(
      (i) =>
        i !== bg &&
        // A real Aliyun puzzle strip is narrow (observed 10–52px). Wider
        // candidates are overlay/logo strips and wreck the aiming loop.
        i.w >= 8 && i.w <= Math.min(70, Math.round(bg.w * 0.25)) &&
        i.h >= 24 &&
        !/btn|button|arrow|icon|logo|start/i.test(i.hint || '')
    ) || null;

  return { bg, block };
}

// ── human-like drag ─────────────────────────────────────────────

async function boxVariants(page, frame, locator) {
  const box = await locator.boundingBox();
  if (!box) return [];
  const variants = [box];
  if (frame !== page.mainFrame()) {
    try {
      const frameEl = await frame.frameElement();
      const fbox = frameEl ? await frameEl.boundingBox() : null;
      if (fbox) {
        // if Playwright returned frame-local coordinates, shifting by the
        // iframe position yields viewport coordinates
        variants.push({
          x: fbox.x + box.x,
          y: fbox.y + box.y,
          width: box.width,
          height: box.height,
        });
      }
    } catch {
      /* single variant */
    }
  }
  return variants;
}

const DRAG_PROFILES = {
  normal: { cal: [80, 180], stepPx: 6, delay: [8, 22], settle: [120, 240] },
  slow: { cal: [100, 210], stepPx: 4, delay: [16, 34], settle: [220, 400] },
  careful: { cal: [70, 160], stepPx: 5, delay: [12, 28], settle: [200, 360] },
};

async function dragWithProbe(page, frame, locator, pieceTargetPx, log, measure, profile = 'normal') {
  const variants = await boxVariants(page, frame, locator);
  if (!variants.length) return { ok: false, reason: 'no-box' };
  // an earlier attempt may have died mid-drag — never start with the button held
  await page.mouse.up().catch(() => {});
  const original = await locator.boundingBox();
  const prof = DRAG_PROFILES[profile] || DRAG_PROFILES.normal;

  // the piece eases into place, so a single read can catch it mid-animation
  const readStable = async () => {
    let prev = null;
    for (let i = 0; i < 9; i++) {
      const now = await measure().catch(() => null);
      if (prev !== null && now !== null && Math.abs(now - prev) < 0.4) return now;
      prev = now;
      await delay(120);
    }
    return prev;
  };

  for (const box of variants) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // baseline: where the piece sits before any movement (viewport coordinates)
    const baseline = measure ? await measure().catch(() => null) : null;
    let held = false;
    try {
      await page.mouse.move(cx, cy, { steps: 6 });
      await delay(120 + rand(160));
      await page.mouse.down();
      held = true;
      await delay(140 + rand(180));
      await page.mouse.move(cx + 6 + rand(4), cy + (Math.random() - 0.5) * 2, { steps: 3 });
      await delay(80 + rand(90));

      let engaged = false;
      try {
        const after = await locator.boundingBox();
        engaged = !!after && !!original && Math.abs(after.x - original.x) >= 4;
      } catch {
        engaged = false;
      }
      if (!engaged) {
        await page.mouse.up();
        held = false;
        await delay(150);
        continue;
      }

      let sliderMax = 400;
      try {
        // keep the knob inside the track (a clamp also stops a runaway aim)
        const trackW = await locator.evaluate((el) => {
          const p = el.parentElement;
          if (!p) return 0;
          return Math.max(Math.round(p.getBoundingClientRect().width), Math.round(p.scrollWidth || 0));
        });
        if (trackW > 0) sliderMax = Math.max(20, trackW - box.width - 2);
      } catch {
        /* no clamp available */
      }

      const base = typeof baseline === 'number' ? baseline : 0;
      // The drag model works in displacement from the START position, while
      // measure() returns an absolute viewport coordinate. Mixing the two
      // makes the fitted curve predict a 2px drag for a 46px target.
      const readDisp = async () => {
        const abs = await readStable();
        return typeof abs === 'number' ? abs - base : null;
      };
      const targetRel = Math.max(0, pieceTargetPx - base);
      // Scale the calibration sweep to this target so a short drag is not
      // preceded by a huge overshoot (which looks robotic and wastes time).
      // Calibration must stay BELOW the final target: dragging far past the
      // hole and then back is a strong bot signature and Aliyun rejects it.
      const roughDx = Math.min(sliderMax, Math.max(40, targetRel * 1.6));
      const calPoints = [
        Math.min(roughDx * 0.45, prof.cal[0], targetRel * 0.45),
        Math.min(roughDx, prof.cal[1], targetRel * 0.85),
      ].filter((d, i, arr) => d >= 0 && (i === 0 || d > arr[i - 1] + 2));

      const moveToDx = async (dxTarget) => {
        const from = (await locator.boundingBox().catch(() => null)) || { x: cx - box.width / 2 };
        const startX = from.x + box.width / 2;
        const targetX = cx + dxTarget;
        const dist = Math.abs(targetX - startX);
        const steps = Math.max(8, Math.min(48, Math.round(dist / prof.stepPx) + 10));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          // asymmetric ease: fast start, slow finish, like a finger settling
          const ease = t < 0.65 ? 1 - Math.pow(1 - t / 0.65, 2.4) : 0.86 + 0.14 * ((t - 0.65) / 0.35);
          const x = startX + (targetX - startX) * ease + (Math.random() - 0.5) * 1.2;
          const y = cy + (Math.random() - 0.5) * 2.2;
          await page.mouse.move(x, y);
          await delay(prof.delay[0] + rand(prof.delay[1] - prof.delay[0]));
          if (i === Math.round(steps * 0.4) || i === Math.round(steps * 0.72)) {
            await delay(40 + rand(90)); // micro-pauses break constant-velocity signatures
          }
        }
        await page.mouse.move(targetX, cy + (Math.random() - 0.5) * 1.2, { steps: 4 });
        await delay(80 + rand(110));
      };

      // Calibrate the knob→piece curve on THIS puzzle instead of trusting a
      // constant from another screen size: p = A*dx + B*dx² through (0,0).
      const samples = [{ dx: 0, p: 0 }];
      for (const rawDx of calPoints) {
        const d = Math.min(sliderMax, rawDx);
        if (d <= samples[samples.length - 1].dx + 2) continue;
        await moveToDx(d);
        const p = measure ? await readDisp() : null;
        if (typeof p === 'number') samples.push({ dx: d, p });
      }

      let A = 0.076923;
      let B = 0.0035503;
      if (samples.length >= 3) {
        const s1 = samples[1];
        const s2 = samples[samples.length - 1];
        if (s1.dx > 0 && s2.dx > s1.dx && s1.p > 0 && s2.p > s1.p) {
          const b = (s2.p / s2.dx - s1.p / s1.dx) / (s2.dx - s1.dx);
          const a = s1.p / s1.dx - b * s1.dx;
          if (Number.isFinite(a) && Number.isFinite(b) && a > 0) {
            A = a;
            B = b;
          }
        }
      }
      const knobForPiece = (p) => {
        if (p <= 0) return 0;
        if (B > 1e-9) return (-A + Math.sqrt(A * A + 4 * B * p)) / (2 * B);
        if (A > 1e-9) return p / A;
        return 0;
      };

      let dx = knobForPiece(targetRel);
      if (!Number.isFinite(dx) || dx < 0) dx = 0;
      if (dx > sliderMax + 4) {
        log(`  [auto] target ${targetRel.toFixed(1)}px unreachable (knob max ${sliderMax}px) — re-analyse`);
        await page.mouse.up();
        held = false;
        return { ok: false, reason: 'unreachable', targetRel, sliderMax };
      }
      dx = Math.min(sliderMax, dx);

      let landed = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        await moveToDx(dx);
        if (!measure) break;
        const absP = await readStable();
        if (typeof absP !== 'number') break;
        landed = absP;
        const p = absP - base;
        const err = targetRel - p;
        log(`  [auto] aim pass ${attempt + 1}: piece=${p.toFixed(1)} target=${targetRel.toFixed(1)} knobDx=${dx.toFixed(1)}`);
        // 0.6px is within Aliyun's tolerance; use a small epsilon so floating
        // point noise does not trigger five identical extra mouse sweeps.
        if (Math.abs(err) <= 0.8) break;

        if (!samples.length || Math.abs(samples[samples.length - 1].dx - dx) > 1) {
          samples.push({ dx, p });
        }
        let next = null;
        if (samples.length >= 2) {
          const s1 = samples[samples.length - 2];
          const s2 = samples[samples.length - 1];
          if (s1.dx > 0 && s2.dx > s1.dx && s2.p > s1.p) {
            const b = (s2.p / s2.dx - s1.p / s1.dx) / (s2.dx - s1.dx);
            const a = s1.p / s1.dx - b * s1.dx;
            if (Number.isFinite(a) && Number.isFinite(b)) {
              if (b > 1e-9) next = (-a + Math.sqrt(a * a + 4 * b * targetRel)) / (2 * b);
              else if (a > 1e-9) next = targetRel / a;
            }
          }
        }
        if (!Number.isFinite(next) || next < 0 || next > sliderMax) {
          next = dx + Math.max(-12, Math.min(12, err * 0.45));
        }
        // Keep corrections mostly forward; a long backward slide while the
        // mouse is still down looks robotic to Aliyun's trajectory check.
        if (next < dx - 5) next = dx - 5;
        const nextDx = Math.max(0, Math.min(sliderMax, next));
        // The fit can saturate before the printed error reaches the threshold
        // (e.g. 0.60000000000002). Repeating the same sweep is both useless and
        // a strong bot signal, so stop when the correction no longer moves.
        if (Math.abs(nextDx - dx) < 0.25) {
          dx = nextDx;
          break;
        }
        dx = nextDx;
      }

      // final micro-correction for sub-pixel Aliyun tolerance
      if (typeof landed === 'number' && Math.abs(targetRel - landed) > 0.8 && Math.abs(targetRel - landed) < 10) {
        dx = Math.max(0, Math.min(sliderMax, dx + (targetRel - landed) * 0.35));
        await moveToDx(dx);
        landed = await readStable().catch(() => landed);
      }
      if (typeof landed === 'number') {
        const aimedAbs = base + targetRel;
        log(`  [auto] piece landed=${landed.toFixed(1)}px aimed=${aimedAbs.toFixed(1)}px err=${(aimedAbs - landed).toFixed(1)}px`);
      }
      await delay(prof.settle[0] + rand(prof.settle[1] - prof.settle[0]));
      await page.mouse.up();
      held = false;
      return { ok: true, landed };
    } finally {
      if (held) await page.mouse.up().catch(() => {});
    }
  }
  log('  [auto] drag did not engage the slider (coordinate mismatch)');
  return { ok: false, reason: 'not-engaged' };
}

// ── widget state / refresh between attempts ─────────────────────

async function captchaStatusText(page) {
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(() => {
        const root =
          document.querySelector('#aliyunCaptcha-captcha-wrapper, #aliyunCaptcha-float-wrapper') ||
          document.querySelector('[id*="aliyunCaptcha"]');
        if (!root) return '';
        return (root.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      });
      if (text) return text;
    } catch {
      /* frame may be navigating */
    }
  }
  return '';
}

// After a rejected drag Aliyun leaves an overlay/loading state and a stale
// puzzle. Clicking its own refresh button is the only reliable way to get a
// fresh pair before the next attempt; otherwise dragWithProbe sees
// `pointer-events: none` on the knob and reports a coordinate mismatch.
async function refreshPuzzle(page, log) {
  for (const frame of page.frames()) {
    try {
      const btn = frame.locator('#aliyunCaptcha-btn-refresh');
      if ((await btn.count()) === 0 || !(await btn.isVisible().catch(() => false))) continue;
      const before = await currentBgUrl(frame);
      await btn.click({ timeout: 3000 });
      log('  [auto] refreshed the puzzle via #aliyunCaptcha-btn-refresh');
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const now = await currentBgUrl(frame);
        const loading = await frame
          .evaluate(() => {
            const l = document.querySelector('#aliyunCaptcha-img-box .aliyunCaptcha-loading');
            if (!l) return false;
            const cs = getComputedStyle(l);
            return cs.display !== 'none' && cs.visibility !== 'hidden';
          })
          .catch(() => false);
        if (now && now !== before && !loading) return true;
        await delay(250);
      }
      return true;
    } catch {
      /* try the next frame */
    }
  }
  return false;
}

// After a rejection Aliyun briefly leaves the knob disabled behind an overlay.
// If that overlay clears on its own, we can try the next candidate against the
// SAME puzzle images instead of paying for a full refresh.
async function waitForInteractivePuzzle(page, log) {
  // Give Aliyun a moment to draw the rejection overlay before probing it.
  // Live runs show it normally stays up until the refresh button is pressed,
  // so keep this short — waiting many seconds only slows the retry loop.
  await delay(600);
  for (let i = 0; i < 6; i++) {
    for (const frame of page.frames()) {
      try {
        const state = await frame.evaluate(() => {
          const slider = document.querySelector(
            '#aliyunCaptcha-sliding-slider, .aliyunCaptcha-sliding-slider, #aliyunCaptcha-sliding-btn, .aliyunCaptcha-sliding-btn, #nc_1_n1z'
          );
          if (!slider) return null;
          const vis = (el) => {
            if (!el) return false;
            const s = getComputedStyle(el);
            return s.display !== 'none' && s.visibility !== 'hidden';
          };
          return {
            enabled: vis(slider) && getComputedStyle(slider).pointerEvents !== 'none',
            overlay: vis(document.querySelector('#aliyunCaptcha-overlay')),
            loading: vis(document.querySelector('#aliyunCaptcha-img-box .aliyunCaptcha-loading')),
            width: slider.getBoundingClientRect().width,
          };
        });
        if (state && state.enabled && !state.overlay && !state.loading && state.width > 0) return true;
      } catch {
        /* frame may be navigating */
      }
    }
    await delay(200);
  }
  log('  [auto] same puzzle stayed blocked — refreshing instead');
  return false;
}

// ── one full attempt ────────────────────────────────────────────

async function currentBgUrl(frame) {
  try {
    return await frame.evaluate(() => {
      const root =
        document.querySelector('#aliyunCaptcha-float-wrapper, #aliyunCaptcha-captcha-wrapper') ||
        document.querySelector(
          '#aliyunCaptcha-window-float, #aliyunCaptcha-window, [id*="aliyunCaptcha"], [class*="aliyunCaptcha"]'
        ) || document.body;
      const img =
        document.querySelector('#aliyunCaptcha-img') ||
        [...root.querySelectorAll('img')].find((i) => (i.naturalWidth || 0) >= 150);
      if (img) return img.currentSrc || img.src || '';
      for (const el of root.querySelectorAll('*')) {
        let bg = '';
        try {
          bg = getComputedStyle(el).backgroundImage || '';
        } catch {
          continue;
        }
        const m = bg.match(/url\(["']?(.*?)["']?\)/);
        if (m && m[1] && (el.getBoundingClientRect().width || 0) >= 150) return m[1];
      }
      return '';
    });
  } catch {
    return '';
  }
}

export async function solveSliderOnce({
  page,
  transport,
  referer,
  log,
  isSolved,
  attempt = 1,
  history = [],
  exclude = [],
  memory = null,
  debugDir = null,
}) {
  const found = await ensureWidgetReady(page, { log });
  if (!found) return { outcome: 'no-slider' };
  const { frame, locator, selector } = found;
  log(`  [auto] slider found: ${selector} (frame=${frame === page.mainFrame() ? 'main' : 'child'})`);

  // the panel collapses on its own if nothing hovers it — keep it open
  try {
    const wrap = page.locator('#aliyunCaptcha-captcha-wrapper').first();
    if ((await wrap.count()) > 0) await wrap.hover({ timeout: 1500 });
  } catch {
    /* best-effort */
  }

  // make sure the puzzle images are actually decoded before discovery
  try {
    await frame.waitForFunction(
      () => {
        const bgImg = document.querySelector('#aliyunCaptcha-img');
        if (!bgImg || !bgImg.src || bgImg.naturalWidth === 0) return false;
        const pc = document.querySelector('#aliyunCaptcha-puzzle');
        if (pc && (!pc.src || pc.naturalWidth === 0)) return false;
        return true;
      },
      null,
      { timeout: 8000 }
    );
  } catch {
    /* fall through — discovery reports what is there */
  }

  // Discover the pair. The widget can be mid-swap (only the logo rendered,
  // no puzzle yet) — retry instead of burning the attempt on a non-puzzle img.
  let disc = null;
  let bg = null;
  let block = null;
  const realBg = (img) => !!img && !/logo|icon|btn|start/i.test(img.hint || '') && img.w >= 150;
  for (let i = 0; i < 4; i++) {
    disc = await frame.evaluate(discoverWidgetImages);
    ({ bg, block } = pickImages(disc.images));
    if (realBg(bg) && block) break;
    log(`  [auto] puzzle images not ready (${i + 1}/4): bg=${bg ? `${bg.w}x${bg.h} "${bg.hint}"` : 'none'} block=${block ? `${block.w}x${block.h}` : 'none'}`);
    await delay(1200);
    try {
      const wrap = page.locator('#aliyunCaptcha-captcha-wrapper').first();
      if ((await wrap.count()) > 0) await wrap.hover({ timeout: 1500 });
    } catch {
      /* keep the panel open */
    }
  }
  if (!realBg(bg)) {
    return { outcome: 'no-images', dump: disc.dump };
  }
  log(`  [auto] bg=${bg.w}x${bg.h} (${bg.kind}, hint="${bg.hint}") block=${block ? `${block.w}x${block.h}` : 'none'}`);
  const bgUrl = bg.src || '';

  let bgDataUrl;
  let blockDataUrl = null;
  try {
    bgDataUrl = await imageDataUrl(bg.src, { transport, referer, frame });
    if (block) blockDataUrl = await imageDataUrl(block.src, { transport, referer, frame });
  } catch (err) {
    return { outcome: 'image-fetch-failed', error: err.message, bgUrl, dump: disc.dump };
  }

  // Diagnostics are opt-in so a normal run never pollutes the repository.
  if (process.env.ZAI_SLIDER_DEBUG) {
    try {
      const fs = await import('node:fs');
      const dir = debugDir || 'debug';
      fs.mkdirSync(dir, { recursive: true });
      if (bgDataUrl.startsWith('data:')) {
        fs.writeFileSync(`${dir}/last-bg.png`, Buffer.from(bgDataUrl.split(',')[1], 'base64'));
      }
      if (blockDataUrl && blockDataUrl.startsWith('data:')) {
        fs.writeFileSync(`${dir}/last-piece.png`, Buffer.from(blockDataUrl.split(',')[1], 'base64'));
      }
    } catch {
      /* diagnostics are best-effort */
    }
  }

  const analysis = await frame.evaluate(analyzeGap, [bgDataUrl, blockDataUrl]);
  if (analysis.error || typeof analysis.gapX !== 'number') {
    return { outcome: 'analyze-failed', error: analysis.error || 'no gapX', bgUrl, dump: disc.dump };
  }

  // Rank the candidates using independent agreement, then earlier failures.
  // Candidates already tried against this exact image are pushed to the back,
  // so a same-puzzle retry really tests a different peak.
  const all = Array.isArray(analysis.candidates) && analysis.candidates.length
    ? analysis.candidates
    : [{ method: analysis.method, gapX: analysis.gapX, confidence: analysis.confidence, score: analysis.score }];
  const knownGap = rememberedGap(memory, analysis.fingerprint);
  const priorFails = rememberedFailures(memory, analysis.fingerprint);
  const ranked = rankCandidates(all, [...history, ...priorFails], [...exclude, ...priorFails]);
  if (knownGap !== null) {
    ranked.unshift({
      method: 'memory',
      gapX: knownGap,
      confidence: 1,
      score: 1,
      rank: 1,
      supporters: [],
    });
  }
  const chosen = ranked[0];

  // Convert the gap from image pixels to viewport pixels using the ACTUAL
  // rendered image geometry. getBoundingClientRect + object-fit matters here:
  // a plain width ratio is wrong by a constant offset on cover/contain images.
  let geom = await frame.evaluate(puzzleGeometry).catch(() => null);
  if (!geom) {
    geom = await frame
      .evaluate(() => {
        const b = document.querySelector('#aliyunCaptcha-img');
        const p = document.querySelector('#aliyunCaptcha-puzzle');
        if (!b || !p) return null;
        const br = b.getBoundingClientRect();
        return {
          scale: br.width / (b.naturalWidth || br.width || 1),
          offset: 0,
          bgLeft: br.left,
          bgWidth: br.width,
          bgHeight: br.height,
          pieceLeft: p.getBoundingClientRect().left,
        };
      })
      .catch(() => null);
  }
  const scale = geom?.scale || (bg.rect ? bg.rect.width : analysis.bgW) / analysis.bgW;
  const targetLeft = geom ? geom.bgLeft + chosen.gapX * scale : chosen.gapX * scale;
  log(
    `  [auto] attempt ${attempt}: method=${chosen.method} gapX=${chosen.gapX}/${analysis.bgW}` +
    ` conf=${chosen.confidence} rank=${chosen.rank.toFixed(2)} scale=${scale.toFixed(3)} target=${targetLeft.toFixed(1)}px` +
    (ranked.length > 1
      ? ` (candidates: ${ranked.map((c) => `${c.method}@${c.gapX}[${c.rank}]`).join(', ')})`
      : '')
  );

  // piece position in the same viewport coordinate system as the mouse
  const measurePieceLeft = async () => {
    try {
      return await frame.evaluate(() => {
        const p = document.querySelector('#aliyunCaptcha-puzzle');
        if (!p) return null;
        return p.getBoundingClientRect().left;
      });
    } catch {
      return null;
    }
  };

  const accurateFailures = history.filter((h) => h.accurate).length;
  const profile = accurateFailures >= 2 ? 'careful' : accurateFailures === 1 ? 'slow' : 'normal';
  const beforeBg = await currentBgUrl(frame);
  const drag = await dragWithProbe(page, frame, locator, targetLeft, log, measurePieceLeft, profile).catch((e) => {
    log(`  [auto] drag error: ${e.message}`);
    return { ok: false, reason: 'error' };
  });
  if (!drag || !drag.ok) {
    return {
      outcome: drag?.reason === 'unreachable' ? 'unreachable' : 'drag-failed',
      analysis,
      chosen,
      candidates: ranked,
      bgUrl,
      targetLeft,
      dump: disc.dump,
    };
  }

  // Observe pass/fail. A closed widget alone is NOT a pass: during a failed
  // signup the panel can vanish during navigation. Wait for the page hook
  // (`isSolved`) or an explicit success label before declaring victory.
  const deadline = Date.now() + 8000;
  let lastStatus = '';
  let verdict = 'unknown';
  while (Date.now() < deadline) {
    if (isSolved && isSolved()) {
      verdict = 'passed';
      break;
    }
    if (await passedSignal(page)) {
      verdict = 'passed';
      break;
    }
    const fail = await failedSignal(page);
    const status = await captchaStatusText(page);
    if (status && status !== lastStatus) {
      lastStatus = status;
      log(`  [auto] widget: "${status}"`);
    }
    if (fail) {
      verdict = 'failed';
      break;
    }
    const nowBg = await currentBgUrl(frame);
    if (beforeBg && nowBg && nowBg !== beforeBg) {
      verdict = 'failed';
      break;
    }
    if (!(await sliderVisible(page))) {
      const goneUntil = Date.now() + 3000;
      while (Date.now() < goneUntil) {
        if (isSolved && isSolved() || (await passedSignal(page))) {
          verdict = 'passed';
          break;
        }
        await delay(200);
      }
      if (verdict !== 'passed') verdict = 'failed';
      break;
    }
    await delay(250);
  }
  const err = typeof drag.landed === 'number' ? Math.abs(targetLeft - drag.landed) : null;
  return {
    outcome: verdict,
    analysis,
    fingerprint: analysis.fingerprint,
    chosen,
    candidates: ranked,
    bgUrl,
    targetLeft,
    landed: drag.landed,
    accurate: err !== null && err <= 2,
    dump: disc.dump,
  };
}

// ── multi-attempt driver ────────────────────────────────────────

export async function solveSliderAuto({
  page,
  proxy = null,
  insecure = false,
  onRetry = null,
  referer,
  attempts = 6,
  log = console.log,
  isSolved = () => false,
  debugDir = 'debug',
}) {
  const transport = new Transport({ proxy, timeout: 15000, insecure, onRetry });
  const memory = loadSliderMemory();
  const finish = (result) => {
    saveSliderMemory(memory);
    return result;
  };

  let last = { outcome: 'not-run' };
  const history = [];
  // Candidates already tried against the currently displayed image. When two
  // methods disagree we test their other peak before paying for a refresh.
  let samePuzzle = { bgUrl: null, keys: [], tries: 0 };
  for (let i = 1; i <= attempts; i++) {
    if (isSolved()) return finish('passed');
    // make sure the widget is up (click-to-start + hover if it is collapsed)
    if (!(await sliderVisible(page))) {
      log('  [auto] widget not visible — starting it');
      const ready = await ensureWidgetReady(page, { log, timeoutMs: 30000 });
      if (!ready) {
        log('  [auto] widget still not visible');
        last = { outcome: 'no-slider' };
        break;
      }
    }

    log(`  [auto] attempt ${i}/${attempts}`);
    let result;
    try {
      result = await solveSliderOnce({
        page,
        transport,
        referer,
        log,
        isSolved,
        attempt: i,
        history,
        exclude: [...samePuzzle.keys],
        memory,
        debugDir,
      });
    } catch (err) {
      result = { outcome: 'error', error: err.message };
    }
    last = result;

    const solvedNow = result.outcome === 'passed' || isSolved();
    if (result.chosen && result.fingerprint) {
      recordSliderOutcome(
        memory,
        result.fingerprint,
        result.chosen.gapX,
        solvedNow,
        result.chosen.method
      );
    }
    if (solvedNow) return finish('passed');

    const key = result.chosen
      ? { method: result.chosen.method, gapX: result.chosen.gapX, accurate: !!result.accurate }
      : null;
    if (key) {
      history.push({ ...key, outcome: result.outcome });
      // The widget can swap the image on its own after a rejection; only keep
      // the same-puzzle exclusion list when the URL is really unchanged.
      if (samePuzzle.bgUrl && result.bgUrl && result.bgUrl !== samePuzzle.bgUrl) {
        samePuzzle = { bgUrl: result.bgUrl, keys: [], tries: 0 };
      }
      samePuzzle.bgUrl = result.bgUrl || samePuzzle.bgUrl;
      samePuzzle.keys.push(key);
      samePuzzle.tries += 1;
    } else if (result.bgUrl) {
      samePuzzle.bgUrl = result.bgUrl;
    }

    log(`  [auto] attempt ${i}: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`);
    const status = await captchaStatusText(page);
    if (status) log(`  [auto] widget says: "${status}"`);

    // diagnostics: opt-in so normal runs never write debug files
    if (process.env.ZAI_SLIDER_DEBUG) {
      try {
        fs.mkdirSync(debugDir, { recursive: true });
        const shot = path.join(debugDir, `slider-attempt-${i}.png`);
        await page.screenshot({ path: shot });
        log(`  [auto] screenshot: ${shot}`);
        for (const name of ['bg', 'piece']) {
          const src = path.join(debugDir, `last-${name}.png`);
          const dst = path.join(debugDir, `attempt-${i}-${name}.png`);
          if (fs.existsSync(src)) fs.copyFileSync(src, dst);
        }
        if (result.dump) {
          const dumpPath = path.join(debugDir, `widget-attempt-${i}.html`);
          fs.writeFileSync(dumpPath, result.dump, 'utf8');
          log(`  [auto] widget html: ${dumpPath}`);
        }
      } catch {
        /* diagnostics are best-effort */
      }
    }

    if (result.outcome === 'no-slider' || result.outcome === 'no-images') break;

    const tried = (result.candidates || []).filter((c) =>
      !samePuzzle.keys.some(
        (k) =>
          Math.abs((Number(k.gapX) || -999) - (Number(c.gapX) || 999)) <= 3 ||
          (k.method && k.method === c.method &&
            Math.abs((Number(k.gapX) || -999) - (Number(c.gapX) || 999)) <= 8)
      )
    );
    if (tried.length && samePuzzle.tries < 3 && (await waitForInteractivePuzzle(page, log))) {
      log(
        `  [auto] trying another peak on this puzzle: ${tried
          .slice(0, 3)
          .map((c) => `${c.method}@${c.gapX}`)
          .join(', ')}`
      );
      await delay(300 + rand(300));
      continue;
    }

    // Aliyun keeps the old puzzle + an overlay after a rejection — clicking
    // its refresh button gives the next attempt fresh images and an enabled
    // knob instead of `pointer-events: none`.
    await refreshPuzzle(page, log);
    samePuzzle = { bgUrl: null, keys: [], tries: 0 };
    await delay(800 + rand(700));
  }

  return finish(last.outcome === 'passed' ? 'passed' : `auto solve failed (${last.outcome})`);
}
