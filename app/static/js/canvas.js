'use strict';
// Manages Canvas crops, blurred wrap previews, and printed output.
// Loads after prints.js so it can share the photo grid and queue controls.
// ---------------------------------------------------------------- canvas

const canvasPrints = {
  items: [], sel: null,
  last: { fmt: CANVAS_FORMATS[0], orient: 'auto', wrap: 5, blur: 'motion', strength: 50, marks: false },
  get item() { return this.items.find(i => i === this.sel) || null; },
};

function canvasMM(item) {
  const front = outMM(item);
  return { w: front.w + item.wrap * 20, h: front.h + item.wrap * 20 };
}

function canvasFront(item, W, H) {
  const outer = canvasMM(item), front = outMM(item);
  const w = W * front.w / outer.w, h = H * front.h / outer.h;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

function canvasKey(item, W, H) {
  return [W, H, item.img.src, item.fmt.id, item.orient, item.wrap, item.blur, item.strength,
    item.rot, item.tilt, item.zoom, item.cx, item.cy].join('|');
}

// Create a low-resolution, cached enlargement of the sharp front crop.
// Gaussian or layered motion blur fills the wrap without stretching sharp detail.
function blurredBackdrop(item, source, W, H, key) {
  if (item.wrapCache?.key === key) return item.wrapCache.canvas;
  const scale = 600 / Math.max(W, H), w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const blur = document.createElement('canvas'); blur.width = w; blur.height = h;
  const ctx = blur.getContext('2d');
  const length = Math.max(2, Math.round(item.strength * Math.max(w, h) / 750));
  const cover = Math.max(w / source.width, h / source.height);
  const dw = source.width * cover + length * 3, dh = source.height * cover + length * 3;
  const x = (w - dw) / 2, y = (h - dh) / 2;
  if (item.blur === 'gaussian') {
    ctx.filter = `blur(${length}px)`;
    ctx.drawImage(source, x, y, dw, dh);
    ctx.filter = 'none';
  } else {
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

function canvasBackground(item, W, H) {
  const key = canvasKey(item, W, H);
  if (item.wrapCache?.key === key) return item.wrapCache.canvas;
  const scale = 600 / Math.max(W, H), w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const front = canvasFront(item, w, h);
  const source = document.createElement('canvas');
  source.width = Math.max(1, Math.round(front.w)); source.height = Math.max(1, Math.round(front.h));
  renderItem(source.getContext('2d'), item, source.width, source.height, false);
  return blurredBackdrop(item, source, W, H, key);
}

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

// Print the blurred wrap, sharp front, and front-only overlays in that order.
function renderCanvas(ctx, item, W, H, preview = false) {
  const bg = canvasBackground(item, W, H);
  ctx.save(); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bg, 0, 0, W, H);
  const front = canvasFront(item, W, H);
  ctx.save(); ctx.translate(front.x, front.y);
  renderItem(ctx, item, front.w, front.h, false);
  ctx.restore();
  drawOverlays(ctx, item, overlayFrame(item, front));
  if (item.marks) {
    ctx.strokeStyle = '#888'; ctx.lineWidth = Math.max(1, W / 2000);
    ctx.beginPath();
    for (const x of [front.x, front.x + front.w]) {
      ctx.moveTo(x, 0); ctx.lineTo(x, front.y);
      ctx.moveTo(x, front.y + front.h); ctx.lineTo(x, H);
    }
    for (const y of [front.y, front.y + front.h]) {
      ctx.moveTo(0, y); ctx.lineTo(front.x, y);
      ctx.moveTo(front.x + front.w, y); ctx.lineTo(W, y);
    }
    ctx.stroke();
  }
  if (preview) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * devicePixelRatio;
    ctx.setLineDash([6 * devicePixelRatio, 5 * devicePixelRatio]);
    ctx.strokeRect(front.x, front.y, front.w, front.h);
  }
  ctx.restore();
}

canvasPrints.preview = new Preview($('#canvas-preview'), $('#canvas-stage'), {
  getItem: () => canvasPrints.item,
  onChange: () => { syncCanvasControls(); queueSave('canvas'); },
  sizeMM: canvasMM, frontRect: canvasFront,
  frameDraw: true,
  render: (ctx, item, W, H) => renderCanvas(ctx, item, W, H, true),
});
canvasPrints.preview.overlayEditor = textAndStickers($('#canvas-overlays'), canvasPrints, refreshCanvas, canvasPrints.preview);

$('#canvas-formats').innerHTML = CANVAS_FORMATS.map(f => `<button data-id="${f.id}">${fmtLabel(f)}</button>`).join('');

const syncCanvasCustom = customSizeControl('#canvas-formats', CANVAS_FORMATS, [10, 200, 10, 200], () => canvasPrints.item?.fmt, fmt => canvasSetting('fmt', fmt), '#canvas-status');

const syncCanvasDensity = densityControl($('#canvas-density'), { item: () => canvasPrints.item, items: () => canvasPrints.items, refresh: () => refreshCanvas() });
function syncCanvasControls() {
  const it = canvasPrints.item;
  canvasPrints.preview.overlayEditor.sync();
  syncCanvasDensity();
  $$('#canvas-formats button[data-id]').forEach(b => b.classList.toggle('on', !!it && b.dataset.id === it.fmt.id));
  syncCanvasCustom(it?.fmt);
  if (it) {
    setSeg($('#canvas-orient'), it.orient); setSeg($('#canvas-blur'), it.blur);
    $('#canvas-zoom').value = it.zoom; $('#canvas-wrap').value = it.wrap;
    $('#canvas-strength').value = it.strength; $('#canvas-marks').checked = it.marks;
  }
  $('#canvas-tilt').textContent = tiltLabel(it);
  const mm = it && outMM(it);
  $('#canvas-size').textContent = it
    ? t('canvas_print_size', canvasMM(it).w / 10, canvasMM(it).h / 10, mm.w / 10, mm.h / 10, it.wrap) : '';
  $('#canvas-hint').textContent = it ? t('canvas_hint_selected', it.name) : t('canvas_hint_empty');
}

function refreshCanvas() {
  renderQueue(canvasPrints, $('#canvas-queue'), refreshCanvas, canvasLabel);
  syncCanvasControls(); canvasPrints.preview.draw(); canvasGrid.update();
  queueSave('canvas');
}

const canvasGrid = photoGrid(canvasPrints, $('#canvas-stage'), $('#canvas-grid'), $('#canvas-view-bar'),
  $('#canvas-hint'), canvasLabel, canvasMM, renderCanvas, refreshCanvas);

async function addCanvas(sources) {
  const epoch = workspaces.canvas.epoch;
  for (const source of sources) {
    try {
      const { src, name, file } = await storedSource(source, 'canvas');
      const img = await loadImage(src);
      if (epoch !== workspaces.canvas.epoch) return;
      const it = newItem(img, name, { ...canvasPrints.last, file });
      canvasPrints.items.push(it);
      if (!canvasPrints.sel) canvasPrints.sel = it;
    } catch (e) { setStatus($('#canvas-status'), t('canvas_source_error', source.name, e.message), true); }
  }
  refreshCanvas();
}

wireDrop($('#canvas-drop'), $('#canvas-file'), files =>
  addCanvas(files.map(f => ({ blob: f, name: f.name }))));
$('[data-incoming=canvas]').addEventListener('click', async () => {
  const names = await pickIncoming(true);
  addCanvas(names.map(n => ({ src: '/incoming/' + encodeURIComponent(n), name: n })));
});

function canvasSetting(key, value) {
  const it = canvasPrints.item; if (!it) return;
  it[key] = value; canvasPrints.last[key] = value; refreshCanvas();
}

$('#canvas-formats').addEventListener('click', e => {
  const b = e.target.closest('button[data-id]'); if (b) canvasSetting('fmt', formatById(CANVAS_FORMATS, b.dataset.id));
});
wireSeg($('#canvas-orient'), v => canvasSetting('orient', v));
wireSeg($('#canvas-blur'), v => canvasSetting('blur', v));
$('#canvas-wrap').addEventListener('change', e => {
  const n = +e.target.value;
  if (!Number.isFinite(n)) return refreshCanvas();
  canvasSetting('wrap', Math.min(15, Math.max(2, Math.round(n * 2) / 2)));
});
$('#canvas-strength').addEventListener('input', e => canvasSetting('strength', +e.target.value));
$('#canvas-marks').addEventListener('change', e => canvasSetting('marks', e.target.checked));
for (const [id, turn] of [['#canvas-rot-l', 270], ['#canvas-rot-r', 90]]) {
  $(id).addEventListener('click', () => {
    const it = canvasPrints.item; if (it) { it.rot = (it.rot + turn) % 360; refreshCanvas(); }
  });
}
$('#canvas-zoom').addEventListener('input', e => {
  const it = canvasPrints.item; if (it) { it.zoom = +e.target.value; canvasPrints.preview.redraw(); queueSave(); }
});
$('#canvas-reset').addEventListener('click', () => {
  const it = canvasPrints.item; if (it) { Object.assign(it, { zoom: 1, cx: .5, cy: .5, tilt: 0 }); refreshCanvas(); }
});
$('#canvas-apply-all').addEventListener('click', () => {
  const it = canvasPrints.item; if (!it) return;
  for (const x of canvasPrints.items) for (const key of ['fmt', 'orient', 'wrap', 'blur', 'strength', 'marks']) x[key] = it[key];
  refreshCanvas();
});

async function saveCanvas(it) {
  await readyOverlays(it);
  const mm = canvasMM(it), front = outMM(it), W = mm2px(mm.w, CANVAS_DPI), H = mm2px(mm.h, CANVAS_DPI);
  const f = canvasFront(it, W, H);
  const c = renderHQ(W, H, shrinks(it, f.w, f.h), (ctx, w, h) => renderCanvas(ctx, it, w, h));
  const name = `${baseName(it.name)}_canvas_${front.w / 10}x${front.h / 10}_wrap${it.wrap}.jpg`;
  const short = Math.min(front.w, front.h) / 10, long = Math.max(front.w, front.h) / 10;
  return saveFile(await jpegBlob(c, 1, CANVAS_DPI, it.density), name, `Canvas ${short}x${long}`);
}

$('#canvas-save-one').addEventListener('click', async () => {
  const it = canvasPrints.item, st = $('#canvas-status'); if (!it) return;
  try { setStatus(st, t('canvas_saving')); setStatus(st, t('canvas_saved_file', await saveCanvas(it))); }
  catch (e) { setStatus(st, e.message, true); }
});
$('#canvas-save-all').addEventListener('click', async () => {
  const st = $('#canvas-status'), saved = [];
  try {
    for (const [i, it] of canvasPrints.items.entries()) {
      setStatus(st, t('canvas_saving_count', i + 1, canvasPrints.items.length));
      saved.push(await saveCanvas(it));
    }
    setStatus(st, t('canvas_saved_canvases', saved.length));
  } catch (e) { setStatus(st, e.message, true); }
});
