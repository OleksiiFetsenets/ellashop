'use strict';
// Shared photo editor: crop, fit, zoom, pan, rotate, coordinates, overlays and history for one item.
// Pages (Prints, Canvas, Passport, Collage) call this instead of keeping their own copies.
// Loaded by index.html after render.js, ui.js, editor.js and tabs.js.
//
// Moved here from (the old copies are gone):
//   PhotoEditor.srcDims / outMM / placement      ← render.js srcDims / outMM / placement
//   PhotoEditor.rotatedFace                      ← prints.js rotatedFace
//   PhotoEditor.rotate / clampTilt / setTilt     ← prints.js #rot-l/#rot-r handlers, tabs.js clampTilt
//   PhotoEditor.clampZoom / setZoom / wheelZoom  ← tabs.js clampZoom, prints.js #zoom, ui.js Preview wheel
//   PhotoEditor.pan                              ← ui.js panOnCanvas
//   PhotoEditor.setMode / reset                  ← prints.js #mode and #reset handlers
//   PhotoEditor.smartPlace                       ← prints.js autoPlace
//   PhotoEditor.detectFaces                      ← prints.js runFaceQueue (request + scaling only)
//   PhotoEditor.drawFaces                        ← prints.js faceOverlay (checkbox lookup removed)
//   PhotoEditor.newItem                          ← tabs.js newItem
//   PhotoEditor.Stage                            ← ui.js Preview
//   PhotoEditor.attachOverlays                   ← editor.js textAndStickers (as used by prints.js)
//   PhotoEditor.History                          ← history.js recordHistory / commitHistory / undo / redo

