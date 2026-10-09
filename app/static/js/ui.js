'use strict';
// Provides shared drop zones, previews, measurements, and composition guides.
// Loads before editor.js and the photo-tab scripts that create previews.
// Make a drop zone (label + hidden file input) accept images and .zip archives; zips are unpacked by the
// server into the incoming folder and fetched back as Files. `onFiles` receives only the image files.
function wireDrop(label, input, onFiles) {
  const status = label.closest('.view')?.querySelector('.status');
  const receive = async files => {
    const images = [];
    try {
      for (const file of files) {
        if (['application/zip', 'application/x-zip-compressed'].includes(file.type) || file.name.toLowerCase().endsWith('.zip')) {
          if (status) setStatus(status, t('common_unpacking', file.name));
          const response = await fetch('/api/unzip?name=' + encodeURIComponent(file.name), { method: 'POST', body: file });
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || t('common_unpack_failed', response.status));
          for (const name of result.files) {
            const photo = await fetch('/incoming/' + encodeURIComponent(name));
            if (!photo.ok) throw new Error(t('common_load_failed', name));
            const blob = await photo.blob();
            images.push(new File([blob], name, { type: blob.type }));
          }
          if (status) setStatus(status, t('common_unpacked_photos', result.files.length));
        } else if (file.type.startsWith('image/')) images.push(file);
      }
      if (images.length) await onFiles(images);
    } catch (e) { if (status) setStatus(status, e.message, true); }
  };
  input.addEventListener('change', () => { receive([...input.files]); input.value = ''; });
  label.addEventListener('dragover', e => { e.preventDefault(); label.classList.add('over'); });
  label.addEventListener('dragleave', () => label.classList.remove('over'));
  label.addEventListener('drop', e => {
    e.preventDefault(); label.classList.remove('over');
    receive([...e.dataTransfer.files]);
  });
}

// Segmented button group: highlights the clicked button and passes its data-v to `onPick`.
function wireSeg(container, onPick) {
  container.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    [...container.children].forEach(x => x.classList.toggle('on', x === b));
    onPick(b.dataset.v);
  });
}
// Highlight the button whose data-v is `v` (without calling any handler).
function setSeg(container, v) { [...container.children].forEach(x => x.classList.toggle('on', x.dataset.v === v)); }

// Move the photo by (dx, dy) CSS pixels as drawn on `canvas` (the preview or a grid card),
// in screen directions even when tilted. frontRect gives where the photo crop sits on the canvas.
// Convert preview drag distance into a crop-centre shift in source space.
function panOnCanvas(item, canvas, frontRect, dx, dy) {
  if (item.mode === 'fit' || item.mode === 'blur') return;
  const k = canvas.width / canvas.getBoundingClientRect().width;
  const front = frontRect(item, canvas.width, canvas.height), { s, d } = placement(item, front.w, front.h);
  const t = -item.tilt * Math.PI / 180;
  item.cx -= (dx * Math.cos(t) - dy * Math.sin(t)) * k / s / d.w;
  item.cy -= (dx * Math.sin(t) + dy * Math.cos(t)) * k / s / d.h;
}

