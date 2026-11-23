'use strict';
/* boot.js — startup: load data, bind chrome, apply language, show first view. */

store.load();
bindModal();
bindNav();
bindSearch();
bindQuickAdd();
bindExportImport();
initI18n();
switchView(App.views[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard');
