'use strict';
// Manages passport cutouts, face alignment, sheet previews, and export.
// Loads after Canvas and before shared keyboard controls.
// ---------------------------------------------------------------- passport

const pp = { jobs: [], active: null, guides: true, queue: [], running: false, config: {} };
let nextJobId = 1;

$('#pp-size').innerHTML = PASSPORT.map(p => {
  const L = sheetLayout({ size: p });
  return `<button data-v="${p.id}">${p.label}<small>${t('passport_size_detail', p.w / 10, p.h / 10, p.face[0], p.face[1], t(p.measure === 'hairline' ? 'passport_hairline' : 'passport_crown'), L.count, p.bgNote)}</small></button>`;
}).join('');

const syncPpCustom = customSizeControl('#pp-size', PASSPORT, [2, 10, 2, 15], () => pp.active?.size, setPassportSize, '#pp-status');

pp.preview = new PhotoEditor.Stage($('#pp-canvas'), $('#pp-stage'), {
  getItem: () => pp.active?.item,
  onChange: done => {
    if (pp.active) pp.active.item.auto = '';
    $('#pp-zoom').value = pp.active?.item.zoom || 1;
    $('#pp-tilt').textContent = tiltLabel(pp.active?.item);
    if (done) pp.drawSheet();
    queueSave('passport');
  },
  overlay: (ctx, item, pxPerMM) => {
    if (!pp.guides) return;
    const W = ctx.canvas.width, s = pp.active.size;
    const band = ([a, b], label) => {
      ctx.fillStyle = 'rgba(47,111,223,.16)';
      ctx.fillRect(0, a * pxPerMM, W, (b - a) * pxPerMM);
      ctx.strokeStyle = 'rgba(47,111,223,.9)'; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(0, (a + b) / 2 * pxPerMM); ctx.lineTo(W, (a + b) / 2 * pxPerMM); ctx.stroke();
      ctx.fillStyle = 'rgba(47,111,223,1)';
      ctx.fillText(label, 6 * devicePixelRatio, b * pxPerMM - 4 * devicePixelRatio);
    };
    ctx.save();
    ctx.lineWidth = devicePixelRatio;
    ctx.font = `${11 * devicePixelRatio}px -apple-system, sans-serif`;
    band(s.crown, t(s.measure === 'hairline' ? 'passport_hairline' : 'passport_top_of_head'));
    band(s.chin, t('passport_chin'));
    ctx.setLineDash([6 * devicePixelRatio, 6 * devicePixelRatio]);
    ctx.strokeStyle = 'rgba(47,111,223,.7)';
    ctx.beginPath(); ctx.moveTo(W / 2, 0); ctx.lineTo(W / 2, ctx.canvas.height); ctx.stroke();
    ctx.restore();
  },
});
PhotoUI.keys.register('passport', {
  active: () => $('#passport').classList.contains('active'),
  item: () => pp.active?.item, stage: pp.preview, changed: () => ppSyncItem(),
});

// Choose the fixed grid before applying a job's offsets.
function sheetLayout(job) {
  const p = job.size;
  let best = null;
  for (const [W, H] of [[SHEET.w, SHEET.h], [SHEET.h, SHEET.w]]) {
    const cols = Math.floor(W / p.w + 1e-9), rows = Math.floor(H / p.h + 1e-9), cells = cols * rows, count = Math.min(cells, 8);
    if (!best || count > best.count || (count === best.count && cells < best.cols * best.rows)) best = { W, H, cols, rows, count };
  }
  return best;
}

function passportOffsets(size) {
  const standard = { visa: [0, 0], 'ca-passport': [0, 5], 'cn-visa': [9, 4] }[size.id] || [5, 5];
  const L = sheetLayout({ size });
  return { right: Math.min(standard[0], Math.max(0, L.W - L.cols * size.w)),
    down: Math.min(standard[1], Math.max(0, L.H - L.rows * size.h)) };
}

