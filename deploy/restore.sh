#!/bin/bash
# Nexus ERP — restore a backup (latest, or pass a backups/ name)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA="${DATA_DIR:-$DIR/data}"
PICK="$1"
if [ -z "$PICK" ]; then
  PICK=$(ls "$DIR/backups" | sort | tail -1)
fi
[ -n "$PICK" ] || { echo "No backups found in $DIR/backups"; exit 1; }
echo "Restoring $PICK — the server must be stopped first."
if pgrep -f "node server.js" >/dev/null 2>&1; then echo "Stop the server (Ctrl+C) and re-run."; exit 1; fi
mkdir -p "$DATA"
case "$PICK" in
  *.tar.gz) tar -xzf "$DIR/backups/$PICK" -C /tmp/ && cp "/tmp/${PICK%.tar.gz}"/*.json "$DATA"/ && rm -rf "/tmp/${PICK%.tar.gz}" ;;
  *) cp "$DIR/backups/$PICK"/*.json "$DATA"/ ;;
esac
echo "Restored into $DATA — start the server again: node server.js"
