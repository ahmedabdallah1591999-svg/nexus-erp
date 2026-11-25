'use strict';
/* boot.js — startup: load data, sign in, bind chrome, apply language, show first view. */

(async () => {
  await Sync.init();
  if (Sync.mode === 'server' && Sync.serverUser) await Sync.pullData();

  store.load();
  /* browser-only mode has no server: say so at entry, on every screen including sign-in */
  if (Sync.mode !== 'server') {
    const bar = document.createElement('div');
    bar.id = 'localModeBanner';
    bar.setAttribute('role', 'alert');
    bar.setAttribute('data-i18n', 'Browser-only mode: data stays in this browser and nothing is enforced or protected here (no real accounts, permissions, locked accounting or corrections). For the protected mode run server.js.');
    bar.textContent = 'Browser-only mode: data stays in this browser and nothing is enforced or protected here (no real accounts, permissions, locked accounting or corrections). For the protected mode run server.js.';
    document.body.insertBefore(bar, document.body.firstChild);
  }
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