// Render one high-quality passport tile, repeat it, and mark cut lines.
function renderSheet(job) {
  const it = job.item, p = job.size, L = sheetLayout(job);
  const sheet = document.createElement('canvas');
  sheet.width = mm2px(L.W); sheet.height = mm2px(L.H);
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, sheet.width, sheet.height);
  const tile = { ...it, fmt: p }, PW = mm2px(p.w), PH = mm2px(p.h);
  const photo = PhotoRender.renderHQ(PW, PH, PhotoRender.shrinks(tile, PW, PH), (c, w, h) => PhotoRender.renderItem(c, tile, w, h));
  const right = job.right ?? passportOffsets(p).right, down = job.down ?? passportOffsets(p).down;

  for (let r = 0; r < L.rows; r++) for (let c = 0; c < L.cols; c++) {
    if (r * L.cols + c >= L.count) continue;
    ctx.drawImage(photo, mm2px(right + c * p.w), mm2px(down + r * p.h));
  }

  const CUT = 2; // cut line width in px (≈0.17 mm at 300 DPI)
  ctx.fillStyle = '#000';
  for (let c = 0; c <= L.cols; c++) {
    const x = mm2px(right + c * p.w);
    if (x >= 0 && x <= sheet.width) ctx.fillRect(x - CUT / 2, 0, CUT, sheet.height);
  }
  for (let r = 0; r <= L.rows; r++) {
    const y = mm2px(down + r * p.h);
    if (y >= 0 && y <= sheet.height) ctx.fillRect(0, y - CUT / 2, sheet.width, CUT);
  }
  return { sheet, count: L.count };
}

let sheetTimer = 0;
pp.drawSheet = () => {
  clearTimeout(sheetTimer);
  sheetTimer = setTimeout(() => {
    const view = $('#pp-sheet'), ctx = view.getContext('2d'), job = pp.active;
    if (!job?.item) {
      view.width = 400; view.height = 600; view.style.filter = '';
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 600);
      $('#pp-save').textContent = t('passport_save_sheet');
      return;
    }
    const { sheet, count } = renderSheet(job);
    view.style.filter = PhotoRender.densityFilter(job.item.density);
    view.width = Math.round(sheet.width / 2); view.height = Math.round(sheet.height / 2);
    ctx.drawImage(sheet, 0, 0, view.width, view.height);
    $('#pp-save').textContent = t('passport_save_sheet_count', count);
  }, 120);
};

function ppTabs() {
  const bar = $('#pp-tabs');
  bar.replaceChildren();
  pp.jobs.forEach(job => {
    const tab = document.createElement('div');
    tab.className = 'pp-tab' + (job === pp.active ? ' active' : '');
    const pick = document.createElement('button');
    pick.className = 'pp-pick';
    const name = document.createElement('span');
    name.className = 'pp-name'; name.textContent = job.name;
    const status = document.createElement('span');
    status.className = 'pp-state';
    status.textContent = { new: '', queued: t('passport_queued'), removing: '…', done: '✓', error: '!' }[job.status];
    status.title = job.error || t(({ new: 'passport_new', queued: 'passport_queued', removing: 'passport_removing', done: 'passport_done', error: 'passport_error' })[job.status]);
    pick.append(name, status);
    pick.addEventListener('click', () => { pp.active = job; ppSyncItem(); });
    const close = document.createElement('button');
    close.className = 'pp-close'; close.textContent = '✕'; close.title = t('passport_close_photo');
    close.addEventListener('click', () => {
      pp.jobs = pp.jobs.filter(x => x !== job);
      pp.queue = pp.queue.filter(x => x.job !== job);
      if (pp.active === job) pp.active = pp.jobs[0] || null;
      ppSyncItem();
    });
    tab.append(pick, close); bar.append(tab);
  });
}

const syncPpDensity = densityControl($('#pp-density'), { item: () => pp.active?.item, items: () => pp.jobs.map(j => j.item), refresh: () => ppSyncItem() });
function ppSyncItem() {
  const job = pp.active, item = job?.item;
  $('#pp-right').value = job?.right ?? (job ? passportOffsets(job.size).right : 0);
  $('#pp-down').value = job?.down ?? (job ? passportOffsets(job.size).down : 0);
  syncPpDensity();
  if (item) { item.fmt = job.size; item.orient = 'portrait'; }
  setSeg($('#pp-size'), job?.size.id);
  syncPpCustom(job?.size);
  $$('#pp-bg button').forEach(b => b.classList.toggle('on', b.dataset.v === (item?.bg || '#ffffff')));
  $('#pp-zoom').value = item?.zoom || 1;
  $('#pp-tilt').textContent = tiltLabel(item);
  $('#pp-hint').textContent = item
    ? t('passport_hint_selected')
    : t('passport_hint_empty');
  setStatus($('#pp-status'), job?.error || '', !!job?.error);
  ppTabs(); pp.preview.draw(); pp.drawSheet();
  queueSave('passport');
}