// Centimetre rulers along the top and left edges plus a faint grid, in the single-view preview only
// (never in saved files or grid cards). Tick spacing adapts so labels never crowd (1, 2, 5 or 10 cm).
// Draw centimetre rulers and guides over the preview without affecting export.
function drawMeasurements(ctx, mm, pxPerMM) {
  const k = devicePixelRatio, W = ctx.canvas.width, H = ctx.canvas.height, band = 18 * k;
  // Smallest label spacing (1, 2, 5 or 10 cm, in mm) that leaves at least 34 CSS px between labels.
  const step = [10, 20, 50, 100].find(s => s * pxPerMM >= 34 * k) || 100;  // mm between labels
  const minor = step === 10 ? (pxPerMM >= 4 * k ? 1 : 5) : step / 5;    // mm between small ticks
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = k; ctx.setLineDash([3 * k, 4 * k]);
  for (let x = step; x < mm.w; x += step) { ctx.beginPath(); ctx.moveTo(x * pxPerMM, band); ctx.lineTo(x * pxPerMM, H); ctx.stroke(); }
  for (let y = step; y < mm.h; y += step) { ctx.beginPath(); ctx.moveTo(band, y * pxPerMM); ctx.lineTo(W, y * pxPerMM); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.fillRect(0, 0, W, band); ctx.fillRect(0, band, band, H - band);
  ctx.strokeStyle = '#333'; ctx.fillStyle = '#222';
  ctx.font = `${10 * k}px -apple-system, system-ui, sans-serif`; ctx.textBaseline = 'top';
  // Tick height: tall at label steps, medium at every 5 mm, short otherwise. Positions are compared in
  // thousandths of a mm (x * 1000) to avoid float error from fractional steps.
  for (let x = minor; x < mm.w; x += minor) {
    const big = Math.round(x * 1000) % (step * 1000) === 0, mid = !big && Math.round(x * 1000) % 5000 === 0;
    const t = big ? band * .55 : mid ? band * .35 : band * .2, px = Math.round(x * pxPerMM) + .5;
    ctx.beginPath(); ctx.moveTo(px, band); ctx.lineTo(px, band - t); ctx.stroke();
    if (big) { ctx.textAlign = 'center'; ctx.fillText(String(+(x / 10).toFixed(1)), px, 2 * k); }
  }
  for (let y = minor; y < mm.h; y += minor) {
    const big = Math.round(y * 1000) % (step * 1000) === 0, mid = !big && Math.round(y * 1000) % 5000 === 0;
    const t = big ? band * .55 : mid ? band * .35 : band * .2, py = Math.round(y * pxPerMM) + .5;
    ctx.beginPath(); ctx.moveTo(band, py); ctx.lineTo(band - t, py); ctx.stroke();
    if (big) { ctx.save(); ctx.translate(2 * k, py); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(String(+(y / 10).toFixed(1)), 0, 0); ctx.restore(); }
  }
  ctx.textAlign = 'left'; ctx.fillText(t('common_cm'), 3 * k, 4 * k);
  ctx.restore();
}

// Composition guides over the photo frame (preview only). `turn` 0–3 flips the spiral/triangles
// and moves the perspective vanishing point (centre → thirds points).
// Golden ratio.
const PHI = (1 + Math.sqrt(5)) / 2;
// Draw the selected composition guide only over the on-screen preview.
function drawComposition(ctx, r, type, turn) {
  const k = devicePixelRatio;
  ctx.save();
  ctx.beginPath(); ctx.rect(r.x, r.y, r.w, r.h); ctx.clip();
  ctx.beginPath();
  const line = (x0, y0, x1, y1) => { ctx.moveTo(r.x + x0 * r.w, r.y + y0 * r.h); ctx.lineTo(r.x + x1 * r.w, r.y + y1 * r.h); };
  // turn bit 0 mirrors horizontally, bit 1 vertically.
  const flipX = turn & 1, flipY = turn & 2, fx = v => flipX ? 1 - v : v, fy = v => flipY ? 1 - v : v;
  if (type === 'thirds' || type === 'golden') {
    for (const v of type === 'thirds' ? [1 / 3, 2 / 3] : [1 - 1 / PHI, 1 / PHI]) { line(v, 0, v, 1); line(0, v, 1, v); }
  } else if (type === 'diagonals') {
    line(0, 0, 1, 1); line(1, 0, 0, 1);
    const s = Math.min(r.w, r.h), dx = s / r.w, dy = s / r.h;  // 45° lines from each corner
    line(0, 0, dx, dy); line(1, 0, 1 - dx, dy); line(0, 1, dx, 1 - dy); line(1, 1, 1 - dx, 1 - dy);
  } else if (type === 'triangles') {
    // diagonal from (fx0,fy0) to (fx1,fy1); perpendiculars from the two other corners meet it
    const A = [fx(0), fy(0)], B = [fx(1), fy(1)], d = [(B[0] - A[0]) * r.w, (B[1] - A[1]) * r.h], len2 = d[0] ** 2 + d[1] ** 2;
    line(...A, ...B);
    for (const C of [[fx(1), fy(0)], [fx(0), fy(1)]]) {
      const t = (((C[0] - A[0]) * r.w) * d[0] + ((C[1] - A[1]) * r.h) * d[1]) / len2;
      line(...C, A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1]));
    }
  } else if (type === 'perspective') {
    const vp = [[.5, .5], [1 / 3, 1 / 3], [2 / 3, 1 / 3], [2 / 3, 2 / 3]][turn % 4];
    line(0, vp[1], 1, vp[1]);  // horizon
    // 24 rays every 15 degrees; len = 3 frame heights is long enough to cross the frame from any vanishing point.
    for (let i = 0; i < 24; i++) {  // rays from the vanishing point
      const a = i * Math.PI / 12, len = 3;
      line(vp[0], vp[1], vp[0] + Math.cos(a) * len * r.h / r.w, vp[1] + Math.sin(a) * len);
    }
  } else if (type === 'spiral') {
    // Golden spiral built in a canonical φ×1 rectangle, mapped onto the frame (rotated for portrait,
    // flipped by `turn`). The path is built under the transform and stroked without it, so the
    // line stays an even width even though the frame isn't exactly golden.
    ctx.save();
    ctx.translate(r.x + r.w / 2, r.y + r.h / 2); ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1); ctx.translate(-r.w / 2, -r.h / 2);
    if (r.h > r.w) { ctx.translate(r.w, 0); ctx.rotate(Math.PI / 2); ctx.scale(r.h / PHI, r.w); } else ctx.scale(r.w / PHI, r.h);
    let x = 0, y = 0, w = PHI, h = 1;
    // Each step cuts a square off one side of the remaining rectangle (left, top, right, bottom in turn)
    // and draws its dividing line plus a quarter-circle arc; 12 steps reach well below pixel size.
    for (let i = 0; i < 12; i++) {
      const side = i % 4;
      if (side === 0) { const s = h; ctx.moveTo(x + s, y); ctx.lineTo(x + s, y + s); ctx.moveTo(x, y + s); ctx.arc(x + s, y + s, s, Math.PI, 1.5 * Math.PI); x += s; w -= s; }
      else if (side === 1) { const s = w; ctx.moveTo(x, y + s); ctx.lineTo(x + s, y + s); ctx.moveTo(x, y); ctx.arc(x, y + s, s, 1.5 * Math.PI, 2 * Math.PI); y += s; h -= s; }
      else if (side === 2) { const s = h; ctx.moveTo(x + w - s, y); ctx.lineTo(x + w - s, y + s); ctx.moveTo(x + w, y); ctx.arc(x + w - s, y, s, 0, .5 * Math.PI); w -= s; }
      else { const s = w; ctx.moveTo(x, y + h - s); ctx.lineTo(x + s, y + h - s); ctx.moveTo(x + s, y + h); ctx.arc(x + s, y + h - s, s, .5 * Math.PI, Math.PI); h -= s; }
    }
    ctx.restore();
  }
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,.45)'; ctx.lineWidth = 3 * k; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.9)'; ctx.lineWidth = 1.2 * k; ctx.stroke();
  ctx.restore();
}

