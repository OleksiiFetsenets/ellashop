// Starts the browser app, restores prior work, and checks for updates.
// The entry module: index.html loads only this file and the imports below pull in everything else.
// The side-effect imports are listed in the order the pages used to load, so workspaces still register tab by tab.
// Updates: the server checks GitHub Releases (app/update.json) and reports here; the button
// only appears when a newer version exists. Installing replaces code files only, then restarts.

import './dom.js';
import './i18n.js';
import './config.js';
import './app-config.js';
import './workspaces.js';
import './assets.js';
import './app-state.js';
import './history.js';
import './orders.js';
import './ui.js';
import './editor.js';
import './tabs.js';
import './photo-editor.js';
import './photo-render.js';
import './photo-ui.js';
import './photo-sheet.js';
import './prints.js';
import './canvas.js';
import './passport.js';
import './collage.js';
import './settings.js';
import './shortcuts.js';
import { $ } from './dom.js';
import { t } from './i18n.js';
import { FORMATS, mm2px } from './config.js';
import { flushOrder, listOrders, queueSave, restoreWorkspace, showOrderError, showWorkspaceError, switchOrder } from './orders.js';
import { lastOrder, orderPicker, orderRequest, rememberOrder } from './app-state.js';
import { Workspaces } from './workspaces.js';
import { redo, undo } from './history.js';
import { prints } from './prints.js';
import { canvasPrints } from './canvas.js';
import { pp, renderSheet } from './passport.js';
import { cellRects, collage, collageCells, collageDpi, collageFilledLeaves, collageFirstEmpty, collageLeaf, collagePlace, collageSelect, collageSetCellFormats, collageSharedSegments, collageSheet, collageSheetMM, collageTreeDividers, refreshCollage, renderCollage } from './collage.js';

// The one debug handle: the UI test journeys (tests/ui/*.json) read and drive the app through it.
window.ellashop = {
  prints, canvasPrints, pp, collage, orderPicker, FORMATS, mm2px, queueSave, undo, redo, renderSheet, renderCollage,
  cellRects, collageCells, collageDpi, collageFilledLeaves, collageFirstEmpty, collageLeaf, collagePlace, collageSelect,
  collageSetCellFormats, collageSharedSegments, collageSheet, collageSheetMM, collageTreeDividers, refreshCollage,
};

// Show the update button only when the server reports a newer release.
async function checkUpdate() {
  try {
    const { version, update } = await (await fetch('/api/version')).json();
    const btn = $('#update-btn');
    btn.title = t('common_version_title', version);
    btn.hidden = !update?.available;
    if (update?.available) btn.textContent = t('common_update_to', update.latest);
    btn.dataset.notes = update?.notes || '';
  } catch { /* offline: no update button */ }
}
$('#update-btn').addEventListener('click', async () => {
  const btn = $('#update-btn');
  if (!confirm(t('common_update_confirm', btn.textContent, btn.dataset.notes))) return;
  btn.disabled = true; btn.textContent = t('common_updating');
  try {
    const res = await fetch('/api/update', { method: 'POST' }), data = await res.json();
    if (!res.ok) throw new Error(data.error || t('common_update_failed'));
    btn.textContent = t('common_restarting');
    await flushOrder?.();
    // Poll once a second for up to 60 s.
    for (let i = 0; i < 60; i++) {  // wait for the restarted server, then reload the page
      await new Promise(r => setTimeout(r, 1000));
      try { if ((await fetch('/api/version')).ok) { location.reload(); return; } } catch { /* still restarting */ }
    }
  } catch (e) { btn.disabled = false; btn.textContent = t('common_update_failed_detail', e.message); }
});
checkUpdate();

// Start-up: when the last session left photos behind, ask whether to continue or start fresh.
// Start fresh empties the independent workspaces and opens an empty Prints order;
// earlier Prints orders stay in the Order list (delete them there or in ⚙ Settings).
// Resolves after the user has chosen; the rest of start-up runs afterwards and loads whatever remains.
async function askResume() {
  const [canvas, passport, collageState, orders] = await Promise.all(['/api/workspace/canvas', '/api/workspace/passport', '/api/workspace/collage', '/api/orders'].map(url => orderRequest(url)));
  const last = orders.find(x => x.id === lastOrder()) || orders[0];
  const counts = [[t('common_prints'), last?.counts.prints || 0, last ? t('common_resume_order', last.name || last.folder) : ''],
    [t('common_canvas'), (canvas.items || []).length, ''], [t('common_passport'), (passport.jobs || []).length, ''],
    [t('common_collage'), (collageState.photos || []).length, '']].filter(([, n]) => n);
  if (!counts.length) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'resume-dialog';
  dlg.innerHTML = `<h3>${t('common_resume_title')}</h3>
    <p>${t('common_resume_intro')}</p>
    <ul>${counts.map(([tab, n, extra]) => `<li><b>${tab}</b>: ${t('common_photo_count', n)}${extra.replace(/</g, '&lt;')}</li>`).join('')}</ul>
    <div class="row"><button value="fresh">${t('common_start_fresh')}</button><button value="continue" class="primary" autofocus>${t('common_continue')}</button></div>`;
  document.body.append(dlg);
  const choice = await new Promise(resolve => {
    dlg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) resolve(b.value); });
    dlg.addEventListener('cancel', () => resolve('continue'));   // Esc keeps everything
    dlg.showModal();
  });
  dlg.close(); dlg.remove();
  if (choice !== 'fresh') return;
  await Promise.all(Workspaces.standalone().map(({ id: tab }) => orderRequest(`/api/workspace/${tab}/clear`, { method: 'POST' })));
  if (last?.counts.prints) {
    const order = await orderRequest('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    rememberOrder(order.id);
  }
}

// Start-up order: resume prompt, restore the three workspaces (a failure in one does not stop the others),
// then open the last used order, or create one when there are none.
(async () => {
  try {
    try { await askResume(); } catch (e) { showOrderError(e); }
    const workspaceTabs = Workspaces.standalone().map(ws => ws.id);
    const restored = await Promise.allSettled(workspaceTabs.map(restoreWorkspace));
    restored.forEach((result, index) => {
      if (result.status === 'rejected') showWorkspaceError(workspaceTabs[index], result.reason);
    });
    const orders = await listOrders();
    const id = orders.some(x => x.id === lastOrder()) ? lastOrder() : orders[0]?.id;
    if (id) await switchOrder(id, false);
    else {
      const order = await orderRequest('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await listOrders(); await switchOrder(order.id, false);
    }
  } catch (e) { showOrderError(e); }
})();
