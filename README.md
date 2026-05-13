# 4FLIEKS

Short film distribution platform for South Africa.

## Deploy

This project deploys to Netlify from GitHub. Push to `main` → auto-deploys.

## Required Environment Variables

Set these in **Netlify → Site configuration → Environment variables**:

| Variable | Where to find it |
|---|---|
| `PAYFAST_MERCHANT_ID` | PayFast dashboard → Integration → Merchant Details |
| `PAYFAST_MERCHANT_KEY` | PayFast dashboard → Integration → Merchant Details |
| `PAYFAST_PASSPHRASE` | PayFast dashboard → Integration → Merchant Details (if set) |
| `PAYFAST_SANDBOX` | `true` for testing, `false` for live |
| `FIREBASE_DB_URL` | `https://flieks-app-default-rtdb.firebaseio.com` |
| `FIREBASE_DB_SECRET` | Firebase Console → Project Settings → Service accounts → Database secrets |

## PayFast ITN URL

Set in PayFast dashboard → Integration:
- **Sandbox:** `https://flieks-app.netlify.app/.netlify/functions/payfast-itn`
- **Live:** `https://4flieks.com/.netlify/functions/payfast-itn`

## Project Structure

```
/
├── index.html          # Main viewer app
├── filmmaker.html      # Filmmaker portal
├── admin.html          # Admin panel
├── brand/              # Logo & favicon assets
├── netlify.toml        # Netlify config
└── netlify/
    └── functions/
        └── payfast-itn.js   # PayFast webhook → unlocks films
```
