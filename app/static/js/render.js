'use strict';
// Draws crops, text, stickers, and export canvases for the photo tabs.
// Loads after config.js; history, editors, and tab scripts use these helpers.
// ---------------------------------------------------------------- helpers

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not open this image'));
    img.src = src;
  });
}

function srcDims(item) {
  const { naturalWidth: w, naturalHeight: h } = item.img;
  return item.rot % 180 ? { w: h, h: w } : { w, h };
}

// Draw the (rotated) source so it covers [0,sw]×[0,sh].
function drawRotated(ctx, item) {
  const { img, rot } = item;
  const w = img.naturalWidth, h = img.naturalHeight;
  ctx.save();
  if (rot === 90) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
  else if (rot === 180) { ctx.translate(w, h); ctx.rotate(Math.PI); }
  else if (rot === 270) { ctx.translate(0, w); ctx.rotate(-Math.PI / 2); }
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

// Output size in mm for an item (format + orientation).
function outMM(item) {
  let { w, h } = item.fmt;
  if (w !== h) {
    let o = item.orient;
    if (o === 'auto') { const d = srcDims(item); o = d.h >= d.w ? 'portrait' : 'landscape'; }
    if (o === 'landscape') [w, h] = [h, w];
  }
  return { w, h };
}

// Scale (output px per source px) and clamp the crop centre.
function placement(item, W, H) {
  const d = srcDims(item);
  const fit = item.mode === 'fit' || item.mode === 'blur';
  const s = (fit ? Math.min(W / d.w, H / d.h) : Math.max(W / d.w, H / d.h) * item.zoom);
  const vw = W / s / d.w, vh = H / s / d.h; // visible fraction of the source
  const clamp = (c, v) => (v >= 1 ? 0.5 : Math.min(1 - v / 2, Math.max(v / 2, c)));
  if (fit) { item.cx = item.cy = 0.5; }
  else if (item.free) { /* passport: may move past the photo edge; bg colour fills the gap */ }
  else { item.cx = clamp(item.cx, vw); item.cy = clamp(item.cy, vh); }
  return { s, d };
}

const STICKERS = ['heart.svg', 'crown.svg', 'thumbs-up.svg', 'smile.svg', 'rainbow.svg', 'teddy.svg',
  'dog.svg', 'sunflower.svg', 'kiss-mark.svg', 'cake.svg', 'blossom.svg', 'joy.svg', 'confetti.svg',
  'rose.svg', 'sparkles.svg', 'party.svg', 'baby-bottle.svg', 'butterfly.svg', 'bouquet.svg',
  'cheers.svg', 'gift.svg', 'heart-eyes.svg', 'graduation.svg', 'sun.svg', 'star.svg',
  'two-hearts.svg', 'baby.svg', 'cat.svg', 'wink.svg', 'kiss.svg', 'balloon.svg',
  'sparkling-heart.svg', 'glowing-star.svg', 'ring.svg', 'smiling-hearts.svg', 'moon.svg'];
const OVERLAY_FONTS = ['Ella', 'Mila', 'Janna', 'Regina', 'Idan', 'Oleksii', 'Liam'];
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
const fontStack = font => { const name = OVERLAY_FONTS.includes(font) ? font : 'Ella';
  return FONT_FALLBACK[name] ? `"${name}", "${FONT_FALLBACK[name]}"` : `"${name}"`; };
const fontLoads = new Map(), fontReady = new Set(), stickerImages = new Map();
const stickerStrokeCache = new Map();
let assetVersion = 0;
function assetsChanged() {
  assetVersion++;
  if (typeof prints !== 'undefined') { prints.preview?.redraw(); printsGrid?.update(); }
  if (typeof canvasPrints !== 'undefined') { canvasPrints.preview?.redraw(); canvasGrid?.update(); }
}
function ensureFont(font, bold) {
  const name = OVERLAY_FONTS.includes(font) ? font : 'Ella', weight = fontWeight(name, bold);
  const key = `${weight} ${name}`;
  if (!fontLoads.has(key)) fontLoads.set(key, Promise.all([name, FONT_FALLBACK[name]].filter(Boolean).map(f => document.fonts.load(`${weight} 40px "${f}"`))).then(() => { fontReady.add(key); assetsChanged(); }));
  return fontLoads.get(key);
}
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
async function readyOverlays(item) {
  await localFontsReady;
  await Promise.all((item.overlays || []).map(o => o.type === 'text' ? ensureFont(o.font, o.bold) : new Promise((resolve, reject) => {
    const img = stickerImage(o.sticker);
    if (!img) return reject(new Error('Unknown sticker'));
    if (img.complete) return img.naturalWidth ? resolve() : reject(new Error('Could not load sticker'));
    img.addEventListener('load', resolve, { once: true });
    img.addEventListener('error', () => reject(new Error('Could not load sticker')), { once: true });
  })));
}
function overlayFrame(item, front) {
  return { ...front, mmToPx: front.w / outMM(item).w };
}
const outlineColour = o => o.outline === 'white' ? '#ffffff' : o.outline === 'custom' ? (o.outlineColor || '#000000') : '#000000';
const textSpacing = (o, h) => (o.letterSpacing || 0) * h / 100;
const graphemes = s => typeof Intl.Segmenter === 'function'
  ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(x => x.segment) : Array.from(s);
function textWidth(ctx, s, spacing) {
  if (!spacing) { if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'; return ctx.measureText(s).width; }
  const parts = graphemes(s);
  if ('letterSpacing' in ctx) { ctx.letterSpacing = `${spacing}px`; return ctx.measureText(s).width; }
  return parts.reduce((w, ch) => w + ctx.measureText(ch).width, 0) + Math.max(0, parts.length - 1) * spacing;
}
// Wrap text by measured grapheme width, including explicit line breaks.
// Letter spacing contributes to each line width so the rendered frame fits.
function textLines(ctx, o, frame, h) {
  const spacing = textSpacing(o, h), maxW = frame.w * .92, result = [];
  for (const explicit of String(o.text || '').split('\n')) {
    if (!explicit) { result.push(''); continue; }
    if (textWidth(ctx, explicit, spacing) <= maxW) { result.push(explicit); continue; }
    let line = '';
    for (const word of explicit.split(/(\s+)/u).filter(Boolean)) {
      const next = line + word;
      if (textWidth(ctx, next, spacing) <= maxW) { line = next; continue; }
      if (line.trim() && !/^\s+$/u.test(word)) { result.push(line.trimEnd()); line = ''; }
      if (/^\s+$/u.test(word)) continue;
      for (const ch of graphemes(word)) {
        if (line && textWidth(ctx, line + ch, spacing) > maxW) { result.push(line); line = ''; }
        line += ch;
      }
    }
    result.push(line.trimEnd());
  }
  return result;
}
// Draw graphemes individually to apply spacing that canvas text APIs lack.
function drawSpacedText(ctx, line, y, spacing, stroke) {
  if (!spacing || 'letterSpacing' in ctx) {
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
    if (stroke) ctx.strokeText(line, 0, y);
    ctx.fillText(line, 0, y);
    return;
  }
  const chars = graphemes(line), widths = chars.map(ch => ctx.measureText(ch).width);
  const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, chars.length - 1) * spacing;
  const rtl = /[\u0590-\u08ff]/u.test(line);
  let x = rtl ? total / 2 : -total / 2;
  chars.forEach((ch, i) => {
    x += (rtl ? -1 : 1) * widths[i] / 2;
    if (stroke) ctx.strokeText(ch, x, y);
    ctx.fillText(ch, x, y);
    x += (rtl ? -1 : 1) * (widths[i] / 2 + spacing);
  });
}
// Build a cached alpha silhouette so sticker outlines follow their shape.
function stickerStroke(o, img, w, h, radius) {
  const px = Math.round(radius), W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
  const key = `${o.sticker}|${outlineColour(o)}|${px}|${W}|${H}`;
  if (stickerStrokeCache.has(key)) return stickerStrokeCache.get(key);
  const mask = document.createElement('canvas'); mask.width = W; mask.height = H;
  const mc = mask.getContext('2d'); mc.drawImage(img, 0, 0, W, H);
  mc.globalCompositeOperation = 'source-in'; mc.fillStyle = outlineColour(o); mc.fillRect(0, 0, W, H);
  const bitmap = document.createElement('canvas'); bitmap.width = W + 2 * px; bitmap.height = H + 2 * px;
  const bc = bitmap.getContext('2d');
  for (let i = 0; i < 36; i++) {
    const angle = i * 2 * Math.PI / 36;
    bc.drawImage(mask, px + Math.cos(angle) * px, px + Math.sin(angle) * px);
  }
  bc.drawImage(img, px, px, W, H);
  if (stickerStrokeCache.size >= 8) stickerStrokeCache.delete(stickerStrokeCache.keys().next().value);
  stickerStrokeCache.set(key, bitmap);
  return bitmap;
}
function overlayBox(ctx, o, frame) {
  const h = o.size * frame.mmToPx;
  if (o.type === 'sticker') {
    const img = stickerImage(o.sticker), ratio = img?.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
    const stroke = o.outline && o.outline !== 'none' && o.strokeWidth > 0 ? Math.round(o.strokeWidth * frame.mmToPx) : 0;
    return { w: h * ratio + 2 * stroke, h: h + 2 * stroke, stroke };
  }
  ctx.save();
  ctx.font = `${fontWeight(o.font, o.bold)} ${h}px ${fontStack(o.font)}`;
  const lines = textLines(ctx, o, frame, h);
  const w = Math.max(h * .5, ...lines.map(line => textWidth(ctx, line || ' ', textSpacing(o, h))));
  ctx.restore();
  return { w, h: h * 1.15 * lines.length, lines };
}
// Draw text and stickers in print-frame coordinates independent of the crop.
function drawOverlays(ctx, item, frame) {
  if (!item.overlays?.length) return;
  ctx.save(); ctx.beginPath(); ctx.rect(frame.x, frame.y, frame.w, frame.h); ctx.clip();
  for (const o of item.overlays) {
    if (o.type === 'text') {
      ensureFont(o.font, o.bold);
      if (!fontReady.has(`${fontWeight(o.font, o.bold)} ${OVERLAY_FONTS.includes(o.font) ? o.font : 'Ella'}`)) continue;
    }
    const { w, h, lines, stroke } = overlayBox(ctx, o, frame);
    ctx.save(); ctx.translate(frame.x + o.x * frame.w, frame.y + o.y * frame.h);
    ctx.rotate((o.rot || 0) * Math.PI / 180);
    if (o.type === 'sticker') {
      const img = stickerImage(o.sticker);
      if (img?.complete && img.naturalWidth) {
        if (stroke) {
          const bitmap = stickerStroke(o, img, w - 2 * stroke, h - 2 * stroke, stroke);
          ctx.drawImage(bitmap, -w / 2, -h / 2, w, h);
        } else ctx.drawImage(img, -w / 2, -h / 2, w, h);
      }
    } else {
      const lineH = o.size * frame.mmToPx * 1.15;
      ctx.font = `${fontWeight(o.font, o.bold)} ${o.size * frame.mmToPx}px ${fontStack(o.font)}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = o.color || '#ffffff';
      ctx.lineJoin = 'round'; ctx.lineWidth = (o.strokeWidth ?? o.size * .12) * frame.mmToPx;
      ctx.strokeStyle = outlineColour(o);
      lines.forEach((line, i) => {
        ctx.direction = /[\u0590-\u05ff]/.test(line) ? 'rtl' : 'ltr';
        const y = (i - (lines.length - 1) / 2) * lineH;
        drawSpacedText(ctx, line, y, textSpacing(o, o.size * frame.mmToPx), o.outline && o.outline !== 'none' && ctx.lineWidth > 0);
      });
    }
    ctx.restore();
  }
  ctx.restore();
}

// Render the item into a W×H canvas context.
function renderItem(ctx, item, W, H, drawExtras = true) {
  const { s, d } = placement(item, W, H);
  ctx.save();
  ctx.fillStyle = item.bg || '#ffffff';
  ctx.fillRect(0, 0, W, H);
  if (item.mode === 'blur') ctx.drawImage(printBackground(item, W, H), 0, 0, W, H);
  ctx.imageSmoothingQuality = 'high';
  ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(item.tilt * Math.PI / 180);
  ctx.scale(s, s);
  ctx.translate(-item.cx * d.w, -item.cy * d.h);
  drawRotated(ctx, item);
  ctx.restore();
  if (drawExtras) drawOverlays(ctx, item, { x: 0, y: 0, w: W, h: H, mmToPx: W / outMM(item).w });
}

// Final-quality render for saving. When the photo is shrunk (output px per photo px < 1), draw at 2×
// and shrink once with 'high' smoothing: measured on a 6000 px test chart this matches a Lanczos
// resize, while a one-step browser shrink keeps only ~70% of fine detail (hair, fabric). Skipped
// when the photo is enlarged anyway or the 2× canvas would exceed 64 MP.
function renderHQ(W, H, shrinking, draw) {
  const out = document.createElement('canvas'); out.width = W; out.height = H;
  const ctx = out.getContext('2d');
  if (!shrinking || 4 * W * H > 64e6) { draw(ctx, W, H); return out; }
  const big = document.createElement('canvas'); big.width = W * 2; big.height = H * 2;
  draw(big.getContext('2d'), W * 2, H * 2);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(big, 0, 0, W, H);
  return out;
}
const shrinks = (item, W, H) => placement(item, W, H).s < 1;

function renderToCanvas(item) {
  const mm = outMM(item), W = mm2px(mm.w), H = mm2px(mm.h);
  return renderHQ(W, H, shrinks(item, W, H), (ctx, w, h) => renderItem(ctx, item, w, h));
}

// Printer density per photo (−5…+5, default 0). Each step bends the mid-tones ~7% through a gamma
// curve; black and white stay put. Negative = lighter print, positive = darker.
// Previews show the same curve through one SVG filter per step (#density-N).
const densityGamma = d => 1 + .07 * d;
const densityFilter = d => (d ? `url(#density-${d})` : '');
// Apply the selected tonal adjustment through a lookup table to output pixels.
function applyDensity(canvas, d) {
  if (!d) return;
  const gamma = densityGamma(d), lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * (v / 255) ** gamma);
  const ctx = canvas.getContext('2d'), img = ctx.getImageData(0, 0, canvas.width, canvas.height), px = img.data;
  for (let i = 0; i < px.length; i += 4) { px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]]; }
  ctx.putImageData(img, 0, 0);
}
document.body.insertAdjacentHTML('beforeend', `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${
  [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5].map(d => `<filter id="density-${d}" color-interpolation-filters="sRGB"><feComponentTransfer>${
    ['R', 'G', 'B'].map(c => `<feFunc${c} type="gamma" exponent="${densityGamma(d)}"/>`).join('')}</feComponentTransfer></filter>`).join('')}</svg>`);

// Density control for one tab: − value + for the selected photo, and "Apply to all photos".
// Returns a sync function that shows the selected photo's value.
function densityControl(root, { item, items, refresh }) {
  root.className = 'row density';
  root.innerHTML = '<button data-d="-1" title="Lighter print">−</button><output>0</output>' +
    '<button data-d="1" title="Darker print">+</button><button class="ghost" data-all>Apply to all photos</button>';
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
const densityLabel = it => (it.density ? ` · density ${it.density > 0 ? '+' : ''}${it.density}` : '');

// JPEG (with the photo's density) and the DPI written into the JFIF header so printers use the real size.
async function jpegBlob(canvas, quality = 1, dpi = DPI, density = 0) { // quality 1 keeps full colour resolution (4:4:4)
  applyDensity(canvas, density);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob) throw new Error('Image too large for this browser — use Google Chrome');
  let buf = new Uint8Array(await blob.arrayBuffer());
  const hi = dpi >> 8, lo = dpi & 255;
  const isJfif = buf[2] === 0xFF && buf[3] === 0xE0 && buf[6] === 0x4A && buf[7] === 0x46 && buf[8] === 0x49 && buf[9] === 0x46;
  if (isJfif) {
    buf[13] = 1; buf[14] = hi; buf[15] = lo; buf[16] = hi; buf[17] = lo;
  } else {
    const app0 = [0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1, hi, lo, hi, lo, 0, 0];
    const out = new Uint8Array(buf.length + app0.length);
    out.set(buf.subarray(0, 2)); out.set(app0, 2); out.set(buf.subarray(2), 2 + app0.length);
    buf = out;
  }
  return new Blob([buf], { type: 'image/jpeg' });
}

async function saveFile(blob, name, folder) {
  const res = await fetch('/api/save?name=' + encodeURIComponent(name) + '&folder=' + encodeURIComponent(folder), { method: 'POST', body: blob });
  if (!res.ok) throw new Error('Save failed (' + res.status + ')');
  return (await res.json()).saved;
}

const baseName = name => name.replace(/\.[^.]+$/, '');

function setStatus(el, msg, err = false) { el.textContent = msg; el.classList.toggle('err', err); }

const orderInput = $('#order-name');
const orderPicker = $('#order-picker');
let currentOrder = null, orderEpoch = 0, saveTimer = 0, saveChain = Promise.resolve(), loadingOrder = false;
const workspaces = {
  canvas: { epoch: 0, timer: 0, chain: Promise.resolve(), loading: false },
  passport: { epoch: 0, timer: 0, chain: Promise.resolve(), loading: false },
};
const dateFolder = id => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}_${id.slice(9, 11)}-${id.slice(11, 13)}`;
const orderName = () => orderInput.value || (currentOrder ? dateFolder(currentOrder.id) : '');
const orderUrl = (id, file) => `/orders/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`;
const workspaceUrl = (tab, file) => `/workspace/${tab}/files/${encodeURIComponent(file)}`;
const rememberOrder = id => { try { localStorage.setItem('ellashop-order-id', id); } catch (_) { /* storage may be unavailable */ } };
const lastOrder = () => { try { return localStorage.getItem('ellashop-order-id'); } catch (_) { return null; } };

async function orderRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Order request failed (${response.status})`);
  return data;
}

