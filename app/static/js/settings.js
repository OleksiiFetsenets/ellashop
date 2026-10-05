'use strict';
// Builds the storage, cleanup, and background-helper settings panel.
// Loads before the photo-tab scripts and uses the server storage API.
// ---------------------------------------------------------------- storage

const storageDialog = $('#storage-dialog');
let storageData = null;
const storageSize = bytes => {
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
};
const storageDate = value => value ? new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString() : '—';
const storageCellRow = (body, cells) => {
  const row = document.createElement('tr');
  for (const cell of cells) {
    const td = document.createElement('td'); td.textContent = cell; row.append(td);
  }
  body.append(row);
};
const storageNumber = (selector, minimum = 0) => {
  const input = $(selector), value = Number(input.value);
  const maximum = Number(input.max) || 3650, unit = input.parentElement.textContent.includes('hours') ? 'hours' : 'days';
  if (!input.checkValidity() || input.value === '' || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`Enter a whole number of ${unit} from ${minimum} to ${maximum}`);
  return value;
};

// Reconcile server storage totals and retention settings in the panel.
async function refreshStorage(updateSettings = true) {
  storageData = await orderRequest('/api/storage');
  const { orders, workspace, incoming, print_ready: finished, helper, settings } = storageData;
  const totals = $('#storage-totals'); totals.replaceChildren();
  for (const [label, count, bytes] of [
    ['Orders (Prints)', `${orders.photos} photos`, orders.bytes],
    ['Canvas workspace', `${workspace.canvas.photos} photos`, workspace.canvas.bytes],
    ['Passport workspace', `${workspace.passport.photos} photos`, workspace.passport.bytes],
    ['Collage workspace', `${workspace.collage.photos} photos`, workspace.collage.bytes],
    ['Incoming', `${incoming.files} files`, incoming.bytes],
    ['Exported files', `${finished.files} files`, finished.bytes],
  ]) storageCellRow(totals, [label, count, storageSize(bytes)]);
  const orderBody = $('#storage-orders'); orderBody.replaceChildren();
  for (const order of orders.items) storageCellRow(orderBody,
    [order.name || order.folder, storageDate(order.updated), String(order.photos), storageSize(order.bytes)]);
  const folderBody = $('#storage-folders'); folderBody.replaceChildren();
  for (const folder of finished.folders) storageCellRow(folderBody,
    [folder.name, String(folder.files), storageSize(folder.bytes), storageDate(folder.newest)]);
  $('#storage-helper').textContent = `Background removal helper: ${helper.running ? 'running' : 'stopped'} (frees its memory 2 minutes after the last use)`;
  if (updateSettings) {
    $('#auto-incoming').value = settings.auto_clean.incoming_days;
    $('#auto-orders').value = settings.auto_clean.orders_days;
    $('#auto-finished').value = settings.auto_clean.print_ready_hours;
  }
}

$('#open-storage').addEventListener('click', async () => {
  storageDialog.showModal();
  setStatus($('#storage-status'), 'Loading…');
  try { await flushOrder(); await refreshStorage(); setStatus($('#storage-status'), ''); }
  catch (e) { setStatus($('#storage-status'), e.message, true); }
});
$('#storage-close').addEventListener('click', () => storageDialog.close());

