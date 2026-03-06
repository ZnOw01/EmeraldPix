/**
 * Verifies that the four icon PNGs exist and have the expected pixel colours.
 * Run: node scripts/verify-icons.mjs
 *
 * Images are loaded as base64 data-URLs to avoid cross-origin restrictions
 * that occur when a file:// URL is loaded inside page.evaluate().
 */
import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const sizes = [16, 19, 48, 128];

// --- 1. Existence check -------------------------------------------------
for (const s of sizes) {
  const f = resolve(ROOT, 'public', `icon-${s}x${s}.png`);
  if (!existsSync(f)) {
    console.error(`MISSING: ${f}`);
    process.exit(1);
  }
}
console.log('✓ All icon files present');

// --- 2. Read each file as a base64 data URL ----------------------------
const dataUrls = {};
for (const s of sizes) {
  const buf = readFileSync(resolve(ROOT, 'public', `icon-${s}x${s}.png`));
  dataUrls[s] = `data:image/png;base64,${buf.toString('base64')}`;
}

const browser = await chromium.launch();

// --- 3. Save a visual preview so you can open it in any image viewer ---
{
  const page = await browser.newPage();
  await page.setViewportSize({ width: 700, height: 260 });
  const cards = sizes.map(s => {
    const display = Math.max(s, 48);
    return `<div class="card">
      <div class="checker">
        <img src="${dataUrls[s]}" width="${display}" height="${display}"
             style="image-rendering:pixelated;display:block">
      </div>
      <span>${s}&times;${s}</span>
    </div>`;
  }).join('');
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { margin:24px; font-family:sans-serif; background:#f0f0f0;
           display:flex; gap:24px; align-items:flex-end; }
    .card { display:flex; flex-direction:column; align-items:center; gap:8px; }
    .card span { font-size:12px; color:#555; }
    .checker { background:repeating-conic-gradient(#ccc 0% 25%,#fff 0% 50%)
               0 0/10px 10px; padding:12px; border-radius:8px; display:inline-block; }
  </style></head><body>${cards}</body></html>`);
  await page.screenshot({ path: resolve(ROOT, 'dist', 'icon-preview.png') });
  await page.close();
  console.log('✓ Preview saved → dist/icon-preview.png');
}

// --- 4. Pixel-colour checks on the 128×128 icon -------------------------
{
  const page = await browser.newPage();
  await page.setViewportSize({ width: 200, height: 200 });
  await page.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0}</style></head>
<body><img id="icon" src="${dataUrls[128]}" width="128" height="128"></body></html>`);
  await page.waitForSelector('#icon');

  const result = await page.evaluate(() => {
    const img = document.getElementById('icon');
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return {
      topLeftCorner: px(2, 2),   // Outside rounded-rect → transparent
      bgTopCenter: px(64, 10), // Inside background → brand green
      imgCenter: px(64, 64), // Camera body centre
    };
  });

  await page.close();

  console.log('\n--- Pixel analysis (128×128) ---');
  const pass = (label, px, cond, expected) => {
    const ok = cond(px);
    console.log(`${ok ? '✓' : '✗'} ${label}: rgba(${px.join(',')}) — expected ${expected}`);
    return ok;
  };

  let allOk = true;
  allOk = pass(
    'Top-left corner  (transparent outside rounded-rect)',
    result.topLeftCorner,
    px => px[3] < 30,
    'alpha < 30',
  ) && allOk;
  allOk = pass(
    'Background top-centre (brand green)',
    result.bgTopCenter,
    px => px[1] > 80 && px[0] < px[1],
    'green channel dominant',
  ) && allOk;

  console.log('\nRaw pixel dump (for reference):');
  for (const [k, v] of Object.entries(result)) {
    console.log(`  ${k}: rgba(${v.join(',')})`);
  }

  if (allOk) {
    console.log('\n✓ All checks passed');
  } else {
    console.log('\n✗ Some checks failed — regenerate: node scripts/generate-icons.mjs');
    process.exit(1);
  }
}

await browser.close();
