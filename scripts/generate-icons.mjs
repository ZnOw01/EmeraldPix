/**
 * Generates the four icon PNGs required by manifest.json.
 * The SVG design is embedded inline — no external file required.
 * Run after changing the icon design:  node scripts/generate-icons.mjs
 *
 * Chrome MV3 extensions require PNG icons — SVG is not supported in manifest.json.
 */
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, '..', 'public');

// Each entry: [filename, size]
const ICONS = [
  ['icon-16x16.png', 16],
  ['icon-19x19.png', 19],
  ['icon-48x48.png', 48],
  ['icon-128x128.png', 128],
];

/**
 * Inline SVG design (128×128 master).
 * Colours: background #059669 (emerald-600), camera body #ffffff,
 *          lens rings #059669 / #ffffff, flash dot #a7f3d0 (emerald-200).
 */
const SVG_DESIGN = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <!-- Background: rounded rect, brand green -->
  <rect width="128" height="128" rx="22" ry="22" fill="#059669"/>
  <!-- Camera body -->
  <rect x="18" y="44" width="92" height="58" rx="10" ry="10" fill="#ffffff"/>
  <!-- Viewfinder notch -->
  <rect x="46" y="34" width="36" height="18" rx="7" ry="7" fill="#ffffff"/>
  <!-- Lens: outer ring (green) -->
  <circle cx="64" cy="72" r="21" fill="#059669"/>
  <!-- Lens: middle ring (white) -->
  <circle cx="64" cy="72" r="15" fill="#ffffff"/>
  <!-- Lens: pupil (green) -->
  <circle cx="64" cy="72" r="9" fill="#059669"/>
  <!-- Flash dot -->
  <circle cx="93" cy="54" r="7" fill="#a7f3d0"/>
</svg>`;

function htmlShell(size) {
  // Re-emit the SVG with explicit width/height so the viewport matches exactly.
  const sized = SVG_DESIGN
    .replace(/width="128"/, `width="${size}"`)
    .replace(/height="128"/, `height="${size}"`);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;overflow:hidden;background:transparent}</style>
</head><body>${sized}</body></html>`;
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ deviceScaleFactor: 2 });

  for (const [filename, size] of ICONS) {
    const page = await context.newPage();
    await page.setViewportSize({ width: size * 2, height: size * 2 });
    await page.setContent(htmlShell(size * 2));
    const buffer = await page.screenshot({
      clip: { x: 0, y: 0, width: size * 2, height: size * 2 },
      omitBackground: true,
    });
    // Resize to exact target via a second page pass at deviceScaleFactor 1
    const page2 = await context.newPage();
    const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
    await page2.setViewportSize({ width: size, height: size });
    await page2.setContent(`<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;overflow:hidden;background:transparent}
img{width:${size}px;height:${size}px;display:block}</style>
</head><body><img src="${dataUrl}"/></body></html>`);
    const final = await page2.screenshot({
      clip: { x: 0, y: 0, width: size, height: size },
      omitBackground: true,
    });
    const dest = resolve(PUBLIC, filename);
    writeFileSync(dest, final);
    console.log(`✓ ${filename} (${size}×${size})`);
    await page.close();
    await page2.close();
  }

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
