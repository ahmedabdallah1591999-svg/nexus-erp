#!/bin/bash
# Nexus ERP — backup the data directory (store + sessions)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="${DATA_DIR:-$DIR/data}"
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$DIR/backups/$STAMP"
mkdir -p "$DEST"
cp "$DATA"/store.json "$DEST"/ 2>/dev/null || true
cp "$DATA"/sessions.json "$DEST"/ 2>/dev/null || true
if command -v tar >/dev/null; then
  tar -czf "$DIR/backups/$STAMP.tar.gz" -C "$DIR/backups" "$STAMP" && rm -rf "$DEST"
  echo "Backup: $DIR/backups/$STAMP.tar.gz"
else
  echo "Backup: $DEST"
fi
