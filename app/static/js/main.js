'use strict';
// Starts the browser app, restores prior work, and checks for updates.
// Loads last after every shared helper and photo tab has initialized.
// Updates: the server checks GitHub Releases (app/update.json) and reports here; the button
// only appears when a newer version exists. Installing replaces code files only, then restarts.
async function checkUpdate() {
  try {
    const { version, update } = await (await fetch('/api/version')).json();
    const btn = $('#update-btn');
    btn.title = `Ellashop ${version}`;
    btn.hidden = !update?.available;
    if (update?.available) btn.textContent = `Update to v${update.latest}`;
    btn.dataset.notes = update?.notes || '';
  } catch { /* offline: no update button */ }
}
$('#update-btn').addEventListener('click', async () => {
  const btn = $('#update-btn');
  if (!confirm(`${btn.textContent}?\n\n${btn.dataset.notes}\n\nEllashop restarts; photos and orders are kept.`)) return;
  btn.disabled = true; btn.textContent = 'Updating…';
  try {
    const res = await fetch('/api/update', { method: 'POST' }), data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Update failed');
    btn.textContent = 'Restarting…';
    await flushOrder?.();
    for (let i = 0; i < 60; i++) {  // wait for the restarted server, then reload the page
      await new Promise(r => setTimeout(r, 1000));
      try { if ((await fetch('/api/version')).ok) { location.reload(); return; } } catch { /* still restarting */ }
    }
  } catch (e) { btn.disabled = false; btn.textContent = 'Update failed — ' + e.message; }
});
checkUpdate();
pp.drawSheet();
syncPrintControls();

// Start-up: when the last session left photos behind, ask whether to continue or start fresh.
// Start fresh empties the independent workspaces and opens an empty Prints order;
// earlier Prints orders stay in the Order list (delete them there or in ⚙ Settings).
async function askResume() {
  const [canvas, passport, collageState, orders] = await Promise.all(['/api/workspace/canvas', '/api/workspace/passport', '/api/workspace/collage', '/api/orders'].map(url => orderRequest(url)));
  const last = orders.find(x => x.id === lastOrder()) || orders[0];
  const counts = [['Prints', last?.counts.prints || 0, last ? ` (order “${last.name || last.folder}”)` : ''],
    ['Canvas', (canvas.items || []).length, ''], ['Passport', (passport.jobs || []).length, ''],
    ['Collage', (collageState.photos || []).length, '']].filter(([, n]) => n);
  if (!counts.length) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'resume-dialog';
  dlg.innerHTML = `<h3>Continue where you left off?</h3>
    <p>The last session still has photos:</p>
    <ul>${counts.map(([tab, n, extra]) => `<li><b>${tab}</b>: ${n} photo${n === 1 ? '' : 's'}${extra.replace(/</g, '&lt;')}</li>`).join('')}</ul>
    <div class="row"><button value="fresh">Start fresh</button><button value="continue" class="primary" autofocus>Continue</button></div>`;
  document.body.append(dlg);
  const choice = await new Promise(resolve => {
    dlg.addEventListener('click', e => { const b = e.target.closest('button'); if (b) resolve(b.value); });
    dlg.addEventListener('cancel', () => resolve('continue'));   // Esc keeps everything
    dlg.showModal();
  });
  dlg.close(); dlg.remove();
  if (choice !== 'fresh') return;
  await Promise.all(['canvas', 'passport', 'collage'].map(tab => orderRequest(`/api/workspace/${tab}/clear`, { method: 'POST' })));
  if (last?.counts.prints) {
    const order = await orderRequest('/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    rememberOrder(order.id);
  }
}

(async () => {
  try {
    try { await askResume(); } catch (e) { showOrderError(e); }
    const workspaceTabs = ['canvas', 'passport', 'collage'];
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
