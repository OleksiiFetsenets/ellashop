'use strict';
// Manages Canvas crops, blurred wrap previews, and printed output.
// Shared controls come from PhotoUI; editing from PhotoEditor; drawing and saving from PhotoRender.
// ---------------------------------------------------------------- canvas

{
  const view = $('#canvas-view'), slot = name => view.querySelector(`[data-ui="${name}"]`);
  PhotoUI.mount(slot('drop'), PhotoUI.dropZone('canvas'));
  PhotoUI.mount(slot('stage'), PhotoUI.stage('canvas', 'page_add_photos_to_start_drag_the_front_crop_to_move_it_scroll_to_zoom'));
  PhotoUI.mount(slot('orient'), PhotoUI.orientSeg('canvas'));
  PhotoUI.mount(slot('adjust'), PhotoUI.adjustRow('canvas'));
  PhotoUI.mount(slot('blur'), PhotoUI.blurControls('canvas', { hidden: false }));
  PhotoUI.mount(slot('guides'), PhotoUI.guideChecks('canvas'));
  PhotoUI.mount(slot('save'), PhotoUI.saveActions('canvas', { one: 'page_save_this_canvas' }));
}

const canvasPrints = {
  items: [], sel: null,
  last: { fmt: CANVAS_FORMATS[0], orient: 'auto', wrap: 5, blur: 'motion', strength: 50, marks: false },
  get item() { return this.items.find(i => i === this.sel) || null; },
};

// Whole canvas in mm: the front plus the wrap on every side (item.wrap is cm per side, so *10 mm *2 sides).
function canvasMM(item) {
  const front = PhotoEditor.outMM(item);
  return { w: front.w + item.wrap * 20, h: front.h + item.wrap * 20 };
}

// Where the front (the visible face of the canvas) sits inside a W×H drawing.
function canvasFront(item, W, H) {
  const outer = canvasMM(item), front = PhotoEditor.outMM(item);
  const w = W * front.w / outer.w, h = H * front.h / outer.h;
  return { x: (W - w) / 2, y: (H - h) / 2, w, h };
}

// Cache key for the wrap background: everything that changes the blurred image.
function canvasKey(item, W, H) {
  return [W, H, item.img.src, item.fmt.id, item.orient, item.wrap, item.blur, item.strength,
    item.rot, item.tilt, item.zoom, item.cx, item.cy].join('|');
}

// Kept for Passport and Collage, which still call this name; the code lives in PhotoRender.
const printBackground = (...args) => PhotoRender.printBackground(...args);

// The wrap: a blurred enlargement of the sharp front crop.
function canvasBackground(item, W, H) {
  const key = canvasKey(item, W, H);
  if (item.wrapCache?.key === key) return item.wrapCache.canvas;
  // The wrap is blurred anyway, so it is built at about 600 px on the long side and scaled up.
  const scale = 600 / Math.max(W, H), w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const front = canvasFront(item, w, h);
  const source = document.createElement('canvas');
  source.width = Math.max(1, Math.round(front.w)); source.height = Math.max(1, Math.round(front.h));
  PhotoRender.renderItem(source.getContext('2d'), item, source.width, source.height, false);
  return PhotoRender.blurredBackdrop(item, source, W, H, key);
}

// Print the blurred wrap, sharp front, and front-only overlays in that order.
function renderCanvas(ctx, item, W, H, preview = false) {
  const bg = canvasBackground(item, W, H);
  ctx.save(); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bg, 0, 0, W, H);
  const front = canvasFront(item, W, H);
  ctx.save(); ctx.translate(front.x, front.y);
  PhotoRender.renderItem(ctx, item, front.w, front.h, false);
  ctx.restore();
  PhotoRender.drawOverlays(ctx, item, overlayFrame(item, front));
  // Crop marks: thin lines in the wrap area continuing the front's edges.
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
  // Dashed outline of the front, shown on screen only.
  if (preview) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2 * devicePixelRatio;
    ctx.setLineDash([6 * devicePixelRatio, 5 * devicePixelRatio]);
    ctx.strokeRect(front.x, front.y, front.w, front.h);
  }
  ctx.restore();
}

canvasPrints.preview = new PhotoEditor.Stage($('#canvas-canvas'), $('#canvas-stage'), {
  getItem: () => canvasPrints.item,
  onChange: () => { syncCanvasControls(); queueSave('canvas'); },
  sizeMM: canvasMM, frontRect: canvasFront,
  frameDraw: true,
  render: (ctx, item, W, H) => renderCanvas(ctx, item, W, H, true),
});
PhotoEditor.attachOverlays($('#canvas-overlays'), canvasPrints, refreshCanvas, canvasPrints.preview);
PhotoUI.wireGuides('canvas', canvasPrints.preview);

