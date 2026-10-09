'use strict';
// Builds the storage, cleanup, and background-helper settings panel.
// Loads before the photo-tab scripts and uses the server storage API.
// ---------------------------------------------------------------- storage

const storageDialog = $('#storage-dialog');
let storageData = null;
// Human-readable size (B, KB, MB, GB).
const storageSize = bytes => {
  if (bytes < 1024) return t('settings_bytes', bytes);
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return t(['settings_bytes', 'settings_kilobytes', 'settings_megabytes', 'settings_gigabytes'][unit], (bytes / 1024 ** unit).toFixed(1));
};
// Numbers are Unix seconds, strings are ISO dates.
const storageDate = value => value ? new Date(typeof value === 'number' ? value * 1000 : value).toLocaleString() : '—';
// Append a table row of plain-text cells.
const storageCellRow = (body, cells) => {
  const row = document.createElement('tr');
  for (const cell of cells) {
    const td = document.createElement('td'); td.textContent = cell; row.append(td);
  }
  body.append(row);
};
// Read and validate a whole-number retention input (limit from the input's max, default 3650).
// #auto-finished is in hours, the other inputs in days.
const storageNumber = (selector, minimum = 0) => {
  const input = $(selector), value = Number(input.value);
  const maximum = Number(input.max) || 3650, unit = selector === '#auto-finished' ? t('settings_hours') : t('settings_days');
  if (!input.checkValidity() || input.value === '' || !Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(t('settings_number_error', unit, minimum, maximum));
  return value;
};

// Reconcile server storage totals and retention settings in the panel.
async function refreshStorage(updateSettings = true) {
  storageData = await orderRequest('/api/storage');
  const { orders, workspace, incoming, print_ready: finished, helper, settings } = storageData;
  const totals = $('#storage-totals'); totals.replaceChildren();
  for (const [label, count, bytes] of [
    [t('settings_orders_prints'), t('settings_photos', orders.photos), orders.bytes],
    [t('settings_canvas_workspace'), t('settings_photos', workspace.canvas.photos), workspace.canvas.bytes],
    [t('settings_passport_workspace'), t('settings_photos', workspace.passport.photos), workspace.passport.bytes],
    [t('settings_collage_workspace'), t('settings_photos', workspace.collage.photos), workspace.collage.bytes],
    [t('settings_incoming'), t('settings_files', incoming.files), incoming.bytes],
    [t('settings_exported_files'), t('settings_files', finished.files), finished.bytes],
  ]) storageCellRow(totals, [label, count, storageSize(bytes)]);
  const orderBody = $('#storage-orders'); orderBody.replaceChildren();
  for (const order of orders.items) storageCellRow(orderBody,
    [order.name || order.folder, storageDate(order.updated), String(order.photos), storageSize(order.bytes)]);
  const folderBody = $('#storage-folders'); folderBody.replaceChildren();
  for (const folder of finished.folders) storageCellRow(folderBody,
    [folder.name, String(folder.files), storageSize(folder.bytes), storageDate(folder.newest)]);
  $('#storage-helper').textContent = t(helper.running ? 'settings_helper_running' : 'settings_helper_stopped');
  if (updateSettings) {
    $('#auto-incoming').value = settings.auto_clean.incoming_days;
    $('#auto-orders').value = settings.auto_clean.orders_days;
    $('#auto-finished').value = settings.auto_clean.print_ready_hours;
  }
}

$('#open-storage').addEventListener('click', async () => {
  storageDialog.showModal();
  setStatus($('#storage-status'), t('settings_loading'));
  try {
    const { current, languages } = await orderRequest('/api/languages');
    const picker = $('#settings-language');
    picker.replaceChildren(...languages.map(({ code, name }) => new Option(name, code)));
    picker.value = current;
    await flushOrder(); await refreshStorage(); setStatus($('#storage-status'), '');
  }
  catch (e) { setStatus($('#storage-status'), e.message, true); }
});
$('#storage-close').addEventListener('click', () => storageDialog.close());
$('#settings-language').addEventListener('change', async (event) => {
  const picker = event.target;
  picker.disabled = true;
  try {
    await orderRequest('/api/language', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: picker.value }),
    });
    location.reload();
  } catch (e) { setStatus($('#storage-status'), e.message, true); picker.disabled = false; }
});

$$('[data-clean]').forEach(button => button.addEventListener('click', async () => {
  try {
    if (!storageData) await refreshStorage();
    const target = button.dataset.clean;
    // Incoming is cleaned entirely (0 days); finished files need at least 1.
    const days = target === 'incoming' ? 0 : storageNumber(target === 'orders' ? '#storage-orders-days' : '#storage-finished-days', target === 'print_ready' ? 1 : 0);
    // Preview of what the server will delete: items older than the cutoff (86400000 ms = 1 day); the
    // open order is always kept.
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
    const label = target === 'orders' ? t('settings_orders_files', items.length, files) : t('settings_files', files);
    if (!confirm(t('settings_delete_confirm', label, storageSize(bytes)))) return;
    button.disabled = true;
    const body = { target, days };
    if (target === 'orders' && keep) body.keep = keep;
    const result = await orderRequest('/api/storage/clean', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    await refreshStorage(false);
    await listOrders(); updateOrderPicker();
    setStatus($('#storage-status'), t('settings_removed', result.deleted_files, storageSize(result.freed_bytes)));
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
    setStatus($('#storage-status'), t('settings_saved'));
  } catch (e) { setStatus($('#storage-status'), e.message, true); }
  finally { button.disabled = false; }
});

for (const tab of ['canvas', 'passport', 'collage']) {
  $(`#${tab}-clear`).addEventListener('click', async () => {
    const label = tab === 'canvas' ? t('settings_canvas') : tab === 'collage' ? t('settings_collage') : t('settings_passport');
    if (!confirm(t('settings_clear_tab', label))) return;
    const ws = workspaces[tab];
    clearTimeout(ws.timer); ws.timer = 0;
    try {
      await ws.chain;
      // Block saves and invalidate any queued save or restore (see workspaces in render.js).
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
    if (!confirm(t('settings_full_clean_confirm', d.incoming.files, d.orders.items.length, d.orders.photos, workFiles, d.print_ready.files, storageSize(total)))) return;
    button.disabled = true;
    // Freeze every writer first (timers, epochs, loading flags) so no autosave recreates files while they are deleted.
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
    setStatus($('#storage-status'), t('settings_full_clean_result', result.deleted_files, storageSize(result.freed_bytes)));
  } catch (e) { setStatus($('#storage-status'), e.message, true); }
  finally { button.disabled = false; }
});