async function ppAdd(files) {
  const epoch = workspaces.passport.epoch;
  for (const { original, name } of files) {
    try {
      const { file, src } = await uploadPhoto(original, name, 'passport');
      const img = await loadImage(src);
      if (epoch !== workspaces.passport.epoch) return;
      const job = { id: nextJobId++, name, file, original, item: PhotoEditor.newItem(img, name, { file, fmt: PASSPORT[0], free: true }),
        size: PASSPORT[0], ...passportOffsets(PASSPORT[0]), status: 'new', error: '' };
      pp.jobs.push(job); pp.active = job;
      ppSyncItem();
      if ($('#pp-auto').checked && pp.config.localBg) ppEnqueue(job, '/api/remove-bg-local');
      if (pp.config.faces) ppDetectFace(job);
    } catch (e) { setStatus($('#pp-status'), t('passport_source_error', name, e.message), true); }
  }
}

async function jobOriginal(job) {
  if (!job.original) job.original = await (await fetch(workspaceUrl('passport', job.file))).blob();
  return job.original;
}

// Find the largest face in the job's original photo (same pixel size as the bg-removed result).
// Detect the face against the original image so cutout pixels cannot shift landmarks.
async function ppDetectFace(job) {
  const epoch = workspaces.passport.epoch;
  job.face = null;
  try {
    const res = await fetch('/api/faces', { method: 'POST', body: await jobOriginal(job) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || t('passport_face_detection_failed'));
    const kx = job.item.img.naturalWidth / data.width, ky = job.item.img.naturalHeight / data.height;
    const f = data.faces.sort((a, b) => b.w * b.h - a.w * a.h)[0];
    job.face = f ? { x: f.x * kx, y: f.y * ky, w: f.w * kx, h: f.h * ky, eyes: f.eyes.map(([x, y]) => [x * kx, y * ky]) } : false;
  } catch { job.face = false; }
  if (epoch !== workspaces.passport.epoch || !pp.jobs.includes(job)) return;
  if ($('#pp-align-new').checked && job.item.auto !== '') ppAutoAlign(job);
  if (pp.active === job) ppSyncItem();
}

// Zoom and centre so the head spans the guide bands: top of head in the crown band, chin in the
// chin band, face centred. The face box runs brow→just below the chin; hair adds ~40% above. Tilt is left to the
// operator: YuNet's eye points are off by up to ±4°, too coarse to straighten a head.
// Exact top of the head from the background-removed cut-out: the first row above the face where
// the person's silhouette (alpha) starts, scanned across the middle of the face's width.
// Null when there is no cut-out yet; cached per image.
function cutoutCrown(job) {
  const img = job.item.img, f = job.face;
  if (!job.cutFile || !f || !img?.naturalWidth) return null;
  if (job.crownKey === img.src) return job.crownY;
  const scale = Math.min(1, 600 / img.naturalWidth), w = Math.round(img.naturalWidth * scale), h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, w, h);
  const alpha = ctx.getImageData(0, 0, w, h).data;
  const x0 = Math.max(0, Math.round((f.x + f.w * .2) * scale)), x1 = Math.min(w - 1, Math.round((f.x + f.w * .8) * scale));
  let crown = null;
  for (let y = 0, yMax = Math.round(f.y * scale); y < yMax && crown === null; y++)
    for (let x = x0; x <= x1; x++) if (alpha[(y * w + x) * 4 + 3] > 128) { crown = y / scale; break; }
  job.crownKey = img.src; job.crownY = crown;
  return crown;
}