const PhotoEditor = (() => {
  // ------------------------------------------------------------ coordinates

  // Source size after the 90° rotation steps.
  function srcDims(item) {
    const { naturalWidth: w, naturalHeight: h } = item.img;
    return item.rot % 180 ? { w: h, h: w } : { w, h };
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
    // cx/cy are the crop centre as fractions of the rotated source.
    const vw = W / s / d.w, vh = H / s / d.h; // visible fraction of the source
    // Keep the visible window inside the photo; if it is larger than the photo, centre it.
    const clamp = (c, v) => (v >= 1 ? 0.5 : Math.min(1 - v / 2, Math.max(v / 2, c)));
    if (fit) { item.cx = item.cy = 0.5; }
    else if (item.free) { /* passport: may move past the photo edge; bg colour fills the gap */ }
    else { item.cx = clamp(item.cx, vw); item.cy = clamp(item.cy, vh); }
    return { s, d };
  }

  // Map a box in original-photo pixels into the rotated source used by the crop.
  function rotatedFace(face, item) {
    const w = item.img.naturalWidth, h = item.img.naturalHeight;
    const { x, y, w: fw, h: fh } = face;
    if (item.rot === 90) return { x: h - y - fh, y: x, w: fh, h: fw };
    if (item.rot === 180) return { x: w - x - fw, y: h - y - fh, w: fw, h: fh };
    if (item.rot === 270) return { x: y, y: w - x - fw, w: fh, h: fw };
    return face;
  }

  // ------------------------------------------------------------ item

  // Default edit state for a photo; `extra` overrides. Passport and measured custom formats start without an overlays list.
  function newItem(img, name, extra) {
    const overlayDefault = (PASSPORT.includes(extra?.fmt) || (extra?.fmt?.custom && extra.fmt.measure)) ? {} : { overlays: [] };
    return { img, name, rot: 0, tilt: 0, zoom: 1, cx: 0.5, cy: 0.5, orient: 'auto', mode: 'fill', bg: '#ffffff', density: 0, ...overlayDefault, ...extra };
  }

  // A manual edit cancels smart placement for this item.
  function manual(item) { item.auto = ''; item.smartPending = false; }

  // ------------------------------------------------------------ rotate

  // Tilt is limited to +/-20 degrees (straightening, not rotation).
  const clampTilt = tilt => Math.min(20, Math.max(-20, tilt));
  function setTilt(item, tilt) { item.tilt = clampTilt(tilt); }

  // Turn by a multiple of 90° (+90 right, -90 left); smart-placed items are placed again.
  function rotate(item, degrees) {
    item.rot = ((item.rot + degrees) % 360 + 360) % 360;
    if (item.auto) smartPlace(item);
  }

  // ------------------------------------------------------------ zoom / fit / crop

  // Passport photos zoom 0.3–15 (close-up selfies shrink, distant faces grow); others 1–6.
  const clampZoom = (item, z) => item.free ? Math.min(15, Math.max(.3, z)) : Math.min(6, Math.max(1, z));
  const canZoom = item => item.mode !== 'fit' && item.mode !== 'blur';

  function setZoom(item, zoom) { item.zoom = clampZoom(item, zoom); manual(item); }
  // Mouse wheel step; returns false when the current mode has no zoom.
  function wheelZoom(item, deltaY) {
    if (!canZoom(item)) return false;
    // Exponential so equal wheel travel gives an equal zoom ratio; 0.0015 per wheel delta unit.
    item.zoom = clampZoom(item, item.zoom * Math.exp(-deltaY * 0.0015));
    return true;
  }

  // 'fill' (crop), 'fit' (whole photo on background) or 'blur' (whole photo on blurred copy).
  function setMode(item, mode) { item.mode = mode; manual(item); }

  function reset(item) { Object.assign(item, { zoom: 1, cx: .5, cy: .5, tilt: 0 }); manual(item); }

  // ------------------------------------------------------------ pan

  // Move the photo by (dx, dy) CSS pixels as drawn on `canvas`, in screen directions even when tilted.
  // frontRect gives where the photo crop sits on the canvas.
  function pan(item, canvas, frontRect, dx, dy) {
    if (!canZoom(item)) return;
    const k = canvas.width / canvas.getBoundingClientRect().width;
    const front = frontRect(item, canvas.width, canvas.height), { s, d } = placement(item, front.w, front.h);
    // Undo the tilt so a screen-space drag maps onto the rotated source; k converts CSS px to canvas px.
    const a = -item.tilt * Math.PI / 180;
    item.cx -= (dx * Math.cos(a) - dy * Math.sin(a)) * k / s / d.w;
    item.cy -= (dx * Math.sin(a) + dy * Math.cos(a)) * k / s / d.h;
  }

  // ------------------------------------------------------------ smart placement (faces)

  // Always crop to fill, keeping every head in with a little room above and letting
  // legs/hands go off the edges. Blurred border only when the faces can't fit.
  function smartPlace(item, sizeMM = outMM) {
    const mm = sizeMM(item), W = mm.w, H = mm.h, d = srcDims(item);
    const s = Math.max(W / d.w, H / d.h);
    const windowW = W / s, windowH = H / s;
    // windowW/windowH: the part of the source (in source px) visible at zoom 1 in fill mode.
    const faces = (item.faces || []).map(f => rotatedFace(f, item));
    item.zoom = 1; item.cx = item.cy = .5; item.mode = 'fill';
    if (faces.length) {
      // Whole head: hair above the detected face box, chin/neck below, ears to the sides.
      const left = Math.max(0, Math.min(...faces.map(f => f.x - .3 * f.w)));
      const right = Math.min(d.w, Math.max(...faces.map(f => f.x + 1.3 * f.w)));
      const top = Math.max(0, Math.min(...faces.map(f => f.y - .6 * f.h)));
      const bottom = Math.min(d.h, Math.max(...faces.map(f => f.y + 1.4 * f.h)));
      if (right - left > windowW || bottom - top > windowH) {
        item.mode = 'blur'; item.auto = "blur: faces don't fit";
      } else {
        item.auto = 'faces';
        item.cx = (left + right) / 2 / d.w;
        // Heads near the top: leave 8% of the frame above the highest head, crop the rest below.
        const headroom = Math.min(.08 * windowH, windowH - (bottom - top));
        item.cy = (top - headroom + windowH / 2) / d.h;
      }
    // No faces: centre horizontally and sit slightly above middle (.45) to favour the upper body.
    } else { item.auto = 'centre'; item.cy = .45; }
    placement(item, W, H);
  }

  // Ask the server for faces; returns boxes in original-photo pixels.
  async function detectFaces(item) {
    const image = await (await fetch(item.img.src)).blob();
    const res = await fetch('/api/faces', { method: 'POST', body: image });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('prints_face_detection_failed'));
    // The server may downscale before detecting; scale the boxes back to the full photo.
    const kx = item.img.naturalWidth / data.width, ky = item.img.naturalHeight / data.height;
    return data.faces.map(f => ({ ...f, x: f.x * kx, y: f.y * ky, w: f.w * kx, h: f.h * ky }));
  }

  // Green boxes around detected faces (preview only).
  function drawFaces(ctx, item) {
    if (!item.faces?.length) return;
    const W = ctx.canvas.width, H = ctx.canvas.height, { s, d } = placement(item, W, H);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    ctx.translate(W / 2, H / 2); ctx.rotate(item.tilt * Math.PI / 180);
    ctx.scale(s, s); ctx.translate(-item.cx * d.w, -item.cy * d.h);
    ctx.strokeStyle = '#26c46a'; ctx.lineWidth = Math.max(1, devicePixelRatio) / s;
    for (const f of item.faces) {
      const box = rotatedFace(f, item);
      ctx.strokeRect(box.x, box.y, box.w, box.h);
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ stage (interactive preview)

  // Drag to pan, drag a corner to tilt, wheel to zoom; fits inside its stage element.
  // Options: getItem, onChange(settled), overlay(ctx, item, pxPerMM), sizeMM, render, frontRect, frameDraw.
  class Stage {
    constructor(canvas, stage, { getItem, onChange, overlay, sizeMM = outMM, render = PhotoRender.renderItem, frontRect = (item, W, H) => ({ x: 0, y: 0, w: W, h: H }), frameDraw = false }) {
      Object.assign(this, { canvas, stage, getItem, onChange, overlay, sizeMM, render, frontRect, frameDraw });
      this.ctx = canvas.getContext('2d');
      let last = null, rotating = null, overlayDrag = null;
      // Pointer is within 16 px of a corner handle (handles are drawn 10 px in from each corner).
      const corner = e => {
        const r = canvas.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        return [[10, 10], [r.width - 10, 10], [10, r.height - 10], [r.width - 10, r.height - 10]]
          .some(([cx, cy]) => Math.hypot(x - cx, y - cy) <= 16);
      };
      // Angle of the pointer around the canvas centre, used for corner-drag tilting.
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
          // Wrap the change into -PI..PI so crossing the +/-180 degree seam does not jump.
          let delta = angle(e) - rotating.angle;
          if (delta > Math.PI) delta -= 2 * Math.PI;
          if (delta < -Math.PI) delta += 2 * Math.PI;
          setTilt(item, rotating.tilt + delta * 180 / Math.PI);
        } else this.pan(item, e.clientX - last[0], e.clientY - last[1]);
        last = [e.clientX, e.clientY];
        this.redraw();
        if (overlayDrag) this.overlayEditor.changed(false); else this.onChange(false);
      });
      canvas.addEventListener('dblclick', e => this.overlayEditor?.doubleClick(e, this));
      canvas.addEventListener('wheel', e => {
        const item = this.getItem(); if (!item || !canZoom(item)) return;
        e.preventDefault();
        wheelZoom(item, e.deltaY);
        this.redraw(); this.onChange(true);
      }, { passive: false });
      new ResizeObserver(() => this.draw()).observe(stage);
    }
    // With frameDraw, coalesce redraws into one per animation frame (for expensive renders).
    redraw() {
      if (!this.frameDraw) return this.draw();
      if (this.framePending) return;
      this.framePending = true;
      requestAnimationFrame(() => { this.framePending = false; this.draw(); });
    }
    pan(item, dx, dy) { pan(item, this.canvas, this.frontRect, dx, dy); }
    draw() {
      const item = this.getItem();
      this.canvas.classList.toggle('show', !!item);
      if (!item) return;
      const mm = this.sizeMM(item);
      const r = this.stage.getBoundingClientRect();
      const cs = getComputedStyle(this.stage); // padding leaves room for the passport tab bar
      // Fit the item's aspect ratio into the stage minus margins; canvas pixels = CSS size * devicePixelRatio.
      const maxW = r.width - 48, maxH = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 8;
      const scale = Math.min(maxW / mm.w, maxH / mm.h);
      const cw = Math.max(50, mm.w * scale), ch = Math.max(50, mm.h * scale);
      const k = devicePixelRatio;
      this.canvas.style.width = cw + 'px'; this.canvas.style.height = ch + 'px';
      this.canvas.width = Math.round(cw * k); this.canvas.height = Math.round(ch * k);
      this.canvas.style.filter = PhotoRender.densityFilter(item.density);
      this.render(this.ctx, item, this.canvas.width, this.canvas.height);
      if (this.showMeasure) drawMeasurements(this.ctx, mm, this.canvas.width / mm.w);  // under the guides
      if (this.composition) drawComposition(this.ctx, this.frontRect(item, this.canvas.width, this.canvas.height), this.composition, this.compositionTurn || 0);
      if (this.overlay) this.overlay(this.ctx, item, this.canvas.width / mm.w);
      this.overlayEditor?.drawSelection(this.ctx, item, this);
      // Blue round handles in the four corners: drag one to tilt the photo.
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

  // ------------------------------------------------------------ overlays (text & stickers)

  // Attach the text/sticker editor panel to a stage. `state` has items/sel/item like prints.
  function attachOverlays(panel, state, refresh, stage) {
    stage.overlayEditor = textAndStickers(panel, state, refresh, stage);
    return stage.overlayEditor;
  }

  // ------------------------------------------------------------ history (undo / redo)

  // Undo/redo over settled states. A step is recorded `delay` ms after the last change, so a drag,
  // a slider move or a burst of typing is one step. getState() returns JSON-able state;
  // applyState(state) rebuilds it (may be async); busy() pauses recording; onChange() updates buttons.
  class History {
    constructor({ getState, applyState, busy = () => false, onChange = () => {}, limit = 60, delay = 350 }) {
      Object.assign(this, { getState, applyState, busy, onChange, limit, delay });
      this.past = []; this.future = []; this.current = null; this.timer = 0; this.restoring = false;
    }
    // restoring is true while an undo/redo is being applied, so the changes it makes are not recorded as new steps.
    snapshot() { return JSON.stringify(this.getState()); }
    record() {
      if (this.busy() || this.restoring) return;
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.commit(), this.delay);
    }
    commit() {
      clearTimeout(this.timer); this.timer = 0;
      if (this.busy() || this.restoring) return;
      const now = this.snapshot();
      if (now === this.current) return;
      if (this.current !== null) { this.past.push(this.current); if (this.past.length > this.limit) this.past.shift(); }
      this.future = []; this.current = now;
      this.onChange();
    }
    reset() {
      clearTimeout(this.timer); this.timer = 0;
      this.past = []; this.future = []; this.current = this.snapshot();
      this.onChange();
    }
    async apply(json) {
      this.restoring = true;
      try { await this.applyState(JSON.parse(json)); }
      finally {
        this.current = this.snapshot();
        this.restoring = false;
        clearTimeout(this.timer); this.timer = 0;
        this.onChange();
      }
    }
    async undo() {
      if (this.timer) this.commit();
      if (!this.past.length || this.restoring) return;
      this.future.push(this.current);
      await this.apply(this.past.pop());
    }
    async redo() {
      if (!this.future.length || this.restoring) return;
      this.past.push(this.current);
      await this.apply(this.future.pop());
    }
    get canUndo() { return !!this.past.length || !!this.timer; }
    get canRedo() { return !!this.future.length; }
  }

  return {
    srcDims, outMM, placement, rotatedFace, newItem,
    clampTilt, setTilt, rotate,
    clampZoom, canZoom, setZoom, wheelZoom, setMode, reset,
    pan, smartPlace, detectFaces, drawFaces,
    Stage, attachOverlays, History,
  };
})();
