// Builds the text and sticker editor used in Prints and Canvas single view.
// Its controls are attached by the tab modules.
// Overlay ids are `o<time>-<counter>`; the counter keeps ids unique within one millisecond.

import { t } from './i18n.js';
import { NO_BOLD, OVERLAY_FONTS, STICKERS, ensureFont, localFontsReady, stickerImage } from './assets.js';
import { PhotoEditor } from './photo-editor.js';
import { PhotoRender } from './photo-render.js';
let nextOverlayId = 1;
// Create overlay controls and drag handles for the selected print frame.
// Keep overlays anchored to the frame while the underlying photo crop moves.
export function textAndStickers(root, state, refresh, preview) {
  root.innerHTML = `<h3>${t('editor_heading')}</h3>
    <div class="row"><button data-action="text">${t('editor_add_text')}</button><button data-action="palette">${t('editor_add_sticker')}</button></div>
    <div class="sticker-palette" hidden></div><p class="small palette-credit" hidden>${t('editor_credit')}</p>
    <div class="overlay-controls" hidden>
      <label class="overlay-text">${t('editor_text')}<textarea data-field="text" rows="3"></textarea></label>
      <label class="overlay-text">${t('editor_font')}<select data-field="font"></select></label>
      <label class="check overlay-text"><input type="checkbox" data-field="bold"> ${t('editor_bold')}</label>
      <label>${t('editor_size')}<span class="overlay-value"><input type="range" data-field="size" min="3" max="80" step="0.1"><input type="number" data-number="size" min="3" max="80" step="0.1"></span></label>
      <div class="overlay-text"><span>${t('editor_colour')}</span><div class="overlay-colors"></div><input type="color" data-field="color" title="${t('editor_custom_colour')}"></div>
      <label>${t('editor_outline')}<span class="overlay-value"><select data-field="outline"><option value="none">${t('editor_none')}</option><option value="white">${t('editor_white')}</option><option value="black">${t('editor_black')}</option><option value="custom">${t('editor_custom')}</option></select><input type="color" data-field="outlineColor" title="${t('editor_outline_colour')}"></span></label>
      <label>${t('editor_stroke_width')}<span class="overlay-value"><input type="range" data-field="strokeWidth" min="0" max="5" step="0.1"><input type="number" data-number="strokeWidth" min="0" max="5" step="0.1"></span></label>
      <label class="overlay-text">${t('editor_letter_spacing')}<span class="overlay-value"><input type="range" data-field="letterSpacing" min="-10" max="50" step="0.1"><input type="number" data-number="letterSpacing" min="-10" max="50" step="0.1"></span></label>
      <label>${t('editor_rotation')}<span class="overlay-value"><input type="range" data-field="rot" min="-180" max="180" step="1"><input type="number" data-number="rot" min="-180" max="180" step="1"></span></label>
      <label class="check"><input type="checkbox" data-magnet> ${t('editor_magnet')}</label>
      <div class="overlay-align" aria-label="${t('editor_align_margin')}">${[['↖','top-left'],['↑','top-centre'],['↗','top-right'],['←','middle-left'],['•','centre'],['→','middle-right'],['↙','bottom-left'],['↓','bottom-centre'],['↘','bottom-right']].map(([icon, name]) => `<button type="button" data-align="${name}" title="${t('editor_align_' + name.replace('-', '_'))}" aria-label="${t('editor_align_' + name.replace('-', '_'))}">${icon}</button>`).join('')}</div>
      <div class="row"><button data-axis="x">${t('editor_centre_horizontally')}</button><button data-axis="y">${t('editor_centre_vertically')}</button></div>
      <div class="row"><button data-action="duplicate">${t('editor_duplicate')}</button><button data-action="delete">${t('editor_delete')}</button><button data-action="front">${t('editor_to_front')}</button></div>
    </div>`;
  const palette = root.querySelector('.sticker-palette');
  for (const file of STICKERS) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.sticker = file; button.title = t('editor_sticker_' + file.replace(/\.svg$/, '').replace(/-/g, '_'));
    button.setAttribute('aria-label', button.title);
    stickerImage(file);
    button.style.backgroundImage = `url("stickers/${file}")`; palette.append(button);
  }
  const fontPicker = root.querySelector('[data-field=font]');
  for (const font of OVERLAY_FONTS) {
    const option = document.createElement('option'); option.value = option.textContent = font; option.style.fontFamily = `"${font}"`; fontPicker.append(option);
  }
  localFontsReady.then(list => list.forEach(({ name }) => {   // optional fonts installed on this computer only
    const option = document.createElement('option'); option.value = option.textContent = name; option.style.fontFamily = `"${name}"`; fontPicker.append(option);
  }));

  for (const color of ['#ffffff', '#000000', '#ff0000', '#d4a017', '#ff69b4', '#2364d2']) {
    const button = document.createElement('button'); button.type = 'button'; button.dataset.color = color; button.style.background = color;
    button.title = color; root.querySelector('.overlay-colors').append(button);
  }
  // selectedId is the chosen overlay of selectedItem (reset when another photo is selected);
  // guides holds the snap lines to draw while an overlay is being dragged.
  let selectedId = null, selectedItem = null, guides = null;
  let magnet = true;
  try { magnet = localStorage.getItem('ellashop-magnet') !== 'off'; } catch (_) { /* Storage may be unavailable. */ }
  root.querySelector('[data-magnet]').checked = magnet;
  // The selected overlay object of the current photo, or null.
  const selected = () => state.item?.overlays?.find(o => o.id === selectedId) || null;
  // Show the selected overlay's values in the controls (skipping a number box the user is typing in).
  function sync() {
    if (state.item !== selectedItem) { selectedItem = state.item; selectedId = null; }
    const o = selected();
    root.querySelector('.overlay-controls').hidden = !o;
    if (!o) return;
    root.querySelectorAll('.overlay-text').forEach(el => { el.hidden = o.type !== 'text'; });
    for (const field of ['text', 'font', 'size', 'color', 'outline', 'outlineColor', 'rot', 'strokeWidth', 'letterSpacing']) {
      const input = root.querySelector(`[data-field=${field}]`);
      const value = field === 'strokeWidth' ? (o.strokeWidth ?? (o.type === 'text' ? o.size * .12 : 0)) : field === 'letterSpacing' ? (o.letterSpacing ?? 0) : field === 'outlineColor' ? (o.outlineColor || '#000000') : o[field] ?? '';
      if (input && input.value !== String(value)) input.value = value;
      const number = root.querySelector(`[data-number=${field}]`);
      if (number && document.activeElement !== number) number.value = value;
    }
    root.querySelector('[data-field=bold]').checked = !!o.bold;
    root.querySelector('[data-field=bold]').disabled = NO_BOLD.has(o.font);
    root.querySelector('[data-field=outlineColor]').disabled = o.outline !== 'custom';
    root.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('on', b.dataset.color === o.color));
  }
  // `done` false = mid-drag: refresh the page but skip the extra redraw.
  function changed(done = true) { refresh(); if (done) preview.redraw(); }
  function select(id) { selectedItem = state.item; selectedId = id; guides = null; sync(); preview.redraw(); }
  // New overlay in the middle of the frame. size is the height in mm; x/y are fractions of the frame.
  function add(type, sticker = '') {
    const it = state.item; if (!it) return;
    const o = { id: `o${Date.now()}-${nextOverlayId++}`, type, text: type === 'text' ? t('editor_congratulations') : '',
      font: 'Ella', bold: true, size: type === 'text' ? 12 : 25, color: '#ffffff', outline: type === 'text' ? 'black' : 'none',
      outlineColor: '#000000', strokeWidth: type === 'text' ? 1.44 : 0, letterSpacing: 0,
      x: .5, y: .5, rot: 0, sticker };
    it.overlays ||= []; it.overlays.push(o);
    select(o.id); changed();
  }
  root.addEventListener('click', e => {
    const align = e.target.closest('[data-align]'), axis = e.target.closest('[data-axis]');
    if ((align || axis) && selected()) {
      const o = selected(), f = frame(state.item, preview), g = geometry(preview.ctx, o, f);
      const extX = (Math.abs(Math.cos(g.angle)) * g.w + Math.abs(Math.sin(g.angle)) * g.h) / 2;
      const extY = (Math.abs(Math.sin(g.angle)) * g.w + Math.abs(Math.cos(g.angle)) * g.h) / 2;
      // Align buttons put the rotated box's bounding extent 5 mm from the chosen edge.
      const margin = 5 * f.mmToPx, parts = align?.dataset.align.split('-') || [];
      const x = parts[0] === 'centre' || parts[1] === 'centre' || axis?.dataset.axis === 'x' ? f.x + f.w / 2 : parts[1] === 'left' ? f.x + margin + extX : f.x + f.w - margin - extX;
      const y = parts[0] === 'centre' || parts[0] === 'middle' || axis?.dataset.axis === 'y' ? f.y + f.h / 2 : parts[0] === 'top' ? f.y + margin + extY : f.y + f.h - margin - extY;
      if (align || axis?.dataset.axis === 'x') o.x = Math.max(0, Math.min(1, (x - f.x) / f.w));
      if (align || axis?.dataset.axis === 'y') o.y = Math.max(0, Math.min(1, (y - f.y) / f.h));
      changed(); return;
    }
    const sticker = e.target.closest('[data-sticker]'); if (sticker) { add('sticker', sticker.dataset.sticker); return; }
    const color = e.target.closest('[data-color]'); if (color && selected()) { selected().color = color.dataset.color; changed(); return; }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'text') add('text');
    else if (action === 'palette') { palette.hidden = !palette.hidden; root.querySelector('.palette-credit').hidden = palette.hidden; }
    else if (action === 'delete' && selected()) { state.item.overlays = state.item.overlays.filter(o => o.id !== selectedId); select(null); changed(); }
    else if (action === 'duplicate' && selected()) {
      const o = { ...selected(), id: `o${Date.now()}-${nextOverlayId++}`, x: Math.min(1, selected().x + .04), y: Math.min(1, selected().y + .04) };
      state.item.overlays.push(o); select(o.id); changed();
    } else if (action === 'front' && selected()) {
      const o = selected(); state.item.overlays = state.item.overlays.filter(x => x !== o); state.item.overlays.push(o); changed();
    }
  });
  root.addEventListener('input', e => {
    if (e.target.matches('[data-magnet]')) { magnet = e.target.checked; guides = null; try { localStorage.setItem('ellashop-magnet', magnet ? 'on' : 'off'); } catch (_) {} preview.redraw(); return; }
    const field = e.target.dataset.field, o = selected(); if (!field || !o) return;
    // Typing \n or /n inserts a line break (for keyboards where Enter is awkward in the box).
    if (field === 'text') e.target.value = e.target.value.replace(/\\n|\/n/g, '\n');
    o[field] = ['size', 'rot', 'strokeWidth', 'letterSpacing'].includes(field) ? +e.target.value : field === 'bold' ? e.target.checked : e.target.value;
    if (field === 'font' && NO_BOLD.has(o.font)) o.bold = false;
    if (field === 'font' || field === 'bold') ensureFont(o.font, o.bold);
    sync(); changed(false);
  });
  root.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('[data-number]')) { e.preventDefault(); e.target.blur(); } });
  root.addEventListener('change', e => {
    const field = e.target.dataset.number, o = selected(); if (!field || !o) return;
    const n = +e.target.value, min = +e.target.min, max = +e.target.max;
    if (e.target.value !== '' && Number.isFinite(n)) o[field] = Math.max(min, Math.min(max, n));
    sync(); changed();
  });
  root.addEventListener('change', e => { if (e.target.dataset.field) changed(); });
  // The photo rectangle on the canvas (the front crop on Canvas), with mm-to-px scale.
  function frame(item, pv) { return PhotoEditor.overlayFrame(item, pv.frontRect(item, pv.canvas.width, pv.canvas.height)); }
  // Pointer position in canvas pixels (CSS size differs from canvas size).
  function point(e, pv) { const r = pv.canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * pv.canvas.width / r.width, y: (e.clientY - r.top) * pv.canvas.height / r.height }; }
  // Overlay box in canvas px: centre (cx, cy), size, and rotation in radians.
  function geometry(ctx, o, f) {
    const box = PhotoRender.overlayBox(ctx, o, f), cx = f.x + o.x * f.w, cy = f.y + o.y * f.h;
    return { ...box, cx, cy, angle: (o.rot || 0) * Math.PI / 180 };
  }
  // Canvas point -> coordinates relative to the overlay's centre, un-rotated.
  function local(p, g) { const dx = p.x - g.cx, dy = p.y - g.cy; return { x: dx * Math.cos(g.angle) + dy * Math.sin(g.angle), y: -dx * Math.sin(g.angle) + dy * Math.cos(g.angle) }; }
  // Inverse of local(): overlay-relative (x, y) -> canvas point.
  function handle(g, x, y) { return { x: g.cx + x * Math.cos(g.angle) - y * Math.sin(g.angle), y: g.cy + x * Math.sin(g.angle) + y * Math.cos(g.angle) }; }
  // Resolve rotated handle geometry before choosing drag, resize, or rotation.
  function hit(e, item, pv) {
    // Handles: resize at the bottom-right corner, rotate on a stem 24 px above the top edge; 11 px grab radius.
    const p = point(e, pv), f = frame(item, pv), ctx = pv.ctx, radius = 11 * devicePixelRatio;
    if (selected()) {
      const g = geometry(ctx, selected(), f), resize = handle(g, g.w / 2, g.h / 2), rotate = handle(g, 0, -g.h / 2 - 24 * devicePixelRatio);
      if (Math.hypot(p.x - resize.x, p.y - resize.y) < radius) return { o: selected(), mode: 'resize', p, f, g };
      if (Math.hypot(p.x - rotate.x, p.y - rotate.y) < radius) return { o: selected(), mode: 'rotate', p, f, g };
    }
    // Topmost overlay first (last drawn), with a 3 px tolerance around the box.
    for (const o of [...(item.overlays || [])].reverse()) {
      const g = geometry(ctx, o, f), q = local(p, g);
      if (Math.abs(q.x) <= g.w / 2 + 3 * devicePixelRatio && Math.abs(q.y) <= g.h / 2 + 3 * devicePixelRatio) return { o, mode: 'move', p, f, g };
    }
    return null;
  }
  // Returns the drag state (hit info plus the overlay's starting values) or null when nothing was hit.
  function pointerDown(e, item, pv) {
    if (item !== selectedItem) sync();
    const h = hit(e, item, pv);
    select(h?.o.id || null);
    if (!h) return null;
    return { ...h, x: h.o.x, y: h.o.y, size: h.o.size, rot: h.o.rot,
      distance: Math.hypot(h.p.x - h.g.cx, h.p.y - h.g.cy), startAngle: Math.atan2(h.p.y - h.g.cy, h.p.x - h.g.cx) };
  }
  // Transform pointer movement into the selected overlay's frame coordinates.
  // Snap its edges or centre to the print bounds, safe margin, and other overlays.
  function pointerMove(e, drag, item, pv) {
    const p = point(e, pv), o = drag.o;
    if (drag.mode === 'move') {
      o.x = Math.max(0, Math.min(1, drag.x + (p.x - drag.p.x) / drag.f.w));
      o.y = Math.max(0, Math.min(1, drag.y + (p.y - drag.p.y) / drag.f.h));
      guides = null;
      if (magnet && !e.altKey) {
        // Snap targets: frame edges, a 5 mm safe margin, the centre, and other overlays' edges/centres;
        // snapping triggers within 2 mm, and Alt disables it.
        const f = drag.f, g = geometry(pv.ctx, o, f), margin = 5 * f.mmToPx, threshold = 2 * f.mmToPx;
        // ex/ey: half the rotated box's bounding width/height, so its edges (not its centre) snap.
        const ex = (Math.abs(Math.cos(g.angle)) * g.w + Math.abs(Math.sin(g.angle)) * g.h) / 2;
        const ey = (Math.abs(Math.sin(g.angle)) * g.w + Math.abs(Math.cos(g.angle)) * g.h) / 2;
        const targetsX = [{ at: f.x, edge: true }, { at: f.x + margin, edge: true }, { at: f.x + f.w / 2, edge: false },
          { at: f.x + f.w - margin, edge: true }, { at: f.x + f.w, edge: true }];
        const targetsY = [{ at: f.y, edge: true }, { at: f.y + margin, edge: true }, { at: f.y + f.h / 2, edge: false },
          { at: f.y + f.h - margin, edge: true }, { at: f.y + f.h, edge: true }];
        for (const other of item.overlays || []) if (other !== o) {
          const og = geometry(pv.ctx, other, f);
          const ox = (Math.abs(Math.cos(og.angle)) * og.w + Math.abs(Math.sin(og.angle)) * og.h) / 2;
          const oy = (Math.abs(Math.sin(og.angle)) * og.w + Math.abs(Math.cos(og.angle)) * og.h) / 2;
          targetsX.push({ at: og.cx - ox, edge: true }, { at: og.cx, edge: false }, { at: og.cx + ox, edge: true });
          targetsY.push({ at: og.cy - oy, edge: true }, { at: og.cy, edge: false }, { at: og.cy + oy, edge: true });
        }
        // Choose the nearest guide within the magnetic threshold.
        function snap(center, extent, targets) {
          let best = null;
          for (const target of targets) for (const offset of target.edge ? [-extent, extent] : [0]) {
            const delta = target.at - (center + offset), score = Math.abs(delta) * (target.edge ? 1 : .6); // centres win close calls
            if (Math.abs(delta) <= threshold && (!best || score < best.score)) best = { delta, score, target: target.at };
          }
          return best;
        }
        const sx = snap(g.cx, ex, targetsX), sy = snap(g.cy, ey, targetsY);
        if (sx) o.x = Math.max(0, Math.min(1, o.x + sx.delta / f.w));
        if (sy) o.y = Math.max(0, Math.min(1, o.y + sy.delta / f.h));
        if (sx || sy) guides = { x: sx?.target, y: sy?.target, f };
      }
    } else if (drag.mode === 'resize') {
      // Size scales with the pointer's distance from the centre relative to where the drag started; 3-80 mm like the slider.
      o.size = Math.max(3, Math.min(80, drag.size * Math.hypot(p.x - drag.g.cx, p.y - drag.g.cy) / Math.max(1, drag.distance)));
    // The +540 keeps the modulo positive and wraps the result into -180..180 degrees.
    } else o.rot = Math.round((drag.rot + (Math.atan2(p.y - drag.g.cy, p.x - drag.g.cx) - drag.startAngle) * 180 / Math.PI + 540) % 360 - 180);
  }
  // Dashed box, resize/rotate handles and snap guides for the selected overlay.
  function drawSelection(ctx, item, pv) {
    if (item !== selectedItem) sync();
    const o = selected(); if (!o || pv.canvas.hidden) return;
    const g = geometry(ctx, o, frame(item, pv)), k = devicePixelRatio;
    if (guides) {
      ctx.save(); ctx.beginPath(); ctx.rect(guides.f.x, guides.f.y, guides.f.w, guides.f.h); ctx.clip();
      ctx.strokeStyle = '#e00091'; ctx.lineWidth = k;
      if (guides.x !== undefined) { ctx.beginPath(); ctx.moveTo(guides.x, guides.f.y); ctx.lineTo(guides.x, guides.f.y + guides.f.h); ctx.stroke(); }
      if (guides.y !== undefined) { ctx.beginPath(); ctx.moveTo(guides.f.x, guides.y); ctx.lineTo(guides.f.x + guides.f.w, guides.y); ctx.stroke(); }
      ctx.restore();
    }
    ctx.save(); ctx.translate(g.cx, g.cy); ctx.rotate(g.angle);
    ctx.strokeStyle = '#2f6fdf'; ctx.lineWidth = 2 * k; ctx.setLineDash([5 * k, 4 * k]);
    ctx.strokeRect(-g.w / 2, -g.h / 2, g.w, g.h); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(0, -g.h / 2); ctx.lineTo(0, -g.h / 2 - 24 * k); ctx.stroke();
    for (const [x, y] of [[g.w / 2, g.h / 2], [0, -g.h / 2 - 24 * k]]) {
      ctx.beginPath(); ctx.arc(x, y, 7 * k, 0, 2 * Math.PI); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  }
  // Cursor for the hovered handle or overlay, or null for the stage's default.
  function cursor(e, item, pv) { const h = item && hit(e, item, pv); return h ? h.mode === 'move' ? 'move' : h.mode === 'resize' ? 'nwse-resize' : 'crosshair' : null; }
  function doubleClick(e, pv) { const h = state.item && hit(e, state.item, pv); if (h?.o.type === 'text') { select(h.o.id); root.querySelector('textarea').focus(); } }
  function clearGuides() { guides = null; preview.redraw(); }
  return { sync, select, selected, changed, pointerDown, pointerMove, drawSelection, cursor, doubleClick, clearGuides };
}