// Use detected face landmarks and cutout crown to position the head.
// Match the preset chin and crown bands, leaving manual adjustment available.
function ppAutoAlign(job) {
  const it = job.item, f = job.face, p = job.size;
  if (!f) return false;
  const d = PhotoEditor.srcDims(it), mid = ([a, b]) => (a + b) / 2;
  const [[rx], [lx]] = f.eyes;
  // Face box: top ≈ upper forehead, bottom ≈ chin + 0.1h. Crown (hair top) ≈ 0.4h above the box,
  // hairline ≈ 0.1h above it; real chin ≈ 0.9h below the box top.
  // Crown: measured from the cut-out when the background is removed, else estimated (~0.4 face heights above the box).
  const topSrc = p.measure === 'hairline' ? f.y - .1 * f.h : (cutoutCrown(job) ?? f.y - .4 * f.h), crownSrc = topSrc, headSrc = f.y + .9 * f.h - topSrc;
  const crownMM = mid(p.crown), headMM = mid(p.chin) - crownMM;
  const s0 = Math.max(p.w / d.w, p.h / d.h);
  it.mode = 'fill';
  it.zoom = PhotoEditor.clampZoom(it, headMM / (headSrc * s0));
  const s = s0 * it.zoom;
  it.cx = (rx + lx) / 2 / d.w;
  it.cy = (crownSrc - crownMM / s + p.h / (2 * s)) / d.h;
  PhotoEditor.placement(it, p.w, p.h);
  it.auto = 'face';
  return true;
}

wireDrop($('#pp-drop'), $('#pp-file'), files => ppAdd(files.map(f => ({ original: f, name: f.name }))));
$('#pp-add').addEventListener('click', () => $('#pp-file').click());
$('[data-incoming=passport]').addEventListener('click', async () => {
  const names = await pickIncoming(true);
  for (const name of names) {
    try {
      const res = await fetch('/incoming/' + encodeURIComponent(name));
      if (!res.ok) throw new Error(t('passport_could_not_load_photo'));
      await ppAdd([{ original: await res.blob(), name }]);
    } catch (e) { setStatus($('#pp-status'), t('passport_source_error', name, e.message), true); }
  }
});
wireDrop($('#pp-result-drop'), $('#pp-result'), async files => {
  const job = pp.active; if (!job || !files[0]) return;
  try {
    const { file, src } = await uploadPhoto(files[0], files[0].name, 'passport');
    if (!pp.jobs.includes(job)) return;
    job.item.img = await loadImage(src);
    job.cutFile = file;
    job.status = 'done'; job.error = '';
    ppSyncItem();
  } catch (e) { setStatus($('#pp-status'), e.message, true); }
});

// Queue a cutout with its current workspace epoch to reject stale results.
function ppEnqueue(job, url) {
  if (!job || job.status === 'queued' || job.status === 'removing') return;
  job.status = 'queued'; job.error = '';
  pp.queue.push({ job, url });
  ppTabs(); ppRunQueue();
}

