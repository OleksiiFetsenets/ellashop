'use strict';
// Shared helpers for the photo tabs: image loading, font and sticker loading, density filters and order state.
// Drawing, text layout and export live in PhotoEditor and PhotoRender (photo-editor.js, photo-render.js).
// Loads after config.js; history, editors, and tab scripts use these helpers.
// ---------------------------------------------------------------- helpers

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
  if (typeof prints !== 'undefined') { prints.preview?.redraw(); printsGrid?.update(); }
  if (typeof canvasPrints !== 'undefined') { canvasPrints.preview?.redraw(); canvasGrid?.update(); }
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
// Frame for drawOverlays: the photo's rectangle plus mmToPx (canvas px per mm of output width).
function overlayFrame(item, front) {
  return { ...front, mmToPx: front.w / PhotoEditor.outMM(item).w };
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

function setStatus(el, msg, err = false) { el.textContent = msg; el.classList.toggle('err', err); }

// Order state. orderEpoch (and workspaces[tab].epoch for the Canvas/Passport/Collage workspaces) is bumped
// whenever the open order or workspace is replaced; async work that started earlier compares the epoch it
// captured and drops its result if it changed. saveTimer/saveChain debounce and serialise saves;
// loading is true while a saved state is being restored (so restoring does not trigger a save).
const orderInput = $('#order-name');
const orderPicker = $('#order-picker');
let currentOrder = null, orderEpoch = 0, saveTimer = 0, saveChain = Promise.resolve(), loadingOrder = false;
const workspaces = {
  canvas: { epoch: 0, timer: 0, chain: Promise.resolve(), loading: false },
  passport: { epoch: 0, timer: 0, chain: Promise.resolve(), loading: false },
  collage: { epoch: 0, timer: 0, chain: Promise.resolve(), loading: false },
};
// Order ids start with YYYYMMDD and a time (HHMM at offsets 9-13); turned into "YYYY-MM-DD_HH-MM" for folder names.
const dateFolder = id => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}_${id.slice(9, 11)}-${id.slice(11, 13)}`;
// Export folder name: the typed order name, else the date folder of the open order.
const orderName = () => orderInput.value || (currentOrder ? dateFolder(currentOrder.id) : '');
const orderUrl = (id, file) => `/orders/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`;
const workspaceUrl = (tab, file) => `/workspace/${tab}/files/${encodeURIComponent(file)}`;
const rememberOrder = id => { try { localStorage.setItem('ellashop-order-id', id); } catch (_) { /* storage may be unavailable */ } };
const lastOrder = () => { try { return localStorage.getItem('ellashop-order-id'); } catch (_) { return null; } };

// fetch + JSON; throws the server's error message on a non-2xx response.
async function orderRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || t('order_request_failed', response.status));
  return data;
}

// Store a photo on the server and return a source with a stable URL. `owner` is an order id, or a
// workspace name (canvas/passport/collage), which stores outside any order.
async function uploadPhoto(blob, name, owner = currentOrder?.id) {
  if (!owner) throw new Error(t('order_storage_not_ready'));
  const workspace = owner === 'canvas' || owner === 'passport' || owner === 'collage';
  const url = workspace ? `/api/workspace/${owner}/files` : `/api/orders/${owner}/files`;
  const { file } = await orderRequest(`${url}?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  return { file, src: workspace ? workspaceUrl(owner, file) : orderUrl(owner, file), name };
}

// Make sure a picked photo is stored on the server (sources already carrying `file` are).
async function storedSource(source, owner) {
  if (source.file) return source;
  const blob = source.blob || await (await fetch(source.src)).blob();
  return uploadPhoto(blob, source.name, owner);
}

// JSON-able copy of an item for saving: drops runtime-only fields and keeps just the format id.
function itemState(item) {
  const { img, wrapCache, renderKey, faceError, ...settings } = item;
  return { ...settings, fmt: item.fmt?.id };
}

// Saved state of one tab (what the server stores and history snapshots).
function tabState(tab) {
  if (tab === 'prints') return { items: prints.items.map(itemState), sel: prints.items.indexOf(prints.sel), view: prints.view || null };
  if (tab === 'canvas') return { items: canvasPrints.items.map(itemState), sel: canvasPrints.items.indexOf(canvasPrints.sel), view: canvasPrints.view || null };
  if (tab === 'collage') return collageState();
  return { jobs: pp.jobs.map(job => ({ file: job.file, cutFile: job.cutFile || null,
      name: job.name, size: job.size.id, right: job.right, down: job.down, status: job.status === 'done' ? 'done' : 'new',
      face: job.face, item: itemState(job.item) })), active: pp.jobs.indexOf(pp.active) };
}
