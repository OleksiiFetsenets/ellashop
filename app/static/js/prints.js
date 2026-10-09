'use strict';
// Manages Prints photos, face-aware crop placement, grids, and export.
// Loads after shared UI and storage helpers, before Canvas and Passport.
// ---------------------------------------------------------------- prints

const prints = {
  items: [],
  sel: null,
  lastFmt: FORMATS[0],
  facesAvailable: false, faceQueue: [], faceRunning: 0,
  get item() { return this.items.find(i => i === this.sel) || null; },
};

// Shared controls (drop zone, stage, orientation/fill/blur, guides, adjust row, save) come from PhotoUI;
// editing from PhotoEditor; drawing and saving from PhotoRender.
{
  const view = $('#prints'), slot = name => view.querySelector(`[data-ui="${name}"]`);
  PhotoUI.mount(slot('drop'), PhotoUI.dropZone('prints'));
  PhotoUI.mount(slot('stage'), PhotoUI.stage('prints', 'page_add_photos_to_start_drag_the_photo_to_move_it_scroll_to_zoom'));
  PhotoUI.mount(slot('orient-fill'), PhotoUI.orientSeg('prints'), PhotoUI.fillModeSeg('prints'), PhotoUI.blurControls('prints'));
  PhotoUI.mount(slot('guides'), PhotoUI.guideChecks('prints'));
  PhotoUI.mount(slot('adjust'), PhotoUI.adjustRow('prints'));
  PhotoUI.mount(slot('save'), PhotoUI.saveActions('prints', { one: 'page_save_this_photo' }));
}

const autoPlace = item => PhotoEditor.smartPlace(item);

function faceOverlay(ctx, item) {
  if ($('#prints-faces').checked) PhotoEditor.drawFaces(ctx, item);
}

// Detect faces one photo at a time, then update smart placement.
function runFaceQueue() {
  while (prints.faceRunning < 2 && prints.faceQueue.length) {
    const item = prints.faceQueue.shift(), epoch = orderEpoch;
    if (!prints.items.includes(item)) continue;
    prints.faceRunning++;
    (async () => {
      try {
        const faces = await PhotoEditor.detectFaces(item);
        if (epoch !== orderEpoch || !prints.items.includes(item)) return;
        item.faces = faces;
        if (item.smartPending) autoPlace(item);
      } catch (e) {
        if (epoch !== orderEpoch || !prints.items.includes(item)) return;
        item.faces = []; item.faceError = e.message;
        if (item.smartPending) autoPlace(item);
      } finally {
        item.smartPending = false; prints.faceRunning--;
        if (epoch === orderEpoch && prints.items.includes(item)) refreshPrints();
        runFaceQueue();
      }
    })();
  }
}

prints.preview = new PhotoEditor.Stage($('#prints-canvas'), $('#prints-stage'), {
  getItem: () => prints.item,
  onChange: () => { if (prints.item) { prints.item.auto = ''; prints.item.smartPending = false; } syncPrintControls(); queueSave('prints'); },
  overlay: faceOverlay,
  render: PhotoRender.renderItem,
});
PhotoEditor.attachOverlays($('#prints-overlays'), prints, refreshPrints, prints.preview);
PhotoUI.wireGuides('prints', prints.preview);

$('#formats').innerHTML = FORMATS.map(f => `<button data-id="${f.id}">${fmtLabel(f)}</button>`).join('');

const syncPrintCustom = customSizeControl('#formats', FORMATS, [2, 100, 2, 100], () => prints.item?.fmt, setPrintFormat, '#prints-status');

const syncPrintsDensity = densityControl($('#prints-density'), { item: () => prints.item, items: () => prints.items, refresh: () => refreshPrints() });
function syncPrintControls() {
  const it = prints.item;
  prints.preview.overlayEditor.sync();
  syncPrintsDensity();
  $$('#formats button[data-id]').forEach(b => b.classList.toggle('on', !!it && b.dataset.id === it.fmt.id));
  syncPrintCustom(it?.fmt);
  PhotoUI.syncAdjust('prints', it);
  $('#prints-hint').textContent = it
    ? t('prints_hint_selected', it.name, fmtLabel(it.fmt))
    : t('prints_hint_empty');
}

function renderQueue(state, q, refresh, label) {
  q.innerHTML = '';
  state.items.forEach(it => {
    const li = document.createElement('li');
    li.className = it === state.sel ? 'sel' : '';
    li.innerHTML = `<img src="${it.img.src}"><div class="meta"><div class="name"></div><div class="fmt"></div></div><button class="del" title="${t('prints_remove')}">✕</button>`;
    li.querySelector('.name').textContent = it.name;
    li.querySelector('.fmt').textContent = label(it);
    li.addEventListener('click', e => {
      if (e.target.closest('.del')) {
        state.items = state.items.filter(x => x !== it);
        if (state.sel === it) state.sel = state.items[0] || null;
      } else state.sel = it;
      refresh();
    });
    q.appendChild(li);
  });
}

