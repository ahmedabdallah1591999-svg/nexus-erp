# Backend — Local Server (نظام أحمد عبدالله بيزنس ديفيلوبمنت)

The owner decided: **no paid services, no cloud accounts, no Google Drive
connection.** Exports download directly to the device each person works on.
So the backend is a small server that runs on **one machine in the office** —
free, no subscriptions, no accounts anywhere.

## What the local server gives you

| | Browser-only (GitHub Pages) | With `server.js` |
|---|---|---|
| Accounts | Stored in each browser | Stored on the server, scrypt-hashed |
| Data | Each device has its own copy | One shared database for the whole team |
| Permissions | Hiding in the app | **Enforced by the server**: each person only *receives* the sections their role allows |
| Excel export | Everything in that browser | Only the sections that person may see — by design |
| Contact-us messages | Stay in the sender's browser | Reach the admin's inbox on **any** device |

## Requirements

1. One computer that stays on during work hours (the admin's own PC works).
2. Node.js 18 or newer — free from <https://nodejs.org>. No npm install, no
   packages, no internet needed after that.
3. All devices on the same office network (Wi-Fi/LAN).

## Run

```bash
node server.js
```

Then:

- On that machine: open <http://localhost:8080>
- On every other device: open `http://<that-machine's-IP>:8080`
  (the server prints the address form when it starts)

First run: create the admin account from the setup screen. Then the admin
creates employee accounts from the 🔑 Users screen and picks each person's
allowed sections. Passwords are set by the admin and changed by each user on
first login; the server stores only salted scrypt hashes.

## How it works

- `server.js` serves the app itself **and** a small JSON API, so there is no
  HTTPS/certificate setup and nothing extra to host.
- Data lives in `data/store.json` next to `server.js` (atomic writes).
  Sessions in `data/sessions.json`. Neither folder is served over HTTP.
- The front end (`sync.js`) auto-detects the server: served by `server.js` →
  shared mode; opened from GitHub Pages → original single-device mode, nothing
  changes.
- The server filters every read and every write by the user's sections, so a
  restricted employee's browser never holds finance/employee data — and their
  Excel export can't contain it.
- Contact-us messages go straight to the server inbox (`POST /api/messages`);
  only the admin reads them.

## API summary

`GET /api/ping` · `POST /api/setup` (first admin only) · `POST /api/login` ·
`POST /api/logout` · `GET /api/me` · `GET /api/data` (permission-filtered) ·
`PUT /api/data` (per-section enforcement) · `POST /api/messages` (any user) ·
`GET|POST|PATCH|DELETE /api/users` (admin)

## Honest limits

- **Backups are your job**: copy `data/store.json` somewhere safe regularly
  (a USB stick or another computer). One file, once a day, is enough.
- **One server = one database**: if that machine is off, the team works
  offline and their changes sync when it is back (last write wins per record).
- **Office network only**: the server is HTTP without TLS, fine inside a
  trusted office LAN. Do not expose it to the internet as-is.
- Two people editing the *same record at the same moment*: the later save
  wins. Different records never conflict.
- The old Supabase plan (`schema.sql`) stays in the repo only as a reference;
  it was **not** chosen (no cloud accounts per the owner's decision).

## Cost

Node.js: free. Hosting: the office machine you already have. Total: **$0**,
no payment method anywhere.
