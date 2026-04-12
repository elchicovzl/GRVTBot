# Connection Loss Behavior

What happens to your bot when the GRVT API becomes unreachable.

## Short outage (<5 minutes)

- **Open orders stay on GRVT.** The exchange holds them server-side — they don't depend on your bot being connected.
- **Monitor loop errors are caught.** Each 5s tick that fails to reach GRVT logs an error and retries next tick. The bot does NOT pause or cancel orders.
- **Fill detection pauses.** New fills won't be detected until connectivity returns. They are NOT lost — the next successful `getFillHistory` call picks up everything since the last poll.
- **Funding polling pauses.** Same — catches up on reconnect.
- **Dashboard shows stale data.** The health endpoint reports `status: degraded` (GRVT check fails, DB check passes).

## Extended outage (5+ minutes)

- **Same as above, but longer.** The bot keeps retrying every 5s indefinitely.
- **No automatic pause.** The bot does NOT self-pause during a GRVT outage. Your orders stay live on the exchange. This is intentional: pausing would cancel all orders, which is worse than waiting for reconnect.
- **Compound rebalance skips.** The hourly compound check fails silently and retries next hour.
- **Notifier degrades.** Telegram alerts may fail (separate from GRVT, but if the VPS itself is down, everything stops).

## What does NOT happen

- ❌ Orders are NOT cancelled during an outage.
- ❌ The bot does NOT close your position.
- ❌ No data is lost — fills, funding, and roundtrips catch up on reconnect.
- ❌ The safeguard (C.4) does NOT trigger on connection loss — it only triggers on price proximity to liquidation, which requires a successful ticker read.

## Process crash / restart

- **SIGTERM (systemd restart):** Graceful shutdown — drains in-flight tasks, preserves orders on GRVT, closes DB cleanly. Orders survive the restart.
- **SIGINT (Ctrl+C):** Cancels all orders, pauses bots, closes DB. Use only in development.
- **Kill -9 / OOM:** Ungraceful — orders stay on GRVT (they're server-side), but the DB may need WAL recovery on next start (SQLite handles this automatically).

## Recommendations

1. **Don't panic during outages.** Your orders are safe on GRVT.
2. **Check the health endpoint** (`/api/v2/health`) to see if it's a GRVT issue or a local issue.
3. **Set up the notifier** with Telegram — it will alert you on status changes and drawdown events.
4. **Enable automated backups** (`scripts/backup.sh` via cron) so a catastrophic DB loss doesn't mean total data loss.