$('#canvas-formats').innerHTML = CANVAS_FORMATS.map(f => `<button data-id="${f.id}">${fmtLabel(f)}</button>`).join('');

const syncCanvasCustom = customSizeControl('#canvas-formats', CANVAS_FORMATS, [10, 200, 10, 200], () => canvasPrints.item?.fmt, fmt => canvasSetting('fmt', fmt), '#canvas-status');

const syncCanvasDensity = densityControl($('#canvas-density'), { item: () => canvasPrints.item, items: () => canvasPrints.items, refresh: () => refreshCanvas() });
function syncCanvasControls() {
  const it = canvasPrints.item;
  canvasPrints.preview.overlayEditor.sync();
  syncCanvasDensity();
  $$('#canvas-formats button[data-id]').forEach(b => b.classList.toggle('on', !!it && b.dataset.id === it.fmt.id));
  syncCanvasCustom(it?.fmt);
  PhotoUI.syncAdjust('canvas', it);
  if (it) { $('#canvas-wrap').value = it.wrap; $('#canvas-marks').checked = it.marks; }
  const mm = it && PhotoEditor.outMM(it);
  $('#canvas-size').textContent = it
    ? t('canvas_print_size', canvasMM(it).w / 10, canvasMM(it).h / 10, mm.w / 10, mm.h / 10, it.wrap) : '';
  $('#canvas-hint').textContent = it ? t('canvas_hint_selected', it.name) : t('canvas_hint_empty');
}

function refreshCanvas() {
  PhotoUI.renderQueue(canvasPrints, $('#canvas-queue'), refreshCanvas, canvasLabel);
  syncCanvasControls(); canvasPrints.preview.draw(); canvasGrid.update();
  queueSave('canvas');
}

const canvasGrid = PhotoUI.photoGrid(canvasPrints, $('#canvas-stage'), $('#canvas-grid'), $('#canvas-view-bar'),
  $('#canvas-hint'), canvasLabel, canvasMM, renderCanvas, refreshCanvas, 'canvas');

async function addCanvas(sources) {
  // Drop the result if the Canvas workspace was reset or switched while the image was loading.
  const epoch = workspaces.canvas.epoch;
  for (const source of sources) {
    try {
      const { src, name, file } = await storedSource(source, 'canvas');
      const img = await loadImage(src);
      if (epoch !== workspaces.canvas.epoch) return;
      const it = PhotoEditor.newItem(img, name, { ...canvasPrints.last, file });
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

// Change one setting of the selected canvas and remember it for the next photos added.
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
  // Wrap is clamped to 2-15 cm and rounded to 0.5 cm steps.
  canvasSetting('wrap', Math.min(15, Math.max(2, Math.round(n * 2) / 2)));
});
$('#canvas-strength').addEventListener('input', e => canvasSetting('strength', +e.target.value));
$('#canvas-marks').addEventListener('change', e => canvasSetting('marks', e.target.checked));
PhotoUI.wireAdjust('canvas', { item: () => canvasPrints.item, changed: refreshCanvas, redraw: () => { canvasPrints.preview.redraw(); queueSave(); } });
$('#canvas-apply-all').addEventListener('click', () => {
  const it = canvasPrints.item; if (!it) return;
  for (const x of canvasPrints.items) for (const key of ['fmt', 'orient', 'wrap', 'blur', 'strength', 'marks']) x[key] = it[key];
  refreshCanvas();
});

// Saved at 150 DPI into a "Canvas <short>x<long>" folder.
function saveCanvas(it) {
  const front = PhotoEditor.outMM(it);
  const short = Math.min(front.w, front.h) / 10, long = Math.max(front.w, front.h) / 10;
  return PhotoRender.exportItem(it, {
    name: `${baseName(it.name)}_canvas_${front.w / 10}x${front.h / 10}_wrap${it.wrap}.jpg`, folder: `Canvas ${short}x${long}`,
    dpi: CANVAS_DPI, sizeMM: canvasMM, render: renderCanvas, front: canvasFront,
  });
}

PhotoUI.wireSave('canvas', {
  item: () => canvasPrints.item, items: () => canvasPrints.items, save: saveCanvas,
  msg: { saving: 'canvas_saving', savedFile: 'canvas_saved_file', savingCount: 'canvas_saving_count', savedAll: 'canvas_saved_canvases' },
});