async function uploadPhoto(blob, name, owner = currentOrder?.id) {
  if (!owner) throw new Error('Storage is not ready');
  const workspace = owner === 'canvas' || owner === 'passport';
  const url = workspace ? `/api/workspace/${owner}/files` : `/api/orders/${owner}/files`;
  const { file } = await orderRequest(`${url}?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
  return { file, src: workspace ? workspaceUrl(owner, file) : orderUrl(owner, file), name };
}

async function storedSource(source, owner) {
  if (source.file) return source;
  const blob = source.blob || await (await fetch(source.src)).blob();
  return uploadPhoto(blob, source.name, owner);
}

function itemState(item) {
  const { img, wrapCache, renderKey, faceError, ...settings } = item;
  return { ...settings, fmt: item.fmt?.id };
}

function tabState(tab) {
  if (tab === 'prints') return { items: prints.items.map(itemState), sel: prints.items.indexOf(prints.sel), view: prints.view || null };
  if (tab === 'canvas') return { items: canvasPrints.items.map(itemState), sel: canvasPrints.items.indexOf(canvasPrints.sel), view: canvasPrints.view || null };
  return { jobs: pp.jobs.map(job => ({ file: job.file, cutFile: job.cutFile || null,
      name: job.name, size: job.size.id, status: job.status === 'done' ? 'done' : 'new',
      face: job.face, item: itemState(job.item) })), active: pp.jobs.indexOf(pp.active) };
}

