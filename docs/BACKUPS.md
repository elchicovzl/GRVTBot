# Backups & restore

## What gets backed up

`scripts/backup.sh` takes a **WAL-safe** snapshot of the SQLite database
using sqlite3's online backup API (`.backup`). That single file contains
everything the bot knows:

- users, password hashes, **encrypted** GRVT credentials
- bots, grid levels, orders, trades, fills, paired roundtrips
- funding history, daily snapshots, alert history

Backups land in timestamped directories:

```
/var/backups/grvt-grid-bot/
└── 20260609_030000/
    └── grid_bot.db.gz
```

> **Why not `cp`?** The database runs in WAL mode. Copying the
> `grid_bot.db` / `-wal` / `-shm` trio while the bot is writing produces
> a torn, potentially unrecoverable copy. `sqlite3 <db> ".backup ..."`
> takes a consistent snapshot while the bot keeps trading. The script
> exits with code 2 instead of falling back to `cp` when the sqlite3 CLI
> is missing — on purpose.

The script also runs `PRAGMA integrity_check` on the fresh copy and
deletes it (exit 5) if the check fails, so a corrupt backup never
silently replaces your safety net.

## ⚠️ The master key is NOT in the backup

GRVT credentials in the database are AES-256-GCM encrypted with a master
key stored at `MASTER_KEY_PATH` (default `/etc/grvt-grid/master.key`) —
**outside** the database, deliberately.

**Without `master.key`, every credential in your backups is permanently
unreadable.** Users would have to re-paste their GRVT API keys after a
restore. Back the key up **separately and off-host** (password manager,
encrypted vault — NOT next to the database backups, since key + db
together decrypt everything):

```bash
# one-time, e.g. into a password manager entry
sudo base64 /etc/grvt-grid/master.key
```

## Setup

### systemd (preferred)

```bash
sudo cp scripts/systemd/grvt-backup.{service,timer} /etc/systemd/system/
# edit /etc/systemd/system/grvt-backup.service if your paths differ
sudo systemctl daemon-reload
sudo systemctl enable --now grvt-backup.timer

# verify
systemctl list-timers grvt-backup.timer
sudo systemctl start grvt-backup.service && journalctl -u grvt-backup -n 5
```

### cron (alternative)

```cron
0 3 * * * GRID_BOT_DB=/opt/grvt-grid/data/grid_bot.db /opt/grvt-grid/scripts/backup.sh >> /var/log/grvt-backup.log 2>&1
```

### Configuration

| Env var | Default | Meaning |
|---|---|---|
| `GRID_BOT_DB` | `/opt/grvt-grid-bot/data/grid_bot.db` | source database |
| `BACKUP_DIR` | `/var/backups/grvt-grid-bot` | destination root |
| `BACKUP_RETAIN_DAYS` | `7` | days of timestamped dirs to keep |

Optional gpg encryption and rclone/S3 off-host upload hooks are included
in the script as commented stubs — uncomment and configure. A backup on
the same disk dies with the disk; ship it off-host.

| Exit code | Meaning |
|---|---|
| 0 | success |
| 2 | sqlite3 CLI not installed |
| 3 | source database not found |
| 4 | `.backup` command failed |
| 5 | integrity check of the fresh copy failed |

## Restore

1. Stop the bot (orders on GRVT are preserved — the SIGTERM handler does
   not cancel them):

   ```bash
   docker compose stop bot      # or: systemctl stop grvt-grid
   ```

2. Restore the database (move the corrupt one aside first — never delete):

   ```bash
   cd /opt/grvt-grid/data
   mv grid_bot.db grid_bot.db.broken; rm -f grid_bot.db-wal grid_bot.db-shm
   gunzip -c /var/backups/grvt-grid-bot/20260609_030000/grid_bot.db.gz > grid_bot.db
   sqlite3 grid_bot.db "PRAGMA integrity_check;"   # must print: ok
   ```

3. Make sure `master.key` is in place at `MASTER_KEY_PATH` with the
   exact bytes from your off-host copy (`base64 -d` if you stored it
   encoded). Wrong/missing key → credentials undecryptable.

4. Start the bot and reconcile:

   ```bash
   docker compose start bot
   ```

   The bot replays migrations on boot. Because the backup is up to ~24h
   old, fills that happened after the snapshot are backfilled by the
   fill-archive poller, but **verify each bot's position vs GRVT** in
   the dashboard before resuming paused bots.

## Related: WAL health

The server runs a WAL checkpoint guard (env `GRVT_WAL_CHECKPOINT_MB`,
default 100): when `grid_bot.db-wal` exceeds the threshold it forces
`PRAGMA wal_checkpoint(RESTART)` and logs the result. The current WAL
size is exported as `grvt_sqlite_wal_size_bytes` on `GET /api/v2/metrics`
— alert on sustained growth.
