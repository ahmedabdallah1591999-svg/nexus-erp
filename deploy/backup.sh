#!/bin/bash
# Nexus ERP — backup the data directory (store + sessions)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="${DATA_DIR:-$DIR/data}"
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$DIR/backups/$STAMP"
# Backups hold the full database including scrypt password hashes: keep the
# backups directory private to this user account.
chmod 700 "$DIR/backups" 2>/dev/null || true
umask 077
mkdir -p "$DEST"
cp "$DATA"/store.json "$DEST"/ 2>/dev/null || true
cp "$DATA"/sessions.json "$DEST"/ 2>/dev/null || true
if command -v tar >/dev/null; then
  tar -czf "$DIR/backups/$STAMP.tar.gz" -C "$DIR/backups" "$STAMP" && rm -rf "$DEST"
  chmod 600 "$DIR/backups/$STAMP.tar.gz" 2>/dev/null || true
  echo "Backup: $DIR/backups/$STAMP.tar.gz (keep private: contains all data and password hashes)"
else
  echo "Backup: $DEST"
fi
