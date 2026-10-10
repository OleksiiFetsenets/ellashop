'use strict';
// Server capabilities (/api/config): which optional features are installed (face detection, offline
// background removal). Pages read AppConfig.data and subscribe with onChange; nobody writes into a page.
// Loads before the pages; adding photos waits for AppConfig.ready.

const AppConfig = (() => {
  const listeners = [];
  let loaded = false;
  const self = {
    data: {},
    // Subscribe to (re)loads: fn(newData, previousData). Runs at once if the config has already arrived.
    onChange(fn) { listeners.push(fn); if (loaded) fn(self.data, {}); },
    async refresh() {
      const cfg = await (await fetch('/api/config')).json(), previous = self.data;
      self.data = cfg; loaded = true;
      listeners.forEach(fn => fn(cfg, previous));
    },
  };
  // Resolves when the configuration has loaded.
  self.ready = self.refresh();
  return self;
})();
