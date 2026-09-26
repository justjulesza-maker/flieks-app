# Backups and restoring 4flieks

## What is backed up, and where

| What | How | Where it lives |
|---|---|---|
| The database (films, accounts, purchases, payouts, reviews, Lab reports, podcasts, everything in Realtime Database) | Automatic, every night at 02:30, kept 35 days (never fewer than the 7 newest). "Back up now" in the control centre any time. | Netlify Blobs store `flieks-backups`. Download from **Admin → Films → 💾 Backups**. |
| The code, rules and settings files | Every change is a git commit. | GitHub, plus any `git bundle` copy you keep. |
| Film, trailer and poster files | Not in the database backup (too big). | Firebase Storage bucket, and the streaming copies on Bunny. |
| Environment variables (API keys, secrets) | Not stored anywhere by 4flieks. | Netlify site settings. Keep your own private copy (see below). |

A failed nightly backup sends an alert (WhatsApp, or email) and shows in red on the Backups screen. The last good backup stays.

## Keep an off-site copy

Once a week, download the latest backup from the Backups screen and keep it somewhere that isn't Netlify or Firebase (an encrypted drive, or a private folder in Google Drive). It holds every account and purchase, so treat it like a password.

## Restoring the database

The download is one JSON file of the whole database.

- **Everything:** Firebase console → Realtime Database → ⋮ menu → **Import JSON** at the root. This replaces all data with the file.
- **One section only** (for example, films someone deleted by mistake): open the file, copy that section (for example `flieks_films`) into its own JSON file, click that node in the Firebase console and **Import JSON** there. Only that node is replaced.

Import replaces what is there, so download a fresh backup first, then restore.

## Film and poster files

To keep a copy of the files themselves, use the Google Cloud console for the `flieks-app` project: Cloud Storage → the bucket → select all → Download, or on a computer with the Google Cloud CLI:

    gcloud storage cp -r gs://<bucket-name> ./4flieks-files-backup

The streaming copies on Bunny are a second copy of every film sent there.

## Environment variables

On a computer with the Netlify CLI, logged in and linked to the site:

    netlify env:list --json > 4flieks-env-backup.json

Keep that file private and never commit it.
