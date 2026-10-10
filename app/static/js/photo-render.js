'use strict';
// Render engine and export: draws an edited item (photo, background, overlays) at preview or print
// quality and saves it as a JPEG with the real DPI. Pages and the Photo Editor call this; it never
// touches page controls. Loads after photo-editor.js (coordinates) and render.js (font/sticker loaders).
//
// Moved here from (the old copies are gone):
//   PhotoRender.drawRotated                     ← render.js drawRotated
//   PhotoRender.blurredBackdrop / printBackground ← canvas.js (blurredBackdrop / printBackground were in canvas.js)
//   PhotoRender.textLines / drawOverlays (+ helpers) ← render.js textWidth / textLines / drawSpacedText /
//                                                   stickerStroke / overlayBox / drawOverlays
//   PhotoRender.readyOverlays                   ← render.js readyOverlays (font/sticker loading reused)
//   PhotoRender.renderItem                      ← render.js renderItem
//   PhotoRender.renderHQ / shrinks / renderToCanvas ← render.js renderHQ / shrinks (renderToCanvas moved here)
//   PhotoRender.applyDensity / densityFilter    ← render.js applyDensity / densityFilter
//   PhotoRender.jpegBlob / saveFile             ← render.js jpegBlob / saveFile
//   PhotoRender.exportItem                      ← prints.js savePrint, canvas.js saveCanvas (shared shape)
//   PhotoRender.exportCanvas                    ← passport.js savePassport
//   PhotoRender.renderSheet / exportSheet       ← collage.js renderCollage / saveCollageSheet, passport.js renderSheet /
//                                                 savePassport (linked cells, 'full' cut lines)
//   PhotoRender.exportAll                       ← prints.js #save-all, canvas.js / passport.js save-all loops

