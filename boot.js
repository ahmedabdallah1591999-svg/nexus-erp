'use strict';
/* boot.js — startup: load data, sign in, bind chrome, apply language, show first view. */

store.load();
bindModal();
bindNav();
bindSearch();
bindQuickAdd();
bindExportImport();
bindExcelDrive();
initI18n();

Auth.init(() => {
  const target = location.hash.slice(1);
  switchView(App.views[target] && Auth.can(target) ? target : Auth.firstAllowed());
});
