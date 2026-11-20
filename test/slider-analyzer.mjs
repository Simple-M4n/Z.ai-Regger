// Synthetic-puzzle test for the slider gap analyzer.
// Draws a fake captcha background + piece in the page, exports both to data
// URLs, and checks that analyzeGap recovers the hole position.
// Run: node test/slider-analyzer.mjs
import { chromium } from 'playwright-core';
import { analyzeGap } from '../lib/slider.js';
import { resolveBrowserChannel } from '../lib/captcha.js';

let failed = 0;
const assert = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed += 1;
};

const channel = resolveBrowserChannel();
if (!channel) {
  console.error('FAIL  no browser channel');
  process.exit(1);
}

const browser = await chromium.launch({ channel, headless: true });
try {
  const page = await browser.newPage();
  await page.goto('about:blank');

  const GEN = 173;
  const synth = await page.evaluate(() => {
    const W = 320;
    const H = 160;
    const gapX = 173;
    const gapY = 55;
    const bw = 50;
    const bh = 50;
    const r = 8;

    const roundRect = (ctx, x, y, w, h, rad) => {
      ctx.beginPath();
      ctx.moveTo(x + rad, y);
      ctx.lineTo(x + w - rad, y);
      ctx.arc(x + w - rad, y + rad, rad, -Math.PI / 2, 0);
      ctx.lineTo(x + w, y + h - rad);
      ctx.arc(x + w - rad, y + h - rad, rad, 0, Math.PI / 2);
      ctx.lineTo(x + rad, y + h);
      ctx.arc(x + rad, y + h - rad, rad, Math.PI / 2, Math.PI);
      ctx.lineTo(x, y + rad);
      ctx.arc(x + rad, y + rad, rad, Math.PI, Math.PI * 1.5);
      ctx.closePath();
    };

    // smooth textured background (low-frequency, like a photo)
    const bg = document.createElement('canvas');
    bg.width = W;
    bg.height = H;
    const c = bg.getContext('2d');
    const g = c.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#3aa0e0');
    g.addColorStop(0.5, '#e8c15a');
    g.addColorStop(1, '#5fbf7a');
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);
    let seed = 42;
    const rnd = () => ((seed = (seed * 16807) % 2147483647), seed / 2147483647);
    for (let i = 0; i < 45; i++) {
      const x = rnd() * W;
      const y = rnd() * H;
      const rad = 6 + rnd() * 24;
      const rg = c.createRadialGradient(x, y, 0, x, y, rad);
      rg.addColorStop(0, `rgba(255,255,255,${(0.1 + rnd() * 0.25).toFixed(2)})`);
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = rg;
      c.beginPath();
      c.arc(x, y, rad, 0, Math.PI * 2);
      c.fill();
    }
    // photo-like fine texture (real captcha backgrounds are photos, not gradients)
    const img = c.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) {
      const nz = Math.floor((rnd() - 0.5) * 46);
      img.data[i] = Math.max(0, Math.min(255, img.data[i] + nz));
      img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + nz));
      img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + nz));
    }
    c.putImageData(img, 0, 0);

    // cutout: dark fill + strong border (shadowed hole)
    roundRect(c, gapX, gapY, bw, bh, r);
    c.fillStyle = 'rgba(0,0,0,0.5)';
    c.fill();
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(20,20,20,0.9)';
    c.stroke();

    // piece: original bright texture (pre-hole copy) with rounded alpha
    const before = document.createElement('canvas');
    before.width = W;
    before.height = H;
    before.getContext('2d').drawImage(bg, 0, 0);

    const blk = document.createElement('canvas');
    blk.width = bw;
    blk.height = bh;
    const bc = blk.getContext('2d');
    // take the piece from a DIFFERENT area first (must be the hole's original
    // content): redraw bg from gradient? simpler: copy pre-hole content —
    // but we drew bg then hole on the same canvas; rebuild a clean bg instead.
    const bgClean = document.createElement('canvas');
    bgClean.width = W;
    bgClean.height = H;
    const cc = bgClean.getContext('2d');
    const g2 = cc.createLinearGradient(0, 0, W, H);
    g2.addColorStop(0, '#3aa0e0');
    g2.addColorStop(0.5, '#e8c15a');
    g2.addColorStop(1, '#5fbf7a');
    cc.fillStyle = g2;
    cc.fillRect(0, 0, W, H);
    let seed2 = 42;
    const rnd2 = () => ((seed2 = (seed2 * 16807) % 2147483647), seed2 / 2147483647);
    for (let i = 0; i < 45; i++) {
      const x = rnd2() * W;
      const y = rnd2() * H;
      const rad = 6 + rnd2() * 24;
      const rg = cc.createRadialGradient(x, y, 0, x, y, rad);
      rg.addColorStop(0, `rgba(255,255,255,${(0.1 + rnd2() * 0.25).toFixed(2)})`);
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      cc.fillStyle = rg;
      cc.beginPath();
      cc.arc(x, y, rad, 0, Math.PI * 2);
      cc.fill();
    }
    // same photo-like noise as the background (same seed -> identical pixels)
    const img2 = cc.getImageData(0, 0, W, H);
    for (let i = 0; i < img2.data.length; i += 4) {
      const nz = Math.floor((rnd2() - 0.5) * 46);
      img2.data[i] = Math.max(0, Math.min(255, img2.data[i] + nz));
      img2.data[i + 1] = Math.max(0, Math.min(255, img2.data[i + 1] + nz));
      img2.data[i + 2] = Math.max(0, Math.min(255, img2.data[i + 2] + nz));
    }
    cc.putImageData(img2, 0, 0);

    bc.drawImage(bgClean, gapX, gapY, bw, bh, 0, 0, bw, bh);
    bc.globalCompositeOperation = 'destination-in';
    roundRect(bc, 0, 0, bw, bh, r);
    bc.fillStyle = '#000';
    bc.fill();
    bc.globalCompositeOperation = 'source-over';

    void before;
    return { bg: bg.toDataURL('image/png'), block: blk.toDataURL('image/png'), gapX };
  });

  assert('synthetic gapX constant', synth.gapX === GEN);

  const mad = await page.evaluate(analyzeGap, [synth.bg, synth.block]);
  assert(
    'ZNCC method recovers hole',
    mad.method === 'zncc' && Math.abs(mad.gapX - synth.gapX) <= 3,
    `method=${mad.method} gapX=${mad.gapX} conf=${mad.confidence} score=${mad.score}`
  );

  const edge = await page.evaluate(analyzeGap, [synth.bg, null]);
  assert(
    'edge fallback recovers hole',
    edge.method === 'edge' && Math.abs(edge.gapX - synth.gapX) <= 8,
    `method=${edge.method} gapX=${edge.gapX} conf=${edge.confidence}`
  );

  const bad = await page.evaluate(analyzeGap, ['data:image/png;base64,AAAA', null]);
  assert('garbage image -> error object', !!bad.error, bad.error || JSON.stringify(bad));
} finally {
  await browser.close();
}

process.exit(failed === 0 ? 0 : 1);
