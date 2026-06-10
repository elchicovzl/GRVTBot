#!/usr/bin/env bash
# G.3 — Automated SQLite backup (WAL-safe).
#
# Uses sqlite3's online backup API (`.backup`) which takes an atomic,
# consistent snapshot even while the bot is writing. NEVER raw-cp the
# db/-wal/-shm trio of a live database — a copy taken mid-write is torn
# and can be unrecoverable. This script refuses to run without the
# sqlite3 CLI for exactly that reason.
#
# Layout:    $BACKUP_DIR/<UTC timestamp>/grid_bot.db.gz
# Retention: timestamped dirs older than $BACKUP_RETAIN_DAYS days are
#            pruned (default 7). Legacy flat grid_bot_*.db* files from
#            the previous version of this script are pruned too.
#
# Env:
#   GRID_BOT_DB         source db   (default /opt/grvt-grid-bot/data/grid_bot.db)
#   BACKUP_DIR          destination (default /var/backups/grvt-grid-bot)
#   BACKUP_RETAIN_DAYS  retention   (default 7)
#
# Exit codes:
#   0  success
#   2  sqlite3 CLI not installed
#   3  source database not found
#   4  sqlite3 .backup failed
#   5  integrity check of the fresh copy failed
#
# Scheduling: scripts/systemd/grvt-backup.{service,timer} (preferred),
# or cron:    0 3 * * * /opt/grvt-grid/scripts/backup.sh
#
# ⚠️  The AES master key (MASTER_KEY_PATH, default /etc/grvt-grid/master.key)
#     is NOT in the database and is NOT backed up here. Without it the
#     encrypted GRVT credentials inside this backup are UNRECOVERABLE.
#     Back it up separately, off-host. See docs/BACKUPS.md.

set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/grvt-grid-bot}"
DB_PATH="${GRID_BOT_DB:-/opt/grvt-grid-bot/data/grid_bot.db}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-7}"

TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
DEST_DIR="${BACKUP_DIR}/${TIMESTAMP}"
BACKUP_FILE="${DEST_DIR}/grid_bot.db"

fail() { echo "[backup] ERROR: $1" >&2; exit "$2"; }

command -v sqlite3 &>/dev/null \
  || fail "sqlite3 CLI not found (apt install sqlite3). Refusing to raw-copy a live WAL database." 2
[[ -f "$DB_PATH" ]] \
  || fail "database not found at ${DB_PATH} (set GRID_BOT_DB)" 3

mkdir -p "$DEST_DIR"

# Online backup — atomic and WAL-safe even while the bot is trading.
sqlite3 "$DB_PATH" ".backup '${BACKUP_FILE}'" \
  || { rm -rf "$DEST_DIR"; fail "sqlite3 .backup failed for ${DB_PATH}" 4; }

# Verify the copy BEFORE trusting it (a backup you never tested is hope,
# not a backup).
CHECK=$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" | head -1)
[[ "$CHECK" == "ok" ]] \
  || { rm -rf "$DEST_DIR"; fail "integrity_check on fresh backup returned '${CHECK}'" 5; }

gzip -f "$BACKUP_FILE"

# ── Optional: GPG encryption ─────────────────────────────────────────
# Uncomment and set GPG_RECIPIENT to encrypt at rest (recommended when
# uploading off-host — the db contains users' encrypted credentials and
# full trade history).
#
# gpg --batch --yes --encrypt --recipient "${GPG_RECIPIENT}" "${BACKUP_FILE}.gz" \
#   && rm -f "${BACKUP_FILE}.gz"

# ── Optional: off-host upload (rclone / S3) ──────────────────────────
# A backup on the same disk dies with the disk. Pick one:
#
# rclone copy "$DEST_DIR" "remote:grvt-grid-backups/${TIMESTAMP}/"
# aws s3 cp "${BACKUP_FILE}.gz" "s3://YOUR-BUCKET/grvt-grid/${TIMESTAMP}/grid_bot.db.gz"

# ── Retention ────────────────────────────────────────────────────────
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETAIN_DAYS" -exec rm -rf {} + 2>/dev/null || true
# Legacy flat files from the pre-G.3 script layout:
find "$BACKUP_DIR" -maxdepth 1 -name "grid_bot_*.db*" -mtime +"$RETAIN_DAYS" -delete 2>/dev/null || true

SIZE=$(du -sh "${DEST_DIR}" 2>/dev/null | cut -f1 || echo '?')
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] backup ok: ${DEST_DIR} (${SIZE})"
