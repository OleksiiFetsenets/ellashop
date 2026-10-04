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

// Map detected face coordinates into the photo rotation used by the crop.
function rotatedFace(face, item) {
  const w = item.img.naturalWidth, h = item.img.naturalHeight;
  const { x, y, w: fw, h: fh } = face;
  if (item.rot === 90) return { x: h - y - fh, y: x, w: fh, h: fw };
  if (item.rot === 180) return { x: w - x - fw, y: h - y - fh, w: fw, h: fh };
  if (item.rot === 270) return { x: y, y: w - x - fw, w: fh, h: fw };
  return face;
}

// Smart placement: always crop to fill, keeping every head in with a little room above
// and letting legs/hands go off the edges. Blurred border only when the faces can't fit.
function autoPlace(item) {
  const mm = outMM(item), W = mm.w, H = mm.h, d = srcDims(item);
  const s = Math.max(W / d.w, H / d.h);
  const windowW = W / s, windowH = H / s;
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
  } else { item.auto = 'centre'; item.cy = .45; }
  placement(item, W, H);
}

function faceOverlay(ctx, item) {
  if (!$('#prints-faces').checked || !item.faces?.length) return;
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

// Detect faces one photo at a time, then update smart placement.
function runFaceQueue() {
  while (prints.faceRunning < 2 && prints.faceQueue.length) {
    const item = prints.faceQueue.shift(), epoch = orderEpoch;
    if (!prints.items.includes(item)) continue;
    prints.faceRunning++;
    (async () => {
      try {
        const image = await (await fetch(item.img.src)).blob();
        const res = await fetch('/api/faces', { method: 'POST', body: image });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Face detection failed');
        if (epoch !== orderEpoch || !prints.items.includes(item)) return;
        item.faces = data.faces.map(f => ({ ...f, x: f.x * item.img.naturalWidth / data.width,
          y: f.y * item.img.naturalHeight / data.height, w: f.w * item.img.naturalWidth / data.width,
          h: f.h * item.img.naturalHeight / data.height }));
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

prints.preview = new Preview($('#prints-canvas'), $('#prints-stage'), {
  getItem: () => prints.item,
  onChange: () => { if (prints.item) { prints.item.auto = ''; prints.item.smartPending = false; } syncPrintControls(); queueSave('prints'); },
  overlay: faceOverlay,
});
prints.preview.overlayEditor = textAndStickers($('#prints-overlays'), prints, refreshPrints, prints.preview);

$('#formats').innerHTML = FORMATS.map(f => `<button data-id="${f.id}">${fmtLabel(f)}</button>`).join('');

const syncPrintCustom = customSizeControl('#formats', FORMATS, [2, 100, 2, 100], () => prints.item?.fmt, setPrintFormat, '#prints-status');

const syncPrintsDensity = densityControl($('#prints-density'), { item: () => prints.item, items: () => prints.items, refresh: () => refreshPrints() });
function syncPrintControls() {
  const it = prints.item;
  prints.preview.overlayEditor.sync();
  syncPrintsDensity();
  $$('#formats button[data-id]').forEach(b => b.classList.toggle('on', !!it && b.dataset.id === it.fmt.id));
  syncPrintCustom(it?.fmt);
  if (it) { setSeg($('#orient'), it.orient); setSeg($('#mode'), it.mode); setSeg($('#prints-blur'), it.blur); $('#prints-strength').value = it.strength; $('#zoom').value = it.zoom; }
  $('#prints-blur-controls').hidden = !it || it.mode !== 'blur';
  $('#zoom').disabled = !it || it.mode === 'fit' || it.mode === 'blur';
  $('#prints-tilt').textContent = tiltLabel(it);
  $('#prints-hint').textContent = it
    ? `${it.name} → ${fmtLabel(it.fmt)} cm. Drag to move, scroll to zoom.`
    : 'Add photos to start. Drag the photo to move it, scroll to zoom.';
}

function renderQueue(state, q, refresh, label) {
  q.innerHTML = '';
  state.items.forEach(it => {
    const li = document.createElement('li');
    li.className = it === state.sel ? 'sel' : '';
    li.innerHTML = `<img src="${it.img.src}"><div class="meta"><div class="name"></div><div class="fmt"></div></div><button class="del" title="Remove">✕</button>`;
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
  return `${fmtLabel(it.fmt)} · ${it.mode === 'blur' ? 'blur' : it.mode === 'fit' ? 'fit' : 'crop'}${it.faces === null ? ' · faces: …' : it.faces ? ` · faces: ${it.faces.length}` : ''}${it.auto ? ` · ${it.auto}` : ''}${densityLabel(it)}`;
}

function canvasLabel(it) { return `${fmtLabel(it.fmt)} · wrap ${it.wrap} cm${densityLabel(it)}`; }

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
    card.innerHTML = '<button class="eye" title="Open in single view">👁</button><canvas></canvas><div class="name"></div><div class="fmt"></div>';
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

const printsGrid = photoGrid(prints, $('#prints-stage'), $('#prints-grid'), $('#prints-view-bar'),
  $('#prints-hint'), printLabel, outMM, renderItem, refreshPrints);

function refreshPrints() {
  renderQueue(prints, $('#queue'), refreshPrints, printLabel);
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
    } catch (e) { setStatus($('#prints-status'), `${source.name}: ${e.message}`, true); }
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
wireSeg($('#orient'), v => { const it = prints.item; if (it) { it.orient = v; if (it.auto) autoPlace(it); refreshPrints(); } });
wireSeg($('#mode'), v => { const it = prints.item; if (it) { it.mode = v; it.auto = ''; it.smartPending = false; refreshPrints(); } });
wireSeg($('#prints-blur'), v => { const it = prints.item; if (it) { it.blur = v; refreshPrints(); } });
$('#prints-strength').addEventListener('input', e => { const it = prints.item; if (it) { it.strength = +e.target.value; prints.preview.draw(); queueSave(); } });
$('#prints-faces').addEventListener('change', () => prints.preview.draw());
$('#prints-auto').addEventListener('click', () => { const it = prints.item; if (it) { autoPlace(it); refreshPrints(); } });
$('#rot-l').addEventListener('click', () => { const it = prints.item; if (it) { it.rot = (it.rot + 270) % 360; if (it.auto) autoPlace(it); refreshPrints(); } });
$('#rot-r').addEventListener('click', () => { const it = prints.item; if (it) { it.rot = (it.rot + 90) % 360; if (it.auto) autoPlace(it); refreshPrints(); } });
$('#zoom').addEventListener('input', e => { const it = prints.item; if (it) { it.zoom = +e.target.value; it.auto = ''; it.smartPending = false; prints.preview.draw(); queueSave(); } });
$('#reset').addEventListener('click', () => { const it = prints.item; if (it) { Object.assign(it, { zoom: 1, cx: .5, cy: .5, tilt: 0, auto: '', smartPending: false }); refreshPrints(); } });
$('#apply-all').addEventListener('click', () => {
  const it = prints.item; if (!it) return;
  prints.items.forEach(x => { x.fmt = it.fmt; if (x.auto) autoPlace(x); else x.mode = it.mode; });
  refreshPrints();
});

async function savePrint(it) {
  await readyOverlays(it);
  const mm = outMM(it);
  const name = `${baseName(it.name)}_${mm.w / 10}x${mm.h / 10}.jpg`;
  return saveFile(await jpegBlob(renderToCanvas(it), 1, DPI, it.density), name, orderName());
}

$('#save-one').addEventListener('click', async () => {
  const it = prints.item; if (!it) return;
  const st = $('#prints-status');
  try { setStatus(st, 'Saving…'); setStatus(st, 'Saved: ' + await savePrint(it)); }
  catch (e) { setStatus(st, e.message, true); }
});
$('#save-all').addEventListener('click', async () => {
  const st = $('#prints-status'), saved = [];
  try {
    for (const [i, it] of prints.items.entries()) {
      setStatus(st, `Saving ${i + 1} / ${prints.items.length}…`);
      saved.push(await savePrint(it));
    }
    setStatus(st, `Saved ${saved.length} photos to Exported/${orderName()}`);
  } catch (e) { setStatus(st, e.message, true); }
});