// Process background removals sequentially and keep each job status current.
async function ppRunQueue() {
  if (pp.running) return;
  pp.running = true;
  while (pp.queue.length) {
    const { job, url } = pp.queue.shift();
    const epoch = workspaces.passport.epoch;
    if (!pp.jobs.includes(job)) continue;
    job.status = 'removing'; ppTabs();
    try {
      const res = await fetch(url, {
        method: 'POST', body: await jobOriginal(job), headers: { 'Content-Type': job.original.type || 'image/jpeg' },
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || t('passport_failed_status', res.status));
      if (epoch !== workspaces.passport.epoch || !pp.jobs.includes(job)) continue;
      const { file, src } = await uploadPhoto(await res.blob(), `${baseName(job.name)}_cut.png`, 'passport');
      const img = await loadImage(src);
      if (epoch === workspaces.passport.epoch && pp.jobs.includes(job)) {
        job.item.img = img;
        job.cutFile = file;
        if (job.item.auto === 'face') ppAutoAlign(job);  // re-align with the exact crown from the cut-out
        job.status = 'done'; job.error = '';
        if (pp.active === job) ppSyncItem(); else ppTabs();
      }
    } catch (e) {
      if (epoch === workspaces.passport.epoch && pp.jobs.includes(job)) {
        job.status = 'error'; job.error = e.message;
        ppTabs();
        if (pp.active === job) setStatus($('#pp-status'), e.message, true);
      }
    }
  }
  pp.running = false;
}

$('#pp-remove-local').addEventListener('click', () => ppEnqueue(pp.active, '/api/remove-bg-local'));
$('#pp-remove-all').addEventListener('click', () => {
  if (!pp.config.localBg) { setStatus($('#pp-status'), t('passport_offline_not_installed'), true); return; }
  pp.jobs.filter(j => j.status === 'new' || j.status === 'error').forEach(j => ppEnqueue(j, '/api/remove-bg-local'));
});

async function refreshConfig() {
  const cfg = await (await fetch('/api/config')).json();
  const wasLocal = pp.config.localBg;
  pp.config = cfg;
  prints.facesAvailable = !!cfg.faces;
  if (wasLocal === undefined) $('#pp-auto').checked = !!cfg.localBg;
  $('#pp-remove-local').hidden = !cfg.localBg;
  $('#pp-local-note').hidden = !!cfg.localBg;
}

wireSeg($('#pp-bg'), v => { const job = pp.active; if (job) { job.item.bg = v; ppSyncItem(); } });
function setPassportSize(size) {
  const job = pp.active; if (!job) return;
  job.size = size; Object.assign(job, passportOffsets(size)); if (job.item.auto) ppAutoAlign(job); ppSyncItem();
}
wireSeg($('#pp-size'), v => setPassportSize(formatById(PASSPORT, v)));
for (const [key, label, axis] of [['right', 'passport_right', 'passport_across'], ['down', 'passport_down', 'passport_down_axis']]) {
  $(`#pp-${key}`).addEventListener('change', e => {
    const job = pp.active, input = e.currentTarget; if (!job) return;
    const raw = input.value, next = Number(raw), old = job[key], L = sheetLayout(job);
    const spare = key === 'right' ? L.W - L.cols * job.size.w : L.H - L.rows * job.size.h;
    if (!input.validity.valid || input.value === '' || !Number.isFinite(next) || next < 0 || next > 20 || Math.round(next * 2) !== next * 2 || next > spare + 1e-9) {
      input.value = old;
      setStatus($('#pp-status'), t('passport_offset_doesnt_fit', t(label), raw, job.size.label, +spare.toFixed(1), t(axis)), true);
      return;
    }
    job[key] = next; pp.drawSheet(); queueSave('passport'); setStatus($('#pp-status'), '');
  });
}
$('#pp-zoom').addEventListener('input', e => { const job = pp.active; if (job) { job.item.zoom = +e.target.value; job.item.auto = ''; pp.preview.draw(); pp.drawSheet(); queueSave(); } });
$('#pp-reset').addEventListener('click', () => { const job = pp.active; if (job) { Object.assign(job.item, { zoom: 1, cx: .5, cy: .5, tilt: 0, auto: '' }); ppSyncItem(); } });
$('#pp-align-all').addEventListener('click', () => {
  const done = pp.jobs.filter(job => ppAutoAlign(job)).length, missing = pp.jobs.length - done;
  ppSyncItem();
  setStatus($('#pp-status'), missing ? t('passport_aligned_missing', done, missing) : t('passport_aligned', done), !!missing);
});
$('#pp-align').addEventListener('click', () => {
  const job = pp.active; if (!job) return;
  const st = $('#pp-status');
  if (job.face === null) setStatus(st, t('passport_looking_for_face'));
  else if (!ppAutoAlign(job)) setStatus(st, t(pp.config.faces ? 'passport_no_face' : 'passport_face_detection_not_installed'), true);
  else { ppSyncItem(); setStatus(st, t('passport_aligned_to_face')); }
});
$('#pp-guides').addEventListener('change', e => { pp.guides = e.target.checked; pp.preview.draw(); });

async function savePassport(job) {
  const { sheet, count } = renderSheet(job);
  const name = `${baseName(job.name)}_passport_${job.size.id}_x${count}.jpg`;
  const short = Math.min(job.size.w, job.size.h) / 10, long = Math.max(job.size.w, job.size.h) / 10;
  return PhotoRender.saveFile(await PhotoRender.jpegBlob(sheet, 1, DPI, job.item.density), name, `Passport ${short}x${long}`);
}
$('#pp-save').addEventListener('click', async () => {
  const job = pp.active, st = $('#pp-status');
  if (!job) return;
  try { setStatus(st, t('passport_saving')); setStatus(st, t('passport_saved_file', await savePassport(job))); }
  catch (e) { setStatus(st, e.message, true); }
});
$('#pp-save-all').addEventListener('click', async () => {
  const jobs = pp.jobs.filter(j => j.item), st = $('#pp-status');
  if (!jobs.length) return;
  let saved = 0;
  try {
    for (const job of jobs) {
      setStatus(st, t('passport_saving_count', saved + 1, jobs.length));
      await savePassport(job); saved++;
    }
    setStatus(st, t('passport_saved_sheets', saved));
  } catch (e) { setStatus(st, t('passport_saved_sheets_error', saved, e.message), true); }
});
