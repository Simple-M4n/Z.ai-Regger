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

      // Seam: mean |piece edge pixel - bg just OUTSIDE the silhouette|.
      // The piece was cut out of the background, so at the correct x its edge
      // content continues into the surroundings and the step across the
      // silhouette boundary is minimal. Unlike darkness/outline this does not
      // get stolen by a black-haired subject or a dark backdrop (measured on
      // real pairs: seam found the exact fit where darkness and edge missed).
      const pIdx = [];
      const oX = [];
      const oY = [];
      const dirs4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          if (!mask[y * W + x]) continue;
          for (const [dx, dy] of dirs4) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || xx >= W || yy < 0 || yy >= H || mask[yy * W + xx]) continue;
            pIdx.push(y * W + x);
            oX.push(xx);
            oY.push(yy);
          }
        }
      }
      let seamMinX = -1;
      let seamMin = Infinity;
      if (pIdx.length >= 30) {
        const seamVals = new Float64Array(offs);
        for (let off = 0; off < offs; off++) {
          let s = 0;
          for (let j = 0; j < pIdx.length; j++) {
            const pl = lumOf(block.d, pIdx[j] * 4);
            const bl = lumOf(bg.d, (oY[j] * bg.w + (oX[j] + off)) * 4);
            s += Math.abs(pl - bl);
          }
          const v = s / pIdx.length;
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

        if (seamLift >= 15 && valley >= 8) {
          return {
            method: 'seam',
            gapX: seamMinX,
            holeX: seamMinX + minX,
            pieceMinX: minX,
            pieceMinY: minY,
            bgW: bg.w,
            bgH: bg.h,
            blockW: block.w,
            blockH: block.h,
            score: Number(seamMin.toFixed(1)),
            confidence: Number(Math.max(0, Math.min(1, Math.min(seamLift, valley * 1.5) / 40)).toFixed(3)),
            ...holeExtras(),
          };
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

      if (bestX >= 0 && bestD >= 25) {
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

        return {
          method: 'hole',
          gapX: refined,
          holeX: refined + minX,
          pieceMinX: minX,
          pieceMinY: minY,
          bgW: bg.w,
          bgH: bg.h,
          blockW: block.w,
          blockH: block.h,
          score: Number(bestD.toFixed(1)),
          confidence: Number(Math.max(0, Math.min(1, (bestD - 25) / 55)).toFixed(3)),
          ...holeExtras(),
        };
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
    const R = 4; // erosion radius (px)
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
    if (m >= 60) {
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
          let sg = 0;
          let sg2 = 0;
          let sAg = 0;
          let c = 0;
          for (let j = 0; j < m; j += stride) {
            const g = bgLum(x + XS[j], y + YS[j]);
            sg += g;
            sg2 += g * g;
            sAg += (L[j] - mean) * g;
            c += 1;
          }
          if (c < 8) return -1;
          const varG = sg2 - (sg * sg) / c;
          if (varG <= 1e-6) return -1;
          return sAg / (Math.sqrt(sA2) * Math.sqrt(varG));
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

        if (best.corr > 0.3 && confidence > 0.15) {
          return {
            method: 'zncc',
            gapX: best.x,
            gapY: best.y,
            bgW: bg.w,
            bgH: bg.h,
            blockW: block.w,
            blockH: block.h,
            score: Number(best.corr.toFixed(3)),
            confidence: Number(confidence.toFixed(3)),
            ...holeExtras(),
          };
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
  return {
    method: 'edge',
    gapX: peakX,
    bgW: bg.w,
    bgH: bg.h,
    blockW: block ? block.w : 0,
    blockH: block ? block.h : 0,
    score: Number(peak.toFixed(2)),
    confidence: Number(Math.max(0, Math.min(1, peak / (avg * 6 + 1e-6))).toFixed(3)),
    ...holeExtras(),
  };
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

async function dragWithProbe(page, frame, locator, pieceTargetPx, log, measure) {
  const variants = await boxVariants(page, frame, locator);
  if (!variants.length) return false;
  // an earlier attempt may have died mid-drag — never start with the button held
  await page.mouse.up().catch(() => {});
  const original = await locator.boundingBox();

  // the piece eases into place, so a single read can catch it mid-animation
  const readStable = async () => {
    let prev = null;
    for (let i = 0; i < 7; i++) {
      const now = await measure().catch(() => null);
      if (prev !== null && now !== null && Math.abs(now - prev) < 0.7) return now;
      prev = now;
      await delay(140);
    }
    return prev;
  };

  for (const box of variants) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // baseline: where the piece sits before any movement
    const baseline = measure ? await measure().catch(() => null) : null;
    let held = false;
    try {
      await page.mouse.move(cx, cy, { steps: 6 });
      await delay(60 + rand(80));
      await page.mouse.down();
      held = true;
      await delay(50 + rand(70));
      await page.mouse.move(cx + 9, cy + (Math.random() - 0.5) * 2, { steps: 3 });
      await delay(70);

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

      // The knob -> piece mapping is NOT 1:1 (measured on the live widget:
      // piece(dx) = 0.076923*dx + 0.0035503*dx^2), so aiming with a mid-drag
      // ratio lands far off. Aim with the fitted model first, then close the
      // loop on the real piece position until it sits on the gap.
      const MODEL_A = 0.076923;
      const MODEL_B = 0.0035503;
      const knobForPiece = (p) => {
        if (p <= 0) return 0;
        return (-MODEL_A + Math.sqrt(MODEL_A * MODEL_A + 4 * MODEL_B * p)) / (2 * MODEL_B);
      };

      let sliderMax = 400;
      try {
        // keep the knob inside the track (a clamp also stops a runaway aim)
        const trackW = await locator.evaluate((el) => {
          const p = el.parentElement;
          return p ? Math.round(p.getBoundingClientRect().width) : 0;
        });
        if (trackW > 0) sliderMax = Math.max(20, trackW - box.width - 2);
      } catch {
        /* no clamp available */
      }

      const base = typeof baseline === 'number' ? baseline : 0;
      const targetRel = Math.max(0, pieceTargetPx - base);
      let dx = Math.min(sliderMax, knobForPiece(targetRel));

      const moveToDx = async (dxTarget) => {
        const from = (await locator.boundingBox().catch(() => null)) || { x: cx - box.width / 2 };
        const startX = from.x + box.width / 2;
        const targetX = cx + dxTarget;
        const dist = Math.abs(targetX - startX);
        const steps = Math.max(6, Math.min(34, Math.round(dist / 6) + 8));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
          const x = startX + (targetX - startX) * ease + (Math.random() - 0.5) * 1.4;
          const y = cy + (Math.random() - 0.5) * 2.4;
          await page.mouse.move(x, y);
          await delay(8 + rand(14));
        }
        await page.mouse.move(targetX, cy + (Math.random() - 0.5) * 1.5, { steps: 3 });
        await delay(60 + rand(90));
      };

      let landed = null;
      const samples = [];
      for (let attempt = 0; attempt < 5; attempt++) {
        await moveToDx(dx);
        if (!measure) break;
        const p = await readStable();
        if (typeof p !== 'number') break;
        landed = p;
        const err = targetRel - p;
        log(`  [auto] aim pass ${attempt + 1}: piece=${p.toFixed(1)} target=${targetRel.toFixed(1)} knobDx=${dx.toFixed(1)}`);
        if (Math.abs(err) <= 2) break;

        // Fit the real knob→piece curve through the measured points instead of
        // multiplying by target/piece (that oscillates: 260→2→256→10 live).
        // The widget is a convex quadratic through (0,0): p = A*dx + B*dx².
        if (!samples.length || Math.abs(samples[samples.length - 1].dx - dx) > 1) {
          samples.push({ dx, p });
        }
        let next = null;
        if (samples.length >= 2) {
          const s1 = samples[samples.length - 2];
          const s2 = samples[samples.length - 1];
          const denom = s1.dx * s2.dx * (s1.dx - s2.dx);
          if (Math.abs(denom) > 1e-6) {
            const B = (s1.p * s2.dx - s2.p * s1.dx) / denom;
            const A = (s1.p - B * s1.dx * s1.dx) / s1.dx;
            if (Number.isFinite(A) && Number.isFinite(B)) {
              if (B > 1e-9) next = (-A + Math.sqrt(A * A + 4 * B * targetRel)) / (2 * B);
              else if (A > 1e-9) next = targetRel / A;
            }
          }
        }
        if (!Number.isFinite(next) || next < 0 || next > sliderMax) {
          // damped fallback while we only have one sample
          next = dx * Math.max(0.25, Math.min(4, targetRel / Math.max(1, p)));
        }
        dx = Math.max(0, Math.min(sliderMax, next));
      }
      if (typeof landed === 'number') {
        log(`  [auto] piece landed=${landed.toFixed(1)}px aimed=${pieceTargetPx.toFixed(1)}px err=${(pieceTargetPx - landed).toFixed(1)}px`);
      }
      await page.mouse.up();
      held = false;
      return true;
    } finally {
      if (held) await page.mouse.up().catch(() => {});
    }
  }
  log('  [auto] drag did not engage the slider (coordinate mismatch)');
  return false;
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

export async function solveSliderOnce({ page, transport, referer, log, isSolved }) {
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

  let bgDataUrl;
  let blockDataUrl = null;
  try {
    bgDataUrl = await imageDataUrl(bg.src, { transport, referer, frame });
    if (block) blockDataUrl = await imageDataUrl(block.src, { transport, referer, frame });
  } catch (err) {
    return { outcome: 'image-fetch-failed', error: err.message, dump: disc.dump };
  }

  // keep the puzzle pair for offline analysis of a failed attempt
  try {
    const fs = await import('node:fs');
    fs.mkdirSync('debug', { recursive: true });
    if (bgDataUrl.startsWith('data:')) {
      fs.writeFileSync('debug/last-bg.png', Buffer.from(bgDataUrl.split(',')[1], 'base64'));
    }
    if (blockDataUrl && blockDataUrl.startsWith('data:')) {
      fs.writeFileSync('debug/last-piece.png', Buffer.from(blockDataUrl.split(',')[1], 'base64'));
    }
  } catch {
    /* diagnostics are best-effort */
  }

  const analysis = await frame.evaluate(analyzeGap, [bgDataUrl, blockDataUrl]);
  if (analysis.error || typeof analysis.gapX !== 'number') {
    return { outcome: 'analyze-failed', error: analysis.error || 'no gapX', dump: disc.dump };
  }

  const renderedW = bg.rect ? bg.rect.width : analysis.bgW;
  const scale = renderedW / analysis.bgW;
  const pieceTarget = analysis.gapX * scale;
  log(
    `  [auto] method=${analysis.method} gapX=${analysis.gapX}/${analysis.bgW} conf=${analysis.confidence}` +
    ` score=${analysis.score} scale=${scale.toFixed(2)} target=${pieceTarget.toFixed(1)}px`
  );

  // where the piece currently sits (rendered px), read during the drag
  const measurePieceLeft = async () => {
    try {
      return await frame.evaluate(() => {
        const p = document.querySelector('#aliyunCaptcha-puzzle');
        if (!p) return null;
        const cs = getComputedStyle(p);
        const left = parseFloat(cs.left) || 0;
        const m = /translateX\((-?[\d.]+(?:e-?\d+)?)px\)/.exec(cs.transform || '');
        return left + (m ? parseFloat(m[1]) : 0);
      });
    } catch {
      return null;
    }
  };

  const beforeBg = await currentBgUrl(frame);
  const ok = await dragWithProbe(page, frame, locator, pieceTarget, log, measurePieceLeft).catch((e) => {
    log(`  [auto] drag error: ${e.message}`);
    return false;
  });
  if (!ok) return { outcome: 'drag-failed', analysis, dump: disc.dump };

  // observe: pass signal, widget close, new puzzle (fail), explicit fail text.
  // FAIL is checked BEFORE "slider gone": a wrong drag leaves the panel open
  // with "Verification failed, please try again!" and the panel closing later
  // must not be misread as a pass (that false positive happened live).
  const deadline = Date.now() + 8000;
  let lastStatus = '';
  while (Date.now() < deadline) {
    if (isSolved && isSolved()) return { outcome: 'passed', analysis };
    if (await passedSignal(page)) return { outcome: 'passed', analysis };
    const fail = await failedSignal(page);
    const status = await captchaStatusText(page);
    if (status && status !== lastStatus) {
      lastStatus = status;
      log(`  [auto] widget: "${status}"`);
    }
    if (fail) return { outcome: 'failed', analysis };
    const nowBg = await currentBgUrl(frame);
    if (beforeBg && nowBg && nowBg !== beforeBg) return { outcome: 'failed', analysis };
    if (!(await sliderVisible(page))) return { outcome: 'passed', analysis };
    await delay(250);
  }
  return { outcome: 'unknown', analysis };
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
  const fs = await import('node:fs');
  const path = await import('node:path');

  let last = { outcome: 'not-run' };
  for (let i = 1; i <= attempts; i++) {
    if (isSolved()) return 'passed';
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
      result = await solveSliderOnce({ page, transport, referer, log, isSolved });
    } catch (err) {
      result = { outcome: 'error', error: err.message };
    }
    last = result;

    if (result.outcome === 'passed' || isSolved()) return 'passed';

    log(`  [auto] attempt ${i}: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`);
    const status = await captchaStatusText(page);
    if (status) log(`  [auto] widget says: "${status}"`);

    // diagnostics: screenshot + widget HTML dump
    try {
      fs.mkdirSync(debugDir, { recursive: true });
      const shot = path.join(debugDir, `slider-attempt-${i}.png`);
      await page.screenshot({ path: shot });
      log(`  [auto] screenshot: ${shot}`);
      // preserve the exact pair used by this attempt before the next one
      // overwrites debug/last-bg.png / last-piece.png
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

    if (result.outcome === 'no-slider' || result.outcome === 'no-images') break;
    // Aliyun keeps the old puzzle + an overlay after a rejection — clicking
    // its refresh button gives the next attempt fresh images and an enabled
    // knob instead of `pointer-events: none`.
    await refreshPuzzle(page, log);
    await delay(800 + rand(700));
  }

  return last.outcome === 'passed' ? 'passed' : `auto solve failed (${last.outcome})`;
}
