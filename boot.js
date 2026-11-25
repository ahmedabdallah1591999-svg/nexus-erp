'use strict';
/* boot.js — startup: load data, sign in, bind chrome, apply language, show first view. */

(async () => {
  await Sync.init();
  if (Sync.mode === 'server' && Sync.serverUser) await Sync.pullData();

  /* snapshot before any upgrade migration mutates the books (kept once) */
  const preMigrationRaw = localStorage.getItem(DB_KEY);
  store.load();
  /* single-device preview: the server runs this migration itself in server
     mode; locally we align pre-upgrade data the same way */
  if (Sync.mode !== 'server' && typeof migrateInventoryValuation === 'function') {
    const posted = migrateInventoryValuation();
    if (posted) {
      if (preMigrationRaw && !localStorage.getItem(DB_KEY + ':premigration-backup')) {
        localStorage.setItem(DB_KEY + ':premigration-backup', preMigrationRaw);
      }
      store.save();
    }
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
