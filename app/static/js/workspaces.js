'use strict';
// The registry of workspaces (Prints, Canvas, Passport, Collage). Base scripts (history, orders, tabs, assets)
// loop over it and never name a page; each page registers itself at the end of its own file.
// Loads before the base scripts and the pages. A page only talks to another page through that page's `api`.
//
// Contract of a workspace:
//   id        'prints' | 'canvas' | 'passport' | 'collage'  (also the key of its history and saved state)
//   tab       value of data-tab on its tab button ('canvas-view' for Canvas)
//   order     true when its state belongs to the open Prints order; false for a standalone workspace
//   state()   the JSON that is saved to the server and recorded as an undo step (the saved format)
//   restore(state, { imageFor, source })
//             rebuild the workspace from saved state and show it. imageFor(file) loads a photo's image;
//             source is 'disk' (opening a saved order or workspace: one photo that fails to load is reported
//             and skipped) or 'undo' (history step: a failure throws)
//   clear()   empty the workspace in the UI only (nothing is deleted from disk)
//   refresh() redraw everything after the model changed, and schedule saving (the page's own refresh)
//   leave()   optional; called on every workspace just before another tab is shown
//   activate()  called on every workspace after the tab switch; redraws what a hidden canvas could not size
//   redraw()  optional; a font or sticker finished loading, redraw previews
//   images()  [[file, Image], ...] of the photos currently loaded (history keeps them for undo)
//   count()   number of photos
//   status(message, isError)  show a message in the workspace's status line
//   api       the only functions other pages may call
const Workspaces = (() => {
  const list = [];
  return {
    register(ws) { list.push(ws); return ws; },
    all: () => list,
    get: id => list.find(ws => ws.id === id),
    // Workspaces saved on their own, outside any order.
    standalone: () => list.filter(ws => !ws.order),
    // The workspace of the visible tab (Prints when no tab matches).
    active() {
      const tab = document.querySelector('.tab.active')?.dataset.tab;
      return list.find(ws => ws.tab === tab) || list.find(ws => ws.order);
    },
  };
})();