function printLabel(it) {
  return t('prints_label', fmtLabel(it.fmt), t(it.mode === 'blur' ? 'prints_blur' : it.mode === 'fit' ? 'prints_fit' : 'prints_crop')) + (it.faces === null ? t('prints_faces_pending') : it.faces ? t('prints_faces_count', it.faces.length) : '') + (it.auto ? t('prints_auto_detail', ({ 'blur: faces don\'t fit': t('prints_auto_blur'), faces: t('prints_auto_faces'), centre: t('prints_auto_centre') })[it.auto] || it.auto) : '') + densityLabel(it);
}

function canvasLabel(it) { return t('canvas_label', fmtLabel(it.fmt), it.wrap) + densityLabel(it); }

function gridKey(it, mm, kind) {
  return [kind, it.img.src, mm.w, mm.h, it.rot, it.tilt, it.zoom, it.cx, it.cy,
    it.mode, it.bg, it.blur, it.strength, it.wrap, it.marks, JSON.stringify(it.overlays || []), assetVersion].join('|');
}

// Keep grid and single-photo views synchronized as images are selected.
function photoGrid(state, stage, grid, bar, hint, label, sizeMM, render, refresh) {
  const cards = new WeakMap();
  stage.classList.add('photo-stage');
  function choose(view) { if (state.items.length) { state.view = view; state.preview.overlayEditor?.select(null); update(); queueSave(); } }
  function step(delta) {
    const i = state.items.indexOf(state.sel), next = i + delta;
    if (next < 0 || next >= state.items.length) return;
    state.sel = state.items[next]; refresh();
  }
  bar.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.view) choose(b.dataset.view);
    else if (b.dataset.step) step(+b.dataset.step);
  });
  function paint(card, it) {
    const mm = sizeMM(it), key = gridKey(it, mm, render === renderItem ? 'prints' : 'canvas');
    if (card.renderKey === key) return;
    const c = card.querySelector('canvas'), scale = 300 * devicePixelRatio / Math.max(mm.w, mm.h);
    c.width = Math.max(1, Math.round(mm.w * scale)); c.height = Math.max(1, Math.round(mm.h * scale));
    render(c.getContext('2d'), it, c.width, c.height);
    card.renderKey = key;
  }
  // Click selects (right-panel controls then act on it); the eye opens Single view;
  // dragging on the picture moves the crop, like dragging in the big preview.
  function makeCard(it) {
    const card = document.createElement('div');
    card.className = 'photo-card';
    card.innerHTML = `<button class="eye" title="${t('prints_open_single_view')}">👁</button><canvas></canvas><div class="name"></div><div class="fmt"></div>`;
    card.addEventListener('click', () => { if (state.sel !== it) { state.sel = it; refresh(); } });
    card.querySelector('.eye').addEventListener('click', e => { e.stopPropagation(); state.sel = it; state.view = 'single'; refresh(); });
    const c = card.querySelector('canvas');
    let last = null, moved = false;
    c.addEventListener('pointerdown', e => {
      if (state.sel !== it) { state.sel = it; refresh(); }
      last = [e.clientX, e.clientY]; moved = false; c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      if (!last) return;
      panOnCanvas(it, c, state.preview.frontRect, e.clientX - last[0], e.clientY - last[1]);
      last = [e.clientX, e.clientY]; moved = true;
      it.auto = ''; it.smartPending = false;
      paint(card, it);
    });
    c.addEventListener('pointerup', () => { last = null; if (moved) refresh(); });
    cards.set(it, card);
    return card;
  }
  // The selected photo's card canvas while the grid is showing (arrow keys move it there).
  function cardCanvas(it) {
    return !grid.hidden && cards.get(it)?.isConnected ? cards.get(it).querySelector('canvas') : null;
  }
  function update() {
    const count = state.items.length, view = state.view || (count > 1 ? 'grid' : 'single');
    const single = view === 'single';
    bar.hidden = !count; grid.hidden = !count || single;
    state.preview.canvas.hidden = !single;
    hint.hidden = !!count && !single;
    bar.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    bar.querySelectorAll('[data-step]').forEach(b => {
      b.hidden = !single;
      b.disabled = b.dataset.step === '-1' ? state.sel === state.items[0] : state.sel === state.items[count - 1];
    });
    const counter = bar.querySelector('.view-count');
    counter.hidden = !single; counter.textContent = `${state.items.indexOf(state.sel) + 1} / ${count}`;
    if (grid.hidden || !stage.closest('.view.active')) return;
    grid.replaceChildren();
    for (const it of state.items) {
      const card = cards.get(it) || makeCard(it);
      paint(card, it);
      card.querySelector('canvas').style.filter = densityFilter(it.density);
      card.querySelector('.name').textContent = it.name;
      card.querySelector('.fmt').textContent = label(it);
      card.classList.toggle('sel', it === state.sel);
      grid.appendChild(card);
    }
  }
  return { update, choose, step, cardCanvas };
}

