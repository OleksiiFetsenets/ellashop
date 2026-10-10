// Navigation between the photo tabs. Switching a tab asks every registered
// workspace to leave() and then activate() (workspaces.js); it names no page.

import { $, $$ } from './dom.js';
import { Workspaces } from './workspaces.js';
import { updateUndoButtons } from './history.js';
import { orderName } from './app-state.js';

// ---------------------------------------------------------------- tabs

// Switch tab: show its view and redraw every preview, since hidden canvases cannot be sized while display:none.
$$('.tab').forEach(t => t.addEventListener('click', () => {
  Workspaces.all().forEach(ws => ws.leave?.());
  $$('.tab').forEach(x => x.classList.toggle('active', x === t));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === t.dataset.tab));
  $$('.prints-order-control').forEach(x => { x.hidden = t.dataset.tab !== 'prints'; });
  Workspaces.all().forEach(ws => ws.activate());
  updateUndoButtons();
}));
// Open the exports folder in the file manager: the current order's folder on Prints, the root elsewhere.
$('#open-folder').addEventListener('click', () => fetch('/api/open-folder?folder=' + encodeURIComponent(
  document.querySelector('.tab.active')?.dataset.tab === 'prints' ? orderName() : ''), { method: 'POST' }));