const PhotoRender = (() => {
  const { srcDims, outMM, placement } = PhotoEditor;

  // ------------------------------------------------------------ photo

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

  // ------------------------------------------------------------ blurred background

  // Low-resolution, cached enlargement of `source`, blurred (gaussian or layered motion) so it can
  // fill a border or canvas wrap without stretching sharp detail. Cached on item.wrapCache by `key`.
  // The cache holds one entry per item, so the key must cover everything that changes the result.
  function blurredBackdrop(item, source, W, H, key) {
    if (item.wrapCache?.key === key) return item.wrapCache.canvas;
    const scale = 600 / Math.max(W, H), w = Math.max(1, Math.round(W * scale));
    const h = Math.max(1, Math.round(H * scale));
    const blur = document.createElement('canvas'); blur.width = w; blur.height = h;
    const ctx = blur.getContext('2d');
    // Blur/smear length in px: strength (0-100) scaled to the backdrop size; the source is drawn
    // `length * 3` px oversize so blurred edges never show transparent borders.
    const length = Math.max(2, Math.round(item.strength * Math.max(w, h) / 750));
    const cover = Math.max(w / source.width, h / source.height);
    const dw = source.width * cover + length * 3, dh = source.height * cover + length * 3;
    const x = (w - dw) / 2, y = (h - dh) / 2;
    if (item.blur === 'gaussian') {
      ctx.filter = `blur(${length}px)`;
      ctx.drawImage(source, x, y, dw, dh);
      ctx.filter = 'none';
    } else {
      // Motion blur: 40 copies shifted diagonally; alpha 1/(i+1) makes the stack an even average.
      for (let i = 0; i < 40; i++) {
        const t = (i / 39 - .5) * length;
        ctx.globalAlpha = 1 / (i + 1);
        ctx.drawImage(source, x + t, y - t, dw, dh);
      }
      ctx.globalAlpha = 1;
    }
    item.wrapCache = { key, canvas: blur };
    return blur;
  }

  // Blurred copy of the whole photo for the 'blur' fill mode (the "Fit, blurred border" option).
  function printBackground(item, W, H) {
    const key = [W, H, item.img.src, item.rot, item.blur, item.strength].join('|');
    if (item.wrapCache?.key === key) return item.wrapCache.canvas;
    const d = srcDims(item), scale = 600 / Math.max(d.w, d.h);
    const source = document.createElement('canvas');
    source.width = Math.max(1, Math.round(d.w * scale));
    source.height = Math.max(1, Math.round(d.h * scale));
    const ctx = source.getContext('2d');
    ctx.scale(source.width / d.w, source.height / d.h);
    drawRotated(ctx, item);
    return blurredBackdrop(item, source, W, H, key);
  }

  // ------------------------------------------------------------ overlays (text & stickers)
  // Fonts and sticker images are loaded and cached by render.js (ensureFont, stickerImage, fontReady).

  const outlineColour = o => o.outline === 'white' ? '#ffffff' : o.outline === 'custom' ? (o.outlineColor || '#000000') : '#000000';
  const textSpacing = (o, h) => (o.letterSpacing || 0) * h / 100;
  const graphemes = s => typeof Intl.Segmenter === 'function'
    ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].map(x => x.segment) : Array.from(s);
  // Outlined sticker bitmaps, keyed by sticker/colour/size; small, oldest entry dropped first.
  const strokeCache = new Map();

  // Width of a string with extra letter spacing; uses native ctx.letterSpacing when available, else sums graphemes.
  function textWidth(ctx, s, spacing) {
    if (!spacing) { if ('letterSpacing' in ctx) ctx.letterSpacing = '0px'; return ctx.measureText(s).width; }
    const parts = graphemes(s);
    if ('letterSpacing' in ctx) { ctx.letterSpacing = `${spacing}px`; return ctx.measureText(s).width; }
    return parts.reduce((w, ch) => w + ctx.measureText(ch).width, 0) + Math.max(0, parts.length - 1) * spacing;
  }

  // Wrap text by measured grapheme width, including explicit line breaks.
  function textLines(ctx, o, frame, h) {
    // Lines may use at most 92% of the frame width.
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
    // Hebrew and Arabic blocks: lay glyphs out right to left.
    const rtl = /[֐-ࣿ]/u.test(line);
    let x = rtl ? total / 2 : -total / 2;
    chars.forEach((ch, i) => {
      x += (rtl ? -1 : 1) * widths[i] / 2;
      if (stroke) ctx.strokeText(ch, x, y);
      ctx.fillText(ch, x, y);
      x += (rtl ? -1 : 1) * (widths[i] / 2 + spacing);
    });
  }

  // Cached alpha silhouette so sticker outlines follow their shape.
  function stickerStroke(o, img, w, h, radius) {
    const px = Math.round(radius), W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h));
    const key = `${o.sticker}|${outlineColour(o)}|${px}|${W}|${H}`;
    if (strokeCache.has(key)) return strokeCache.get(key);
    const mask = document.createElement('canvas'); mask.width = W; mask.height = H;
    const mc = mask.getContext('2d'); mc.drawImage(img, 0, 0, W, H);
    mc.globalCompositeOperation = 'source-in'; mc.fillStyle = outlineColour(o); mc.fillRect(0, 0, W, H);
    const bitmap = document.createElement('canvas'); bitmap.width = W + 2 * px; bitmap.height = H + 2 * px;
    const bc = bitmap.getContext('2d');
    // Outline = the silhouette stamped at 36 angles around a circle of radius px, then the sticker on top.
    for (let i = 0; i < 36; i++) {
      const angle = i * 2 * Math.PI / 36;
      bc.drawImage(mask, px + Math.cos(angle) * px, px + Math.sin(angle) * px);
    }
    bc.drawImage(img, px, px, W, H);
    if (strokeCache.size >= 8) strokeCache.delete(strokeCache.keys().next().value);
    strokeCache.set(key, bitmap);
    return bitmap;
  }

  // Size of one overlay in canvas pixels (and its wrapped lines for text).
  function overlayBox(ctx, o, frame) {
    // o.size is the text/sticker height in mm; frame.mmToPx converts it to canvas pixels.
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
    // 1.15 = line height relative to the font size.
    return { w, h: h * 1.15 * lines.length, lines };
  }

  // Draw text and stickers in print-frame coordinates independent of the crop.
  // o.x/o.y are the overlay centre as fractions of the frame; frame is {x, y, w, h, mmToPx} in canvas px.
  function drawOverlays(ctx, item, frame) {
    if (!item.overlays?.length) return;
    ctx.save(); ctx.beginPath(); ctx.rect(frame.x, frame.y, frame.w, frame.h); ctx.clip();
    for (const o of item.overlays) {
      if (o.type === 'text') {
        ensureFont(o.font, o.bold);
        // Text whose font has not finished loading is skipped (ensureFont triggers the load).
        if (!fontReady.has(`${fontWeight(o.font, o.bold)} ${OVERLAY_FONTS.includes(o.font) ? o.font : 'Ella'}`)) continue;
      }
      const { w, h, lines, stroke } = overlayBox(ctx, o, frame);
      ctx.save(); ctx.translate(frame.x + o.x * frame.w, frame.y + o.y * frame.h);
      ctx.rotate((o.rot || 0) * Math.PI / 180);
      if (o.type === 'sticker') {
        const img = stickerImage(o.sticker);
        if (img?.complete && img.naturalWidth) {
          if (stroke) ctx.drawImage(stickerStroke(o, img, w - 2 * stroke, h - 2 * stroke, stroke), -w / 2, -h / 2, w, h);
          else ctx.drawImage(img, -w / 2, -h / 2, w, h);
        }
      } else {
        const lineH = o.size * frame.mmToPx * 1.15;
        ctx.font = `${fontWeight(o.font, o.bold)} ${o.size * frame.mmToPx}px ${fontStack(o.font)}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = o.color || '#ffffff';
        ctx.lineJoin = 'round'; ctx.lineWidth = (o.strokeWidth ?? o.size * .12) * frame.mmToPx;
        ctx.strokeStyle = outlineColour(o);
        lines.forEach((line, i) => {
          // Hebrew block only; Arabic text is handled in drawSpacedText.
          ctx.direction = /[֐-׿]/.test(line) ? 'rtl' : 'ltr';
          const y = (i - (lines.length - 1) / 2) * lineH;
          drawSpacedText(ctx, line, y, textSpacing(o, o.size * frame.mmToPx), o.outline && o.outline !== 'none' && ctx.lineWidth > 0);
        });
      }
      ctx.restore();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ render

  // Render the item into a W×H canvas context: background, blurred border, photo, overlays.
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

  // Final-quality render. When the photo is shrunk, draw at 2× and shrink once with 'high'
  // smoothing (matches a Lanczos resize on a 6000 px test chart). Skipped above 64 MP
  // (4*W*H is the pixel count of the 2x canvas) to stay within canvas memory limits.
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
  // True when the source has more pixels than the output (scale below 1 output px per source px).
  const shrinks = (item, W, H) => placement(item, W, H).s < 1;

  // Print-size canvas for one item. Options let Canvas prints swap size, DPI, drawing and photo frame.
  function renderToCanvas(item, { sizeMM = outMM, dpi = DPI, render = renderItem, front = (it, W, H) => ({ w: W, h: H }) } = {}) {
    const mm = sizeMM(item), W = mm2px(mm.w, dpi), H = mm2px(mm.h, dpi), f = front(item, W, H);
    return renderHQ(W, H, shrinks(item, f.w, f.h), (ctx, w, h) => render(ctx, item, w, h));
  }

  // ------------------------------------------------------------ density

  // Printer density −5…+5: each step bends the mid-tones ~7% through a gamma curve.
  const densityGamma = d => 1 + .07 * d;
  const densityFilter = d => (d ? `url(#density-${d})` : '');
  function applyDensity(canvas, d) {
    if (!d) return;
    const gamma = densityGamma(d), lut = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * (v / 255) ** gamma);
    const ctx = canvas.getContext('2d'), img = ctx.getImageData(0, 0, canvas.width, canvas.height), px = img.data;
    for (let i = 0; i < px.length; i += 4) { px[i] = lut[px[i]]; px[i + 1] = lut[px[i + 1]]; px[i + 2] = lut[px[i + 2]]; }
    ctx.putImageData(img, 0, 0);
  }

  // ------------------------------------------------------------ export

  // JPEG (with density) and the DPI written into the JFIF header so printers use the real size.
  async function jpegBlob(canvas, quality = 1, dpi = DPI, density = 0) { // quality 1 keeps 4:4:4 colour
    applyDensity(canvas, density);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) throw new Error(t('common_image_too_large'));
    let buf = new Uint8Array(await blob.arrayBuffer());
    // JFIF header layout: bytes 2-3 APP0 marker, 6-9 "JFIF", 13 density units (1 = dots per inch),
    // 14-15 X density, 16-17 Y density (big-endian).
    const hi = dpi >> 8, lo = dpi & 255;
    const isJfif = buf[2] === 0xFF && buf[3] === 0xE0 && buf[6] === 0x4A && buf[7] === 0x46 && buf[8] === 0x49 && buf[9] === 0x46;
    if (isJfif) {
      buf[13] = 1; buf[14] = hi; buf[15] = lo; buf[16] = hi; buf[17] = lo;
    } else {
      // No JFIF header (e.g. an EXIF-first file): insert a new APP0 segment right after the SOI marker.
      const app0 = [0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1, hi, lo, hi, lo, 0, 0];
      const out = new Uint8Array(buf.length + app0.length);
      out.set(buf.subarray(0, 2)); out.set(app0, 2); out.set(buf.subarray(2), 2 + app0.length);
      buf = out;
    }
    return new Blob([buf], { type: 'image/jpeg' });
  }

  // Store the file in the exported folder on the server; returns the saved path.
  async function saveFile(blob, name, folder) {
    const res = await fetch('/api/save?name=' + encodeURIComponent(name) + '&folder=' + encodeURIComponent(folder), { method: 'POST', body: blob });
    if (!res.ok) throw new Error(t('common_save_failed', res.status));
    return (await res.json()).saved;
  }

  // Export one edited item: wait for fonts/stickers, render at print quality, save.
  // `name` and `folder` come from the page (each page names its files differently).
  async function exportItem(item, { name, folder, dpi = DPI, ...renderOptions }) {
    await readyOverlays(item);
    const canvas = renderToCanvas(item, { dpi, ...renderOptions });
    return saveFile(await jpegBlob(canvas, 1, dpi, item.density), name, folder);
  }

  // Export an already drawn sheet (Passport sheet, Collage sheet).
  async function exportCanvas(canvas, { name, folder, dpi = DPI, density = 0 }) {
    return saveFile(await jpegBlob(canvas, 1, dpi, density), name, folder);
  }

  // Draw a sheet of cells (Collage) at `dpi`: paper colour, white empty cells, each photo rendered at
  // print quality, then 2 px cut lines along shared cell edges (only when the gap is 0).
  // `cellRects` are the PhotoSheet.cellRects(sheet) boxes in mm; cutLines defaults to the sheet's setting.
  // A `link`ed sheet (Passport) repeats one photo: each item is rendered once and drawn into every cell.
  // cutLines 'full' (Passport) draws the lines across the whole paper at every edge of the size-packed grid.
  function renderSheet(sheet, { dpi = DPI, cutLines = sheet.cutLines, cellRects = PhotoSheet.cellRects(sheet) } = {}) {
    const paper = PhotoSheet.sheetMM(sheet), PW = mm2px(paper.w, dpi), PH = mm2px(paper.h, dpi);
    const canvas = document.createElement('canvas'); canvas.width = PW; canvas.height = PH;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = sheet.gapColor; ctx.fillRect(0, 0, PW, PH);
    const linked = new Map();
    for (const rect of cellRects) {
      const x = mm2px(rect.x, dpi), y = mm2px(rect.y, dpi), w = mm2px(rect.w, dpi), h = mm2px(rect.h, dpi);
      if (!rect.leaf.item) { ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, w, h); continue; }
      const item = rect.leaf.item;
      const draw = () => renderHQ(w, h, shrinks(item, w, h), (c, cw, ch) => renderItem(c, item, cw, ch));
      if (!sheet.link) { ctx.drawImage(draw(), x, y, w, h); continue; }
      if (!linked.has(item)) linked.set(item, draw());
      ctx.drawImage(linked.get(item), x, y, w, h);
    }
    if (cutLines === 'full') {
      const pack = PhotoSheet.sizePack(sheet), CUT = 2; // cut line width in px (≈0.17 mm at 300 DPI)
      ctx.fillStyle = '#000';
      for (let c = 0; c <= pack.cols; c++) {
        const x = mm2px(pack.x + c * pack.w, dpi);
        if (x >= 0 && x <= PW) ctx.fillRect(x - CUT / 2, 0, CUT, PH);
      }
      for (let r = 0; r <= pack.rows; r++) {
        const y = mm2px(pack.y + r * pack.h, dpi);
        if (y >= 0 && y <= PH) ctx.fillRect(0, y - CUT / 2, PW, CUT);
      }
    } else if (cutLines && Number(sheet.gap) === 0) {
      ctx.fillStyle = '#000';
      for (const line of PhotoSheet.sharedSegments(cellRects)) {
        if (line.dir === 'row') ctx.fillRect(mm2px(line.x, dpi) - 1, mm2px(line.y, dpi), 2, mm2px(line.h, dpi));
        else ctx.fillRect(mm2px(line.x, dpi), mm2px(line.y, dpi) - 1, mm2px(line.w, dpi), 2);
      }
    }
    return canvas;
  }

  // Export a sheet: render it and save it as a JPEG; `name` and `folder` come from the page.
  async function exportSheet(sheet, { name, folder, dpi = DPI, density = sheet.density, ...renderOptions }) {
    return exportCanvas(renderSheet(sheet, { dpi, ...renderOptions }), { name, folder, dpi, density });
  }

  // Export several items one after another; progress(i, total) before each. Returns saved paths.
  async function exportAll(items, save, progress = () => {}) {
    const saved = [];
    for (const [i, it] of items.entries()) {
      progress(i + 1, items.length);
      const path = await save(it);
      if (path) saved.push(path);
    }
    return saved;
  }

  return {
    drawRotated, blurredBackdrop, printBackground, textLines, overlayBox, drawOverlays, readyOverlays,
    renderItem, renderHQ, shrinks, renderToCanvas,
    densityFilter, applyDensity,
    jpegBlob, saveFile, exportItem, exportCanvas, renderSheet, exportSheet, exportAll,
  };
})();
