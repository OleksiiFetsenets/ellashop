'use strict';
// Shared page UI: the controls every photo page repeats (drop zone, photo list, grid/single view bar,
// stage, orientation, fill mode, blur, adjust row, measurements, composition guides, save buttons,
// status) built once from a page prefix, plus the wiring that connects them to the Photo Editor
// and the Render engine. Text comes from data-i18n ids (app/static/lang/en/page.json), so
// applyStrings() translates the built markup like the hand-written one.
// Loaded by index.html after photo-editor.js and photo-render.js.
//
// Derived from (originals are unchanged, except renderQueue / photoGrid, which moved here from prints.js):
//   PhotoUI.dropZone / stage / orientSeg / fillModeSeg / blurControls / adjustRow / guideChecks /
//   saveActions / status                  ← index.html #prints and #canvas-view sections (same classes and ids
//                                           with the page prefix, e.g. canvas-rot-l, canvas-zoom)
//   PhotoUI.wireAdjust                    ← prints.js #rot-l/#rot-r/#zoom/#reset, canvas.js equivalents
//   PhotoUI.syncAdjust                    ← prints.js syncPrintControls (zoom, tilt, segments)
//   PhotoUI.wireGuides                    ← shortcuts.js measurement and composition loops (incl. Collage)
//   PhotoUI.keys                          ← shortcuts.js overlay, zoom, pan/tilt, view and O key handlers
//   PhotoUI.wireSave                      ← prints.js #save-one/#save-all, canvas.js, passport.js, collage.js
//   PhotoUI.renderQueue / photoGrid       ← prints.js renderQueue / photoGrid
//   PhotoUI.photoCanvas / paintCached     ← photoGrid card pan and cached paint; collage.js cell pan, wheel zoom and paint
//   PhotoUI.stepBar / neighbour           ← photoGrid Prev/Next/count; collage.js single view uses them too
//   PhotoUI.tabs                          ← collage.js renderCollageTabs and passport.js ppTabs
//   wireDrop, wireSeg, setSeg             ← reused from ui.js as they are

