#!/usr/bin/env bash
# Dump the MangoGPT database to ~/backups/mangogpt-db/ (custom format, mode 600). Keeps the newest 14.
# Restore with: pg_restore -h 127.0.0.1 -U mangogpt -d mangogpt --clean --if-exists <file>
set -euo pipefail
source "$HOME/.local/pg16/env.sh"
ENV_FILE="$(dirname "$0")/../.env"
URL="$(grep '^DATABASE_URL=' "$ENV_FILE" | cut -d= -f2-)"
PASS="$(echo "$URL" | sed -E 's#^[^:]+://[^:]+:([^@]+)@.*#\1#')"
OUT="$HOME/backups/mangogpt-db"; mkdir -p "$OUT"; chmod 700 "$OUT"
FILE="$OUT/mangogpt-$(date +%Y%m%d-%H%M%S).dump"
PGPASSWORD="$PASS" pg_dump -h 127.0.0.1 -U mangogpt -d mangogpt -Fc -f "$FILE"
chmod 600 "$FILE"
ls -1t "$OUT"/mangogpt-*.dump | tail -n +15 | while read -r old; do rm -f -- "$old"; done
echo "$FILE ($(du -h "$FILE" | cut -f1))"
