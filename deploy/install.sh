#!/bin/bash
# Nexus ERP — install on Linux/macOS (free: needs only Node.js 18+)
set -e
TARGET="${1:-$HOME/nexus-erp}"
SRC="$(cd "$(dirname "$0")/.." && pwd)"

command -v node >/dev/null || { echo "Node.js 18+ is required first: https://nodejs.org (free LTS)"; exit 1; }
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 18 ] || { echo "Node.js 18+ required, found $(node -v)"; exit 1; }

mkdir -p "$TARGET"
# app files only — never an existing data dir
for f in "$SRC"/*.js "$SRC"/index.html "$SRC"/styles.css "$SRC"/BACKEND.md "$SRC"/README.md; do
  cp "$f" "$TARGET"/
done
mkdir -p "$TARGET/vendor" "$TARGET/data" "$TARGET/backups"
cp "$SRC"/vendor/jszip.min.js "$TARGET/vendor/" 2>/dev/null || true
cp "$SRC"/deploy/*.sh "$TARGET"/ 2>/dev/null || true
chmod +x "$TARGET"/*.sh 2>/dev/null || true

echo "Installed to $TARGET"
echo "Start:   cd \"$TARGET\" && node server.js     # then open http://localhost:8080"
echo "First run: create the admin user in the browser, then log in."