$$('[data-clean]').forEach(button => button.addEventListener('click', async () => {
  try {
    if (!storageData) await refreshStorage();
    const target = button.dataset.clean;
    const days = target === 'incoming' ? 0 : storageNumber(target === 'orders' ? '#storage-orders-days' : '#storage-finished-days', target === 'print_ready' ? 1 : 0);
    const cutoff = Date.now() - days * 86400000;
    const keep = currentOrder?.id;
    let items;
    if (target === 'orders') {
      items = storageData.orders.items.filter(order => order.id !== keep && new Date(order.updated).getTime() < cutoff);
    } else if (target === 'incoming') {
      items = storageData.incoming.items;
    } else {
      items = storageData.print_ready.folders.flatMap(folder => folder.items).filter(item => item.mtime * 1000 < cutoff);
    }
    const files = target === 'orders' ? items.reduce((sum, item) => sum + item.files, 0) : items.length;
    const bytes = items.reduce((sum, item) => sum + item.bytes, 0);
    const label = target === 'orders' ? `${items.length} orders (${files} files)` : `${files} files`;
    if (!confirm(`Delete ${label}, ${storageSize(bytes)}?`)) return;
    button.disabled = true;
    const body = { target, days };
    if (target === 'orders' && keep) body.keep = keep;
    const result = await orderRequest('/api/storage/clean', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await refreshStorage(false);
    await listOrders(); updateOrderPicker();
    setStatus($('#storage-status'), `Removed ${result.deleted_files} files (${storageSize(result.freed_bytes)}).`);
  } catch (e) { setStatus($('#storage-status'), e.message, true); }
  finally { button.disabled = false; }
}));

$('#storage-save').addEventListener('click', async () => {
  const button = $('#storage-save');
  try {
    const auto_clean = {
      incoming_days: storageNumber('#auto-incoming'),
      orders_days: storageNumber('#auto-orders'),
      print_ready_hours: storageNumber('#auto-finished'),
    };
    button.disabled = true;
    await orderRequest('/api/storage/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ auto_clean }),
    });
    await refreshStorage();
    setStatus($('#storage-status'), 'Auto-clean settings saved.');
  } catch (e) { setStatus($('#storage-status'), e.message, true); }
  finally { button.disabled = false; }
});

for (const tab of ['canvas', 'passport', 'collage']) {
  $(`#${tab}-clear`).addEventListener('click', async () => {
    const label = tab === 'canvas' ? 'Canvas' : tab === 'collage' ? 'Collage' : 'Passport';
    if (!confirm(`Remove all photos from ${label}? Files already exported stay.`)) return;
    const ws = workspaces[tab];
    clearTimeout(ws.timer); ws.timer = 0;
    try {
      await ws.chain;
      ws.loading = true;
      ++ws.epoch;
      await orderRequest(`/api/workspace/${tab}/clear`, { method: 'POST' });
      clearTab(tab);
    } catch (e) { showWorkspaceError(tab, e); }
    finally { ws.loading = false; resetHistory(tab); }
  });
}


// Full cleanup: stop pending saves, delete everything on disk, then start with empty tabs and a new order.
$('#full-clean').addEventListener('click', async () => {
  const button = $('#full-clean');
  try {
    await refreshStorage(false);
    const d = storageData, ws = d.workspace || {};
    const workFiles = Object.values(ws).reduce((sum, w) => sum + (w.files || 0), 0);
    const total = d.incoming.bytes + d.orders.bytes + d.print_ready.bytes + Object.values(ws).reduce((sum, w) => sum + (w.bytes || 0), 0);
    if (!confirm(`Delete EVERYTHING?\n\n• Incoming: ${d.incoming.files} files\n• Prints orders: ${d.orders.items.length} (${d.orders.photos} photos)\n` +
      `• Canvas, Passport, and Collage work: ${workFiles} files\n• Finished files: ${d.print_ready.files}\n\n${storageSize(total)} in total. This cannot be undone.`)) return;
    button.disabled = true;
    clearTimeout(saveTimer); saveTimer = 0; ++orderEpoch; loadingOrder = true; currentOrder = null;
    for (const tab of ['canvas', 'passport', 'collage']) {
      const w = workspaces[tab];
      clearTimeout(w.timer); w.timer = 0;
      await w.chain.catch(() => {});
      w.loading = true; ++w.epoch;
    }
    const result = await orderRequest('/api/storage/full-clean', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'everything' }),
    });
    for (const tab of ['canvas', 'passport', 'collage']) { clearTab(tab); workspaces[tab].loading = false; resetHistory(tab); }
    const order = await orderRequest('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    await listOrders(); await switchOrder(order.id, false);
    await refreshStorage(false);
    setStatus($('#storage-status'), `Full cleanup: removed ${result.deleted_files} files (${storageSize(result.freed_bytes)}).`);
  } catch (e) { setStatus($('#storage-status'), e.message, true); }
  finally { button.disabled = false; }
});
