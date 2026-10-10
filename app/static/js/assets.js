'use strict';
// Assets the photo workspaces draw with: image loading, overlay fonts and stickers, and the printer-density
// control. Nothing here knows a page: when a font or sticker finishes loading it asks every registered
// workspace to redraw (see workspaces.js). Loads after config.js and workspaces.js, before the base scripts.
// ---------------------------------------------------------------- assets

// Resolve with a decoded Image, or reject with a translated error.
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(t('common_image_open_error')));
    img.src = src;
  });
}

// Sticker files in app/static/stickers; stickerImage() refuses any name not in this list.
const STICKERS = ['heart.svg', 'crown.svg', 'thumbs-up.svg', 'smile.svg', 'rainbow.svg', 'teddy.svg',
  'dog.svg', 'sunflower.svg', 'kiss-mark.svg', 'cake.svg', 'blossom.svg', 'joy.svg', 'confetti.svg',
  'rose.svg', 'sparkles.svg', 'party.svg', 'baby-bottle.svg', 'butterfly.svg', 'bouquet.svg',
  'cheers.svg', 'gift.svg', 'heart-eyes.svg', 'graduation.svg', 'sun.svg', 'star.svg',
  'two-hearts.svg', 'baby.svg', 'cat.svg', 'wink.svg', 'kiss.svg', 'balloon.svg',
  'sparkling-heart.svg', 'glowing-star.svg', 'ring.svg', 'smiling-hearts.svg', 'moon.svg'];
const OVERLAY_FONTS = ['Ella', 'Mila', 'Janna', 'Regina', 'Idan', 'Oleksii', 'Liam'];
// Fonts that ship no bold file: they are always drawn regular.
const NO_BOLD = new Set(['Idan']);
const fontWeight = (font, bold) => (bold && !NO_BOLD.has(font) ? 700 : 400);
// Liam (Playpen Sans Hebrew) has no Cyrillic: Russian letters fall back to Ella (Rubik), not a system font.
const FONT_FALLBACK = { Liam: 'Ella' };
// Optional extra fonts installed only on this computer (app/static/fonts/local/fonts.json, not part of
// the repository): each entry { name, regular, bold? } is registered here and added to the font picker.
// Extra fonts fall back to Ella for missing letters; without a bold file they are drawn in regular weight.
const localFontsReady = fetch('/api/local-fonts').then(r => (r.ok ? r.json() : [])).catch(() => []).then(list => {
  for (const font of list) {
    for (const [file, weight] of [[font.regular, '400'], [font.bold, '700']]) {
      if (file) document.fonts.add(new FontFace(font.name, `url("fonts/local/${encodeURIComponent(file)}")`, { weight, display: 'block' }));
    }
    if (!font.bold) NO_BOLD.add(font.name);
    FONT_FALLBACK[font.name] = 'Ella';
    OVERLAY_FONTS.push(font.name);
  }
  if (list.length) setTimeout(assetsChanged);   // redraw overlays restored before the list arrived
  return list;
});
// CSS font-family list for an overlay font, with its fallback for missing letters; unknown names use Ella.
const fontStack = font => { const name = OVERLAY_FONTS.includes(font) ? font : 'Ella';
  return FONT_FALLBACK[name] ? `"${name}", "${FONT_FALLBACK[name]}"` : `"${name}"`; };
// fontLoads/fontReady are keyed "<weight> <name>"; fontReady is what drawOverlays checks before drawing text.
const fontLoads = new Map(), fontReady = new Set(), stickerImages = new Map();
// Bumped whenever a font or sticker finishes loading; it is part of the preview cache keys so cached drawings are redone.
let assetVersion = 0;
function assetsChanged() {
  assetVersion++;
  Workspaces.all().forEach(ws => ws.redraw?.());
}
// Start loading a font (and its fallback) once; the promise is cached and fontReady is filled when done.
function ensureFont(font, bold) {
  const name = OVERLAY_FONTS.includes(font) ? font : 'Ella', weight = fontWeight(name, bold);
  const key = `${weight} ${name}`;
  if (!fontLoads.has(key)) fontLoads.set(key, Promise.all([name, FONT_FALLBACK[name]].filter(Boolean).map(f => document.fonts.load(`${weight} 40px "${f}"`))).then(() => { fontReady.add(key); assetsChanged(); }));
  return fontLoads.get(key);
}
// Cached Image for a sticker file (null if not in STICKERS); loading it triggers a redraw.
function stickerImage(file) {
  if (!STICKERS.includes(file)) return null;
  if (!stickerImages.has(file)) {
    const img = new Image();
    img.onload = assetsChanged;
    img.src = `stickers/${file}`;
    stickerImages.set(file, img);
  }
  return stickerImages.get(file);
}
// Resolve once every font and sticker used by the item's overlays is loaded, so an export never draws them half-ready.
async function readyOverlays(item) {
  await localFontsReady;
  await Promise.all((item.overlays || []).map(o => o.type === 'text' ? ensureFont(o.font, o.bold) : new Promise((resolve, reject) => {
    const img = stickerImage(o.sticker);
    if (!img) return reject(new Error(t('common_unknown_sticker')));
    if (img.complete) return img.naturalWidth ? resolve() : reject(new Error(t('common_sticker_load_error')));
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', () => reject(new Error(t('common_sticker_load_error'))), { once: true });
  })));
}

// Printer density per photo (−5…+5, default 0). Each step bends the mid-tones ~7% through a gamma
// curve; black and white stay put. Negative = lighter print, positive = darker.
// Previews show the same curve through one SVG filter per step (#density-N).
const densityGamma = d => 1 + .07 * d;
// One hidden SVG gamma filter per density step, so previews match what PhotoRender.applyDensity does to the saved file.
document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${
  [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5].map(d => `<filter id="density-${d}" color-interpolation-filters="sRGB"><feComponentTransfer>${
    ['R', 'G', 'B'].map(c => `<feFunc${c} type="gamma" exponent="${densityGamma(d)}"/>`).join('')}</feComponentTransfer></filter>`).join('')}</svg>`);

// Density control for one tab: − value + for the selected photo, and "Apply to all photos".
// Returns a sync function that shows the selected photo's value.
function densityControl(root, { item, items, refresh }) {
  root.className = 'row density';
  root.innerHTML = `<button data-d="-1" title="${t('common_lighter_print')}">−</button><output>0</output>` +
    `<button data-d="1" title="${t('common_darker_print')}">+</button><button class="ghost" data-all>${t('common_apply_all_photos')}</button>`;
  root.addEventListener('click', e => {
    const b = e.target.closest('button'), it = item(); if (!b || !it) return;
    if ('all' in b.dataset) items().forEach(x => { x.density = it.density; });
    else it.density = Math.max(-5, Math.min(5, it.density + +b.dataset.d));
    refresh();
  });
  return () => {
    const d = item()?.density || 0;
    root.querySelector('output').value = d > 0 ? '+' + d : String(d);
    root.classList.toggle('changed', d !== 0);
  };
}
const densityLabel = it => (it.density ? t('common_density_label', `${it.density > 0 ? '+' : ''}${it.density}`) : '');

// File name without its extension.
const baseName = name => name.replace(/\.[^.]+$/, '');
