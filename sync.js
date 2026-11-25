'use strict';
/* sync.js — local-server adapter. When the app is served by server.js (the
   office machine), accounts, permissions and data live on that server:
   the server only sends each signed-in user the sections their role allows,
   and only accepts writes to those sections. When the app runs standalone
   (GitHub Pages or opened directly), Sync stays in local mode and nothing
   changes. */

const Sync = {
  mode: 'local',
  token: null,
  serverUser: null,
  needsSetup: false,
  _pushTimer: null,

  async api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers.Authorization = 'Bearer ' + this.token;
    const resp = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    if (resp.status === 401 && this.token) { this.token = null; sessionStorage.removeItem('nexus-erp-server-token'); }
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  },

  /* Probe for server.js on the same origin. Runs before everything else. */
  async init() {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 2000);
      const resp = await fetch('/api/ping', { signal: ctrl.signal });
      clearTimeout(to);
      if (!resp.ok) return;
      const j = await resp.json();
      if (!j || !j.server) return;
      this.mode = 'server';
      this.needsSetup = !!j.needsSetup;
      this.token = sessionStorage.getItem('nexus-erp-server-token');
      if (this.token) {
        const me = await this.api('GET', '/api/me');
        if (me.ok) this.serverUser = me.data.user;
      }
      this.patchAuth();
    } catch (e) { /* no server here: local mode */ }
  },

  async pullData() {
    const r = await this.api('GET', '/api/data');
    if (r.ok && r.data && r.data.data) {
      /* Merge: keep any local collections the server did not send (not
         permitted) out of the working copy by replacing wholesale — the
         server's filtered view IS this user's whole world in server mode. */
      const d = r.data.data;
      for (const key of Object.keys(emptyData())) if (!d[key]) d[key] = emptyData()[key];
      localStorage.setItem(DB_KEY, JSON.stringify(d));
      return true;
    }
    return false;
  },

  push() {
    clearTimeout(this._pushTimer);
    this._pushTimer = setTimeout(async () => {
      try { await this.api('PUT', '/api/data', { data: store.data }); }
      catch (e) { console.error('Sync push failed', e); }
    }, 400);
  },

  /* Immediate push for actions that must reach the server now. */
  async pushNow() {
    clearTimeout(this._pushTimer);
    try { await this.api('PUT', '/api/data', { data: store.data }); } catch (e) { /* offline tolerance */ }
  },

  async sendMessage(name, subject, body) {
    return this.api('POST', '/api/messages', { name, body: '[' + subject + '] ' + body });
  },

  /* In server mode the server owns accounts: swap the local implementations
     for API-backed ones. */
  patchAuth() {
    const S = this;

    Auth.load = function () { this.users = []; this.needsSetup = S.needsSetup; };
    Auth.persist = function () { /* server owns the user list */ };
    Auth.sessionUser = function () { return S.serverUser; };

    Auth.login = async function (username, password) {
      const r = await S.api('POST', '/api/login', { username, password });
      if (!r.ok) return false;
      S.token = r.data.token;
      sessionStorage.setItem('nexus-erp-server-token', S.token);
      S.serverUser = r.data.user;
      this.current = r.data.user;
      await S.pullData();
      store.load();
      return true;
    };

    Auth.logout = function () {
      S.api('POST', '/api/logout');
      S.token = null; S.serverUser = null;
      sessionStorage.removeItem('nexus-erp-server-token');
      this.current = null;
      location.reload();
    };

    /* First-run admin setup against the server. */
    Auth.serverSetup = async function (username, password) {
      const r = await S.api('POST', '/api/setup', { username, password });
      if (!r.ok) return false;
      S.token = r.data.token;
      sessionStorage.setItem('nexus-erp-server-token', S.token);
      S.serverUser = r.data.user;
      this.current = r.data.user;
      S.needsSetup = false;
      return true;
    };

    /* Password changes go to the server (self or admin reset). */
    Auth.setPassword = async function (user, newPassword) {
      const r = await S.api('PATCH', '/api/users', { id: user.id, newPassword });
      if (r.ok && this.current && user.id === this.current.id) this.current.mustChange = false;
      return r.ok;
    };

    /* The old-password check in the change dialog uses the server too. */
    Auth.verifyPassword = async function (username, password) {
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }) });
      return r.ok;
    };
  },
};

window.Sync = Sync;