// Interactive preview: drag to pan, wheel to zoom, fits inside its stage.
// Options: getItem, onChange(settled), overlay(ctx, item, pxPerMM), sizeMM, render, frontRect, frameDraw
// (frameDraw: coalesce redraws to one per animation frame).
class Preview {
  constructor(canvas, stage, { getItem, onChange, overlay, sizeMM = outMM, render = renderItem, frontRect = (item, W, H) => ({ x: 0, y: 0, w: W, h: H }), frameDraw = false }) {
    Object.assign(this, { canvas, stage, getItem, onChange, overlay, sizeMM, render, frontRect, frameDraw });
    this.ctx = canvas.getContext('2d');
    let last = null, rotating = null, overlayDrag = null;
    const corner = e => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      return [[10, 10], [r.width - 10, 10], [10, r.height - 10], [r.width - 10, r.height - 10]]
        .some(([cx, cy]) => Math.hypot(x - cx, y - cy) <= 16);
    };
    const angle = e => {
      const r = canvas.getBoundingClientRect();
      return Math.atan2(e.clientY - r.top - r.height / 2, e.clientX - r.left - r.width / 2);
    };
    canvas.addEventListener('pointerdown', e => {
      const item = this.getItem(); if (!item) return;
      last = [e.clientX, e.clientY];
      overlayDrag = this.overlayEditor?.pointerDown(e, item, this) || null;
      if (!overlayDrag && corner(e)) rotating = { tilt: item.tilt, angle: angle(e) };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointerup', () => { if (last) { if (overlayDrag) this.overlayEditor.changed(true); else this.onChange(true); } last = rotating = overlayDrag = null; this.overlayEditor?.clearGuides(); });
    canvas.addEventListener('pointercancel', () => { last = rotating = overlayDrag = null; this.overlayEditor?.clearGuides(); });
    canvas.addEventListener('pointermove', e => {
      const item = this.getItem();
      if (!last) { canvas.style.cursor = this.overlayEditor?.cursor(e, item, this) || (corner(e) && item ? 'alias' : 'grab'); return; }
      if (!item) return;
      if (overlayDrag) this.overlayEditor.pointerMove(e, overlayDrag, item, this);
      else if (rotating) {
        let delta = angle(e) - rotating.angle;
        if (delta > Math.PI) delta -= 2 * Math.PI;
        if (delta < -Math.PI) delta += 2 * Math.PI;
        item.tilt = clampTilt(rotating.tilt + delta * 180 / Math.PI);
      } else this.pan(item, e.clientX - last[0], e.clientY - last[1]);
      last = [e.clientX, e.clientY];
      this.redraw();
      if (overlayDrag) this.overlayEditor.changed(false); else this.onChange(false);
    });
    canvas.addEventListener('dblclick', e => this.overlayEditor?.doubleClick(e, this));
    canvas.addEventListener('wheel', e => {
      const item = this.getItem(); if (!item || item.mode === 'fit' || item.mode === 'blur') return;
      e.preventDefault();
      item.zoom = clampZoom(item, item.zoom * Math.exp(-e.deltaY * 0.0015));
      this.redraw(); this.onChange(true);
    }, { passive: false });
    new ResizeObserver(() => this.draw()).observe(stage);
  }
  redraw() {
    if (!this.frameDraw) return this.draw();
    if (this.framePending) return;
    this.framePending = true;
    requestAnimationFrame(() => { this.framePending = false; this.draw(); });
  }
  // Move the photo by (dx, dy) screen pixels, in screen directions even when tilted.
  pan(item, dx, dy) { panOnCanvas(item, this.canvas, this.frontRect, dx, dy); }
  draw() {
    const item = this.getItem();
    this.canvas.classList.toggle('show', !!item);
    if (!item) return;
    const mm = this.sizeMM(item);
    const r = this.stage.getBoundingClientRect();
    const cs = getComputedStyle(this.stage); // padding leaves room for the passport tab bar
    const maxW = r.width - 48, maxH = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 8;
    const scale = Math.min(maxW / mm.w, maxH / mm.h);
    const cw = Math.max(50, mm.w * scale), ch = Math.max(50, mm.h * scale);
    const k = devicePixelRatio;
    this.canvas.style.width = cw + 'px'; this.canvas.style.height = ch + 'px';
    this.canvas.width = Math.round(cw * k); this.canvas.height = Math.round(ch * k);
    this.canvas.style.filter = densityFilter(item.density);
    this.render(this.ctx, item, this.canvas.width, this.canvas.height);
    if (this.showMeasure) drawMeasurements(this.ctx, mm, this.canvas.width / mm.w);  // under the guides
    if (this.composition) drawComposition(this.ctx, this.frontRect(item, this.canvas.width, this.canvas.height), this.composition, this.compositionTurn || 0);
    if (this.overlay) this.overlay(this.ctx, item, this.canvas.width / mm.w);
    this.overlayEditor?.drawSelection(this.ctx, item, this);
    this.ctx.save();
    this.ctx.fillStyle = '#2f6fdf';
    this.ctx.strokeStyle = '#fff';
    this.ctx.lineWidth = 2 * k;
    for (const x of [10 * k, this.canvas.width - 10 * k]) for (const y of [10 * k, this.canvas.height - 10 * k]) {
      this.ctx.beginPath(); this.ctx.arc(x, y, 5 * k, 0, 2 * Math.PI);
      this.ctx.fill(); this.ctx.stroke();
    }
    this.ctx.restore();
  }
}