const PhotoUI = (() => {
  // Parse an HTML string into a DocumentFragment.
  const html = s => { const tpl = document.createElement('template'); tpl.innerHTML = s.trim(); return tpl.content; };
  // localStorage wrapper that never throws (private mode, blocked storage).
  const store = {
    get(key, fallback = '') { try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch (_) { /* storage may be unavailable */ } },
  };

  // ------------------------------------------------------------ markup

  // Replace a placeholder element with built parts and translate them.
  function mount(placeholder, ...parts) {
    const box = document.createElement('div');
    box.append(...parts);
    applyStrings(box);
    placeholder.replaceWith(...box.childNodes);
  }

  // `p` is the page prefix ("prints", "canvas"): every id built below is `${p}-...`.
  function dropZone(p) {
    return html(`
      <label class="drop" id="${p}-drop">
        <input type="file" id="${p}-file" accept="image/*,.zip" multiple hidden>
        <strong data-i18n="page_drop_photos_here"></strong><br><span data-i18n="page_or_click_to_choose"></span>
      </label>
      <button class="ghost wide" data-incoming="${p}" data-i18n="page_load_from_incoming_folder"></button>
      <ul id="${p}-queue" class="queue"></ul>`);
  }

  // View bar (grid/single, prev/next), grid, preview canvas and hint inside a .stage element.
  function stage(p, hintId) {
    return html(`
      <div class="stage" id="${p}-stage">
        <div class="view-bar" id="${p}-view-bar" hidden>
          <div class="seg"><button data-view="grid" data-i18n="page_grid"></button><button data-view="single" data-i18n="page_single"></button></div>
          <button data-step="-1" data-i18n="page_prev"></button><span class="view-count"></span><button data-step="1" data-i18n="page_next"></button>
        </div>
        <div class="photo-grid" id="${p}-grid" hidden></div>
        <canvas id="${p}-canvas"></canvas>
        <p class="hint" id="${p}-hint" data-i18n="${hintId}"></p>
      </div>`);
  }

  function orientSeg(p) {
    return html(`
      <h3 data-i18n="page_orientation"></h3>
      <div class="seg" id="${p}-orient">
        <button data-v="auto" class="on" data-i18n="page_auto"></button>
        <button data-v="portrait" data-i18n="page_portrait"></button>
        <button data-v="landscape" data-i18n="page_landscape"></button>
      </div>`);
  }

  // heading / labels override the title and the three button texts (Collage: "Selected cell", short labels).
  function fillModeSeg(p, { heading = 'page_fill', labels = ['page_crop_to_fill', 'page_fit_white_border', 'page_fit_blurred_border'] } = {}) {
    return html(`
      <h3 data-i18n="${heading}"></h3>
      <div class="seg" id="${p}-mode">
        <button data-v="fill" class="on" data-i18n="${labels[0]}"></button>
        <button data-v="fit" data-i18n="${labels[1]}"></button>
        <button data-v="blur" data-i18n="${labels[2]}"></button>
      </div>`);
  }

  // Hidden until the fill mode is 'blur' (Prints); Canvas always shows it ({ hidden: false }).
  function blurControls(p, { hidden = true } = {}) {
    return html(`
      <div id="${p}-blur-controls"${hidden ? ' hidden' : ''}>
        <h3 data-i18n="page_blur_type"></h3>
        <div class="seg" id="${p}-blur">
          <button data-v="motion" class="on" data-i18n="page_motion"></button>
          <button data-v="gaussian" data-i18n="page_gaussian"></button>
        </div>
        <h3 data-i18n="page_strength"></h3>
        <input type="range" id="${p}-strength" min="1" max="100" value="50">
      </div>`);
  }

  // heading: false leaves the "Adjust" title out (Collage titles the whole group "Selected cell").
  function adjustRow(p, { heading = true } = {}) {
    return html(`
      ${heading ? `<h3 data-i18n="page_adjust"></h3>
      ` : ''}<div class="row">
        <button id="${p}-rot-l" data-i18n-title="page_rotate_left">⟲</button>
        <button id="${p}-rot-r" data-i18n-title="page_rotate_right">⟳</button>
        <input type="range" id="${p}-zoom" min="1" max="6" step="0.01" value="1" data-i18n-title="page_zoom">
        <span class="tilt-label" id="${p}-tilt" data-i18n="page_tilt_0_0"></span>
        <button id="${p}-reset" data-i18n-title="page_reset_crop" data-i18n="page_reset"></button>
      </div>`);
  }

  // Measurements checkbox and composition guide picker with its ↻ button.
  // measure: false leaves the checkbox out (Collage); hiddenRow gives the picker row the id `${p}-composition-row`
  // and starts it hidden, so the page can show it only in single view (Collage).
  function guideChecks(p, { composition = true, measure = true, hiddenRow = false } = {}) {
    return html(`
      ${measure ? `<label class="check"><input type="checkbox" id="${p}-measure"> <span data-i18n="page_show_measurements_cm"></span></label>` : ''}
      ${composition ? `<label class="check composition-row"${hiddenRow ? ` id="${p}-composition-row" hidden` : ''}><span data-i18n="page_composition_guides"></span> <select id="${p}-composition">
        <option value="" data-i18n="page_none"></option><option value="thirds" data-i18n="page_rule_of_thirds"></option><option value="golden" data-i18n="page_golden_ratio"></option>
        <option value="spiral" data-i18n="page_fibonacci_spiral"></option><option value="diagonals" data-i18n="page_diagonals"></option>
        <option value="triangles" data-i18n="page_golden_triangles"></option><option value="perspective" data-i18n="page_perspective"></option>
      </select><button type="button" id="${p}-composition-turn" data-i18n-title="page_turn_flip_the_guide_key_o">↻</button></label>` : ''}`);
  }

  // Save one / Save all buttons and the status line. Label ids differ per page; announce: true adds
  // role="status" to the status line (Collage).
  function saveActions(p, { one, all = 'page_save_all', announce = false }) {
    return html(`
      <div class="actions">
        <button id="${p}-save-one" class="primary" data-i18n="${one}"></button>
        ${all ? `<button id="${p}-save-all" class="primary" data-i18n="${all}"></button>` : ''}
      </div>
      <p class="status" id="${p}-status"${announce ? ' role="status"' : ''}></p>`);
  }

  // ------------------------------------------------------------ wiring

  // Rotate, zoom slider and reset for the selected item. `changed` runs after every edit.
  function wireAdjust(p, { item, changed, redraw }) {
    // Wrap an edit: run it on the selected item (if any), then let the page refresh.
    const act = fn => () => { const it = item(); if (it) { fn(it); changed(); } };
    $(`#${p}-rot-l`).addEventListener('click', act(it => PhotoEditor.rotate(it, -90)));
    $(`#${p}-rot-r`).addEventListener('click', act(it => PhotoEditor.rotate(it, 90)));
    $(`#${p}-reset`).addEventListener('click', act(it => PhotoEditor.reset(it)));
    $(`#${p}-zoom`).addEventListener('input', e => { const it = item(); if (it) { PhotoEditor.setZoom(it, +e.target.value); redraw(); } });
  }

  // Show the selected item's values in the shared controls (whichever of them the page has).
  function syncAdjust(p, it) {
    const el = id => document.getElementById(`${p}-${id}`);
    if (it) {
      if (el('orient')) setSeg(el('orient'), it.orient);
      if (el('mode')) setSeg(el('mode'), it.mode);
      if (el('blur')) setSeg(el('blur'), it.blur);
      if (el('strength')) el('strength').value = it.strength;
      el('zoom').value = it.zoom;
    }
    if (el('blur-controls') && el('mode')) el('blur-controls').hidden = !it || it.mode !== 'blur';
    // Zoom has no meaning in fit/blur modes, so the slider is disabled there.
    el('zoom').disabled = !it || !PhotoEditor.canZoom(it);
    el('tilt').textContent = tiltLabel(it);
  }

  // Measurements and composition guides, remembered per page; ↻ (or O) turns the guide.
  function wireGuides(p, stageView, key = p) {
    const box = $(`#${p}-measure`);
    if (box) {
      box.checked = store.get('ellashop-measure-' + key) === 'on';
      stageView.showMeasure = box.checked;
      box.addEventListener('change', () => {
        stageView.showMeasure = box.checked; stageView.draw();
        store.set('ellashop-measure-' + key, box.checked ? 'on' : 'off');
      });
    }
    const select = $(`#${p}-composition`), turn = $(`#${p}-composition-turn`);
    if (!select) return;
    select.value = store.get('ellashop-composition-' + key);
    stageView.compositionTurn = +store.get('ellashop-composition-turn-' + key, '0');
    stageView.composition = select.value;
    const save = () => { store.set('ellashop-composition-' + key, select.value); store.set('ellashop-composition-turn-' + key, stageView.compositionTurn); };
    select.addEventListener('change', () => { stageView.composition = select.value; stageView.draw(); save(); });
    // compositionTurn counts quarter turns (0-3) of the guide.
    stageView.turnComposition = () => { stageView.compositionTurn = ((stageView.compositionTurn || 0) + 1) % 4; stageView.draw(); save(); };
    turn.addEventListener('click', stageView.turnComposition);
  }

  // Save one / Save all with status messages. `save(it)` returns the saved path (PhotoRender.exportItem),
  // or null when the user cancelled: nothing is reported or counted then (Collage's empty-cell confirm).
  // msg: { saving, savedFile, savingCount, savedAll } translation ids for this page.
  function wireSave(p, { item, items, save, msg, folder = () => '' }) {
    const st = $(`#${p}-status`);
    $(`#${p}-save-one`).addEventListener('click', async () => {
      const it = item(); if (!it) return;
      try { setStatus(st, t(msg.saving)); const path = await save(it); if (path) setStatus(st, t(msg.savedFile, path)); }
      catch (e) { setStatus(st, e.message, true); }
    });
    $(`#${p}-save-all`)?.addEventListener('click', async () => {
      const list = items(); if (!list.length) return;
      try {
        const saved = await PhotoRender.exportAll(list, save, (i, n) => setStatus(st, t(msg.savingCount, i, n)));
        setStatus(st, t(msg.savedAll, saved.length, folder()));
      } catch (e) { setStatus(st, e.message, true); }
    });
  }

  // ------------------------------------------------------------ photo list and grid

  // Left-side photo list: thumbnail, name, label, remove button.
  function renderQueue(state, q, refresh, label) {
    q.innerHTML = '';
    state.items.forEach(it => {
      const li = document.createElement('li');
      li.className = it === state.sel ? 'sel' : '';
      li.innerHTML = `<img src="${it.img.src}"><div class="meta"><div class="name"></div><div class="fmt"></div></div><button class="del" title="${t('prints_remove')}">✕</button>`;
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

  // The photo `delta` places after `sel` in `list` (null past either end); drives Prev/Next.
  function neighbour(list, sel, delta) { return list[list.indexOf(sel) + delta] || null; }

  // Prev / Next buttons and "n / total" counter of a view bar: shown in single view only.
  function stepBar(bar, list, sel, single) {
    const i = list.indexOf(sel), n = list.length;
    bar.querySelectorAll('[data-step]').forEach(b => {
      b.hidden = !single;
      b.disabled = b.dataset.step === '-1' ? sel === list[0] : sel === list[n - 1];
    });
    const counter = bar.querySelector('.view-count');
    counter.hidden = !single; counter.textContent = `${Math.max(0, i + 1)} / ${n}`;
  }

  // Draw `item` on `canvas` at W x H pixels, only when something that affects its pixels changed.
  // `extraKey` separates callers (page name, sheet density). Returns true when it painted.
  function paintCached(canvas, item, mm, W, H, render, extraKey = '') {
    const key = [extraKey, item.img.src, mm.w, mm.h, W, H, item.rot, item.tilt, item.zoom, item.cx, item.cy,
      item.mode, item.bg, item.blur, item.strength, item.wrap, item.marks, JSON.stringify(item.overlays || []), assetVersion].join('|');
    if (canvas._renderKey === key) return false;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    render(canvas.getContext('2d'), item, W, H);
    canvas._renderKey = key;
    return true;
  }

  // Dragging on a photo canvas pans its crop (and the wheel zooms, when onWheel is given).
  //   frontRect  where the crop sits on the canvas (default: all of it)
  //   onSelect   pointer went down on it;  onMove  after each pan step;  onDone  after a drag that moved
  //   onWheel    after a wheel zoom; the page's own scrolling is blocked only when the mode can zoom
  function photoCanvas(canvas, item, { frontRect = (it, W, H) => ({ x: 0, y: 0, w: W, h: H }), onSelect, onMove, onDone, onWheel }) {
    let last = null, moved = false;
    canvas.addEventListener('pointerdown', e => {
      onSelect?.();
      last = [e.clientX, e.clientY]; moved = false; canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      if (!last) return;
      PhotoEditor.pan(item, canvas, frontRect, e.clientX - last[0], e.clientY - last[1]);
      last = [e.clientX, e.clientY]; moved = true;
      item.auto = ''; item.smartPending = false;
      onMove?.();
    });
    canvas.addEventListener('pointerup', () => { last = null; if (moved) onDone?.(); });
    canvas.addEventListener('pointercancel', () => { last = null; });
    if (onWheel) canvas.addEventListener('wheel', e => {
      if (!PhotoEditor.wheelZoom(item, e.deltaY)) return;
      e.preventDefault(); onWheel();
    }, { passive: false });
  }

  // Tab strip (Collage sheets, Passport photos): a pick button and a close button per tab.
  //   cls          the page's class names { tab, pick, name, close, state } (state only with `state`)
  //   label(x, i)  tab text;  state?(x) -> { text, title } status badge;  active(x)
  //   onPick(x, i), onClose(x, i)
  function tabs(container, list, { cls, label, state, active, onPick, onClose, closeTitle }) {
    container.replaceChildren();
    list.forEach((x, i) => {
      const tab = document.createElement('div');
      tab.className = cls.tab + (active(x) ? ' active' : '');
      const pick = document.createElement('button');
      pick.className = cls.pick; pick.type = 'button';
      const name = document.createElement('span');
      name.className = cls.name; name.textContent = label(x, i);
      pick.append(name);
      if (state) {
        const badge = document.createElement('span'), s = state(x);
        badge.className = cls.state; badge.textContent = s.text; badge.title = s.title;
        pick.append(badge);
      }
      pick.addEventListener('click', () => onPick(x, i));
      const close = document.createElement('button');
      close.className = cls.close; close.type = 'button'; close.title = closeTitle; close.textContent = '✕';
      close.addEventListener('click', e => { e.stopPropagation(); onClose(x, i); });
      tab.append(pick, close); container.append(tab);
    });
  }

  // Grid and single views kept in step; cards can be dragged to move the crop.
  // `state` has items, sel, view and preview (a PhotoEditor.Stage). `kind` keys the card cache.
  function photoGrid(state, stageEl, grid, bar, hint, label, sizeMM, render, refresh, kind) {
    const cards = new WeakMap();
    stageEl.classList.add('photo-stage');
    // Switch between 'grid' and 'single' view (does nothing with no photos).
    function choose(view) { if (state.items.length) { state.view = view; state.preview.overlayEditor?.select(null); update(); queueSave(); } }
    // Select the previous (-1) or next (+1) photo in single view.
    function step(delta) {
      const next = neighbour(state.items, state.sel, delta);
      if (next) { state.sel = next; refresh(); }
    }
    bar.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.view) choose(b.dataset.view);
      else if (b.dataset.step) step(+b.dataset.step);
    });
    function paint(card, it) {
      // Thumbnails are drawn about 300 CSS px on the long side.
      const mm = sizeMM(it), scale = 300 * devicePixelRatio / Math.max(mm.w, mm.h);
      paintCached(card.querySelector('canvas'), it, mm, Math.max(1, Math.round(mm.w * scale)), Math.max(1, Math.round(mm.h * scale)), render, kind);
    }
    function makeCard(it) {
      const card = document.createElement('div');
      card.className = 'photo-card';
      card.innerHTML = `<button class="eye" title="${t('prints_open_single_view')}">👁</button><canvas></canvas><div class="name"></div><div class="fmt"></div>`;
      card.addEventListener('click', () => { if (state.sel !== it) { state.sel = it; refresh(); } });
      card.querySelector('.eye').addEventListener('click', e => { e.stopPropagation(); state.sel = it; state.view = 'single'; refresh(); });
      // Dragging a thumbnail pans the crop; refresh() runs once on release, only if it moved.
      photoCanvas(card.querySelector('canvas'), it, {
        frontRect: state.preview.frontRect,
        onSelect: () => { if (state.sel !== it) { state.sel = it; refresh(); } },
        onMove: () => paint(card, it),
        onDone: refresh,
      });
      cards.set(it, card);
      return card;
    }
    // The visible thumbnail canvas of a photo, or null when the grid is hidden or the card is not shown.
    function cardCanvas(it) {
      return !grid.hidden && cards.get(it)?.isConnected ? cards.get(it).querySelector('canvas') : null;
    }
    function update() {
      // Default view: grid for several photos, single for one. Grid cards are rebuilt only for the active tab.
      const count = state.items.length, view = state.view || (count > 1 ? 'grid' : 'single');
      const single = view === 'single';
      bar.hidden = !count; grid.hidden = !count || single;
      state.preview.canvas.hidden = !single;
      hint.hidden = !!count && !single;
      bar.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === view));
      stepBar(bar, state.items, state.sel, single);
      if (grid.hidden || !stageEl.closest('.view.active')) return;
      grid.replaceChildren();
      for (const it of state.items) {
        const card = cards.get(it) || makeCard(it);
        paint(card, it);
        card.querySelector('canvas').style.filter = PhotoRender.densityFilter(it.density);
        card.querySelector('.name').textContent = it.name;
        card.querySelector('.fmt').textContent = label(it);
        card.classList.toggle('sel', it === state.sel);
        grid.appendChild(card);
      }
    }
    return { update, choose, step, cardCanvas };
  }

  // ------------------------------------------------------------ keyboard

  // One key handler for every photo page. A page registers once; the handler acts for the page whose
  // active() is true. Keys: arrows pan 0.5 mm (Alt: 0.1 mm), Shift+←/→ tilt 0.5° (Alt: 0.1°), +/− zoom 10%
  // (Alt: 2%), O turns the composition guide, Escape / [ / ] / PageUp / PageDown switch view and photo.
  // With a text overlay selected in single view, arrows, +/−, Delete and Escape act on the overlay instead.
  //   register(name, {
  //     active()      the page's tab is showing
  //     item()        the selected photo, or null
  //     stage         the Stage (canvas, sizeMM, frontRect, turnComposition, overlayEditor)
  //     changed()     redraw and save after the photo changed
  //     grid?         photoGrid: pans on the grid card when one is on screen; Escape/[/] use it
  //     panTarget?(item)  canvas to pan on, when it is not the grid card (Collage: the selected sheet cell)
  //     escape?()     the page's own Escape; returns true when it handled the key (Collage: single view → sheet)
  //     guides?()     false while the stage is not on screen, so O is ignored (Collage sheet view)
  //   })
  const keys = (() => {
    const pages = new Map();
    // Direction vectors for the arrow keys (x right, y down).
    const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const anyField = e => e.target.closest?.('input, textarea, select, [contenteditable]');
    // Range and checkbox inputs keep the photo keys; other inputs and text areas keep their own.
    const typing = e => e.target.matches?.('textarea, input:not([type=range]):not([type=checkbox])');
    const current = () => [...pages.values()].find(p => p.active());

    // Overlay keys run first (capture) and stop the photo keys below.
    document.addEventListener('keydown', e => {
      if (e.metaKey || e.ctrlKey || anyField(e)) return;
      const page = current(), item = page?.item();
      const editor = page?.stage.overlayEditor, o = editor?.selected();
      // In grid view there is no single stage to edit overlays on.
      if (!o || page.grid?.cardCanvas(item)) return;
      const dir = ARROWS[e.key];
      if (dir) {
        // Overlay arrows move 1 mm (Alt: 0.2 mm); o.x/o.y are fractions, so divide by the output size.
        const mm = PhotoEditor.outMM(item), step = e.altKey ? .2 : 1;
        o.x = Math.max(0, Math.min(1, o.x + dir[0] * step / mm.w));
        o.y = Math.max(0, Math.min(1, o.y + dir[1] * step / mm.h));
      } else if (['+', '=', '-', '_'].includes(e.key)) o.size = Math.max(3, Math.min(80, o.size * (e.key === '+' || e.key === '=' ? 1.1 : .9)));
      else if (e.key === 'Delete' || e.key === 'Backspace') { item.overlays = item.overlays.filter(x => x !== o); editor.select(null); }
      else if (e.key === 'Escape') editor.select(null);
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
      if (e.key !== 'Escape') editor.changed();
    }, true);

    document.addEventListener('keydown', e => {
      const page = current(); if (!page) return;
      if (e.key === 'Escape' && page.escape) { if (page.escape()) e.preventDefault(); return; }
      const dir = ARROWS[e.key];
      const zoom = { '+': 1, '=': 1, '-': -1, '_': -1 }[e.key];
      if (dir || zoom) {
        if (e.metaKey || e.ctrlKey || typing(e)) return;
        const item = page.item();
        if (!item) return;
        if (zoom) {
          if (!PhotoEditor.canZoom(item)) return;
          e.preventDefault();
          item.zoom = PhotoEditor.clampZoom(item, item.zoom * (e.altKey ? 1.02 : 1.1) ** zoom);
        } else {
          const step = e.altKey ? .1 : .5;
          if (e.shiftKey) {
            if (!dir[0]) return;
            item.tilt = PhotoEditor.clampTilt(item.tilt + dir[0] * step);
          } else {
            // Pan on what the user sees (the grid card or sheet cell), else on the stage; cssPerMM turns the mm step into CSS pixels.
            const stage = page.stage, target = page.panTarget?.(item) || page.grid?.cardCanvas(item) || stage.canvas;
            const cssPerMM = target.getBoundingClientRect().width / stage.sizeMM(item).w;
            PhotoEditor.pan(item, target, stage.frontRect, dir[0] * step * cssPerMM, dir[1] * step * cssPerMM);
          }
          e.preventDefault();
        }
        item.auto = ''; item.smartPending = false;
        page.changed();
        return;
      }
      if (e.key.toLowerCase() === 'o') {
        if (e.metaKey || e.ctrlKey || e.altKey || anyField(e)) return;
        if (page.stage.composition && (page.guides?.() ?? true)) { e.preventDefault(); page.stage.turnComposition(); }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches?.('input[type=text], input[type=number], textarea, [contenteditable]')) return;
      const grid = page.grid; if (!grid) return;
      if (e.key === 'Escape') grid.choose('grid');
      else if (e.key === ']' || e.key === 'PageDown') grid.step(1);
      else if (e.key === '[' || e.key === 'PageUp') grid.step(-1);
      else return;
      e.preventDefault();
    });

    return { register: (name, page) => pages.set(name, page) };
  })();

  return {
    mount, dropZone, stage, orientSeg, fillModeSeg, blurControls, adjustRow, guideChecks, saveActions,
    wireAdjust, syncAdjust, wireGuides, wireSave, renderQueue, photoGrid, photoCanvas, paintCached, stepBar, neighbour, tabs, keys,
  };
})();