const printsGrid = PhotoUI.photoGrid(prints, $('#prints-stage'), $('#prints-grid'), $('#prints-view-bar'),
  $('#prints-hint'), printLabel, PhotoEditor.outMM, PhotoRender.renderItem, refreshPrints, 'prints');

function refreshPrints() {
  PhotoUI.renderQueue(prints, $('#prints-queue'), refreshPrints, printLabel);
  syncPrintControls(); prints.preview.draw(); printsGrid.update();
  queueSave('prints'); updateOrderPicker();
}

async function addPrints(sources) {
  await configReady;
  const id = currentOrder?.id, epoch = orderEpoch;
  for (const source of sources) {
    try {
      const { src, name, file } = await storedSource(source, id);
      const img = await loadImage(src);
      if (epoch !== orderEpoch) return;
      const it = newItem(img, name, { fmt: prints.lastFmt, blur: 'motion', strength: 50,
        file, faces: prints.facesAvailable ? null : undefined, smartPending: $('#prints-smart').checked, auto: '' });
      prints.items.push(it);
      if (!prints.sel) prints.sel = it;
      if (prints.facesAvailable) { prints.faceQueue.push(it); runFaceQueue(); }
      else if (it.smartPending) { autoPlace(it); it.smartPending = false; }
    } catch (e) { setStatus($('#prints-status'), t('prints_source_error', source.name, e.message), true); }
  }
  refreshPrints();
}

wireDrop($('#prints-drop'), $('#prints-file'), files =>
  addPrints(files.map(f => ({ blob: f, name: f.name }))));

$('[data-incoming=prints]').addEventListener('click', async () => {
  const names = await pickIncoming(true);
  addPrints(names.map(n => ({ src: '/incoming/' + encodeURIComponent(n), name: n })));
});

function setPrintFormat(fmt) {
  const it = prints.item; if (!it) return;
  it.fmt = prints.lastFmt = fmt;
  if (it.auto) autoPlace(it);
  refreshPrints();
}
$('#formats').addEventListener('click', e => {
  const b = e.target.closest('button[data-id]'); if (b) setPrintFormat(formatById(FORMATS, b.dataset.id));
});
wireSeg($('#prints-orient'), v => { const it = prints.item; if (it) { it.orient = v; if (it.auto) autoPlace(it); refreshPrints(); } });
wireSeg($('#prints-mode'), v => { const it = prints.item; if (it) { PhotoEditor.setMode(it, v); refreshPrints(); } });
wireSeg($('#prints-blur'), v => { const it = prints.item; if (it) { it.blur = v; refreshPrints(); } });
$('#prints-strength').addEventListener('input', e => { const it = prints.item; if (it) { it.strength = +e.target.value; prints.preview.draw(); queueSave(); } });
$('#prints-faces').addEventListener('change', () => prints.preview.draw());
$('#prints-auto').addEventListener('click', () => { const it = prints.item; if (it) { autoPlace(it); refreshPrints(); } });
PhotoUI.wireAdjust('prints', { item: () => prints.item, changed: refreshPrints, redraw: () => { prints.preview.draw(); queueSave(); } });
$('#apply-all').addEventListener('click', () => {
  const it = prints.item; if (!it) return;
  prints.items.forEach(x => { x.fmt = it.fmt; if (x.auto) autoPlace(x); else x.mode = it.mode; });
  refreshPrints();
});

function savePrint(it) {
  const mm = PhotoEditor.outMM(it);
  return PhotoRender.exportItem(it, { name: `${baseName(it.name)}_${mm.w / 10}x${mm.h / 10}.jpg`, folder: orderName() });
}

PhotoUI.wireSave('prints', {
  item: () => prints.item, items: () => prints.items, save: savePrint, folder: orderName,
  msg: { saving: 'prints_saving', savedFile: 'prints_saved_file', savingCount: 'prints_saving_count', savedAll: 'prints_saved_photos' },
});
