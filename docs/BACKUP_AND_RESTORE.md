# Database Backup & Restore Guide (SQLite WAL Mode)

Outreach Engine stores **all persistent application state**—including user settings, Outlook accounts, encrypted OAuth tokens, leads, campaigns, sending jobs, email events, suppression lists, audit logs, and encrypted WhatsApp session credentials—inside a single SQLite database on the persistent disk (`DATABASE_PATH`, production default: `/var/data/outreach-engine.db`).

## 1. Downloading a Live WAL-Safe Backup (Recommended)

Because SQLite runs in **Write-Ahead Logging (`WAL`)** mode, copying `.db` directly with `cp` while the server is running can miss uncommitted pages in `-wal` / `-shm`.

Outreach Engine includes a built-in atomic online backup endpoint:
1. Open **Settings** in the web dashboard.
2. Under **SQLite Database Backup**, click **Download SQLite Backup (.db)**.
3. The backend executes `better-sqlite3`'s online `sqlite.backup()` API and streams a consistent snapshot `.db` file without stopping background workers.

## 2. CLI Backup via Render Shell

If you open a Render Shell on the web service, create a safe snapshot with SQLite's `.backup` command (or Node):

```bash
node -e "const Database=require('better-sqlite3'); const db=new Database('/var/data/outreach-engine.db'); db.backup('/var/data/backup-' + Date.now() + '.db').then(()=>console.log('Backup complete'))"
```

## 3. Restoring from a Backup

1. Put the engine in **Global Pause** (or suspend the Render service temporarily so no worker writes during file replacement).
2. Remove stale `-wal` and `-shm` files alongside the active DB before replacing:
   ```bash
   rm -f /var/data/outreach-engine.db-wal /var/data/outreach-engine.db-shm
   cp /path/to/your-backup.db /var/data/outreach-engine.db
   ```
3. Ensure `ENCRYPTION_KEY` matches the key that was active when the backup was created (otherwise encrypted OAuth tokens and WhatsApp session entries cannot be decrypted).
4. Restart the service (`npm run start` runs `prisma migrate deploy` automatically if the backup was from an earlier migration).
