'use strict';
/* boot.js — startup: load data, sign in, bind chrome, apply language, show first view. */

(async () => {
  await Sync.init();
  if (Sync.mode === 'server' && Sync.serverUser) await Sync.pullData();

  store.load();
  bindModal();
  bindNav();
  bindSearch();
  bindQuickAdd();
  bindExportImport();
  bindExport();
  initI18n();

  Auth.init(() => {
    const target = location.hash.slice(1);
    switchView(App.views[target] && Auth.can(target) ? target : Auth.firstAllowed());
  });
})();
