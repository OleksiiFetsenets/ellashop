// Undo / redo controls. Photo keys are handled by PhotoUI.keys.
// Imported last by main.js so the page controls exist.

import { $ } from './dom.js';
import { redo, undo } from './history.js';
$('#undo').addEventListener('click', () => undo());
$('#redo').addEventListener('click', () => redo());
// ⌘Z / Ctrl+Z undo, ⇧⌘Z / Ctrl+Shift+Z (or Ctrl+Y) redo. Inside text fields the browser's own text undo runs.
document.addEventListener('keydown', e => {
  const key = e.key.toLowerCase();
  if (!(e.metaKey || e.ctrlKey) || e.altKey || (key !== 'z' && key !== 'y')) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  e.preventDefault();
  if (key === 'y' || e.shiftKey) redo(); else undo();
}, true);
