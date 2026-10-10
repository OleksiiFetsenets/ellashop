'use strict';
// Manages passport cutouts, face alignment, sheet previews, and export.
// Loads after Canvas and before shared keyboard controls.
// ---------------------------------------------------------------- passport
//
// Moved out of this file (the old copies are gone):
//   sheetLayout / passportOffsets          → PhotoSheet.passportLayout / passportOffsets (history.js and orders.js call it too)
//   renderSheet (grid, cut lines, tiles)   → PhotoSheet.fromPassport + PhotoRender.renderSheet
//   savePassport's JPEG save               → PhotoRender.exportSheet
//   Stage overlay (guide bands)            → PhotoEditor.passportRule(preset).guides
//   ppAutoAlign maths / cutoutCrown        → PhotoEditor.passportRule(preset).align / crownFromCutout

const pp ={ jobs: [], active: null, guides: true, queue: [], running: false, config: {} };
let nextJobId = 1;

$('#pp-size').innerHTML = PASSPORT.map(p => {
  const L = PhotoSheet.passportLayout(p);
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
  overlay: (ctx, item, pxPerMM) => { if (pp.guides) PhotoEditor.passportRule(pp.active.size).guides(ctx, item, pxPerMM); },
});
PhotoUI.keys.register('passport', {
  active: () => $('#passport').classList.contains('active'),
  item: () => pp.active?.item, stage: pp.preview, changed: () => ppSyncItem(),
});

const passportRule = job => PhotoEditor.passportRule(job.size);

// The job's sheet: one photo (the item at the preset size) repeated in the fixed grid at its offsets.
function passportSheet(job) {
  const def = PhotoSheet.passportOffsets(job.size);
  const sheet = PhotoSheet.fromPassport(job.size, { right: job.right ?? def.right, down: job.down ?? def.down }, { ...job.item, fmt: job.size });
  sheet.density = job.item.density;
  return sheet;
}

// Draw the job's sheet at print quality; also called from tests/ui/*.json.
function renderSheet(job) {
  const sheet = passportSheet(job);
  return { sheet: PhotoRender.renderSheet(sheet), count: sheet.root.children.length };
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
  PhotoUI.tabs($('#pp-tabs'), pp.jobs, {
    cls: { tab: 'pp-tab', pick: 'pp-pick', name: 'pp-name', state: 'pp-state', close: 'pp-close' },
    label: job => job.name,
    state: job => ({
      text: { new: '', queued: t('passport_queued'), removing: '…', done: '✓', error: '!' }[job.status],
      title: job.error || t(({ new: 'passport_new', queued: 'passport_queued', removing: 'passport_removing', done: 'passport_done', error: 'passport_error' })[job.status]),
    }),
    active: job => job === pp.active,
    onPick: job => { pp.active = job; ppSyncItem(); },
    onClose: job => {
      pp.jobs = pp.jobs.filter(x => x !== job);
      pp.queue = pp.queue.filter(x => x.job !== job);
      if (pp.active === job) pp.active = pp.jobs[0] || null;
      ppSyncItem();
    },
    closeTitle: t('passport_close_photo'),
  });
}

const syncPpDensity = densityControl($('#pp-density'), { item: () => pp.active?.item, items: () => pp.jobs.map(j => j.item), refresh: () => ppSyncItem() });
function ppSyncItem() {
  const job = pp.active, item = job?.item;
  $('#pp-right').value = job?.right ?? (job ? PhotoSheet.passportOffsets(job.size).right : 0);
  $('#pp-down').value = job?.down ?? (job ? PhotoSheet.passportOffsets(job.size).down : 0);
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
        size: PASSPORT[0], ...PhotoSheet.passportOffsets(PASSPORT[0]), status: 'new', error: '' };
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

// Use detected face landmarks and cutout crown to position the head.
// Match the preset chin and crown bands, leaving manual adjustment available.
function ppAutoAlign(job) {
  if (!job.face) return false;
  const rule = passportRule(job);
  // The crown comes from the cut-out's silhouette; null (so the rule estimates it) until there is one.
  rule.align(job.item, job.face, job.cutFile ? rule.crownFromCutout(job.item.img, job.face, job) : null);
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
  job.size = size; Object.assign(job, PhotoSheet.passportOffsets(size)); if (job.item.auto) ppAutoAlign(job); ppSyncItem();
}
wireSeg($('#pp-size'), v => setPassportSize(formatById(PASSPORT, v)));
for (const [key, label, axis] of [['right', 'passport_right', 'passport_across'], ['down', 'passport_down', 'passport_down_axis']]) {
  $(`#pp-${key}`).addEventListener('change', e => {
    const job = pp.active, input = e.currentTarget; if (!job) return;
    const raw = input.value, next = Number(raw), old = job[key], L = PhotoSheet.passportLayout(job.size);
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
  const sheet = passportSheet(job);
  const name = `${baseName(job.name)}_passport_${job.size.id}_x${sheet.root.children.length}.jpg`;
  const short = Math.min(job.size.w, job.size.h) / 10, long = Math.max(job.size.w, job.size.h) / 10;
  return PhotoRender.exportSheet(sheet, { name, folder: `Passport ${short}x${long}` });
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
