# 4flieks — how the whole thing works

DiscovrTV (Pty) Ltd · Reg 2021/818115/07 · VAT 4620301954
Last updated 26 August 2026

---

## What it is, in one paragraph

South African filmmakers release films directly to viewers. Every cast and crew
member gets their own tracked link, so a sale can be traced to the person who
brought the buyer. Filmmakers keep 70% of net revenue and their copyright, and
the arrangement is non-exclusive. Viewers rent for 48 hours, buy permanently,
or buy it for someone else.

The thing no other platform does is the attribution. Actors have always been
the marketing; nobody could ever measure what they delivered, so it never
counted as distribution and nobody was paid for it.

---

## Every page on the platform

### For viewers

| Link | What it is |
|---|---|
| `4flieks.com` | The catalogue |
| `4flieks.com/<film-slug>` | A film — e.g. `/metamorph`, `/wormwood` |
| `4flieks.com/<film-slug>?a=<cast-slug>` | The same film, credited to a cast member |
| `4flieks.com/terms` | Terms, refund policy, privacy notice |
| `4flieks.com/refunds` | Jumps to the refund section |
| `4flieks.com/privacy` | Jumps to the privacy section |

### For cast and crew

| Link | What it is |
|---|---|
| `4flieks.com/me/<film-slug>/<cast-slug>` | Their own page: link, QR code, their numbers, what they earn |

No sign-in. The link they were given is the key.

### For filmmakers

| Link | What it is |
|---|---|
| `4flieks.com/filmmaker` | The portal — upload, cast, pricing, earnings |
| `4flieks.com/report/<key>` | A shareable release report for funders and festivals |

### For you

| Link | What it is |
|---|---|
| `4flieks.com/admin` | Films, review queue, users, payouts, filmmaker updates |
| `4flieks.com/attribution` | Attribution across every film |
| `4flieks.com/cast` | Generate cast links |

---

## How a film gets released

```
  Filmmaker uploads          You review            Bunny transcodes
  film · poster · trailer →  approve · go live  →  adaptive streaming
                                                          ↓
  Filmmaker adds cast   →   each gets a link    →   they post it
  sets prices               and a QR code            to their own audience
  sets what cast earn
                                                          ↓
  Viewer opens the link  →  watches the trailer  →  pays
       (click recorded)       (play recorded)       (sale attributed)
                                                          ↓
  Yoco takes payment  →  webhook grants access  →  they watch
                                                          ↓
  Filmmaker sees the numbers  →  requests a payout  →  you pay by EFT
```

---

## What a viewer can buy

| | Price | What they get |
|---|---|---|
| **Rental** | R25 incl. VAT | 48 hours of unlimited viewing, **starting at first play** — not at purchase |
| **Own** | R49 incl. VAT | Permanent streaming access |
| **Gift** | R49 incl. VAT | A one-time `FL-XXXXXX` code for someone else |

Prices are VAT-inclusive; the VAT portion is extracted from the total, never
added to it. The 70/30 split applies to the ex-VAT amount.

Streaming only. No downloads.

---

## Where the money goes

On a R49 purchase:

```
  R49.00   what the viewer pays
 −R 6.39   VAT (15%), extracted from the total
  ───────
  R42.61   net
   R29.83  filmmaker (70%)
   R12.78  platform (30%)
```

The filmmaker then pays their cast whatever they stated in the portal —
typically 15–20% of what that person brought in. **You measure it; you do not
pay it.** That keeps you out of a dispute between a filmmaker and their actors.

---

## The pieces it runs on

| | What it does |
|---|---|
| **Netlify** | Hosting, serverless functions, the edge function for link previews |
| **Firebase Realtime Database** | Films, users, purchases, transactions, cast, reviews |
| **Firebase Auth** | Sign-in |
| **Firebase Storage** | Film masters, posters, cast photos |
| **Bunny Stream** | Adaptive streaming — the thing that keeps playback alive on poor mobile data |
| **Yoco** | Payments |
| **xneelo** | Mail for `@4flieks.com` |

### The serverless functions

| Function | What it does |
|---|---|
| `flieks-checkout` | Creates a Yoco checkout. Prices read from the database, never from the browser |
| `yoco-webhook` | Payment lands: grants access, mints gift codes, records attribution |
| `flieks-order` | What happened with this transaction — works without a session |
| `flieks-play` | Verifies the purchase, starts the rental clock, returns the streaming URL |
| `flieks-redeem` | Gift code redemption |
| `flieks-review` | Ratings and comments, buyers only |
| `flieks-cast-stats` | A cast member's own figures, and their QR code |
| `flieks-results` | A film's performance, for the report |
| `flieks-payout` | Earnings statement, payout requests, settlement |
| `flieks-bunny` | Hands a film to Bunny, reports transcode progress |
| `flieks-bunny-upload-background` | The actual file transfer — 15-minute limit |
| `og` *(edge)* | Rewrites link previews per film |

---

## Decisions that would be easy to undo by accident

**Rental clocks start on first play.** `expires_at` stays null until someone
presses play. Buying at 9am to watch that evening should not cost half the
rental.

**Video URLs live in `flieks_private`.** `flieks_films` is publicly readable so
the catalogue works signed out — a playable URL in there is a URL anyone can
take.

**Hidden review comments still count toward the star average.** A filmmaker can
remove abusive text but cannot bury one-star ratings. If they could, the rating
would be worthless and viewers would work that out.

**Earnings are calculated, never stored as a running total.** A derived balance
cannot drift. Each payout records the exact transaction ids it covers, so the
same sale can never be paid twice.

**Test-mode payments are excluded from everything** — stats, earnings, reports.

**Firebase's SDK serves stale data.** It has caused three separate bugs here: a
partial user list, a partial film list, a partial cast list. Anywhere a count
or a total matters, read over REST with a force-refreshed token. `admin.html`
has a `readNode()` helper that does this.

---

## Where the data sits

| Node | What's in it | Who can read it |
|---|---|---|
| `flieks_films` | The catalogue | Everyone — needed signed out |
| `flieks_private` | Video URLs, Bunny ids | Server only |
| `flieks_users` | Profiles and roles | Signed in |
| `flieks_purchases` | Who owns what | Signed in |
| `flieks_transactions` | Every payment | Signed in |
| `flieks_cast` | Cast and crew per film | Everyone |
| `flieks_stats` | Clicks, plays, sales per cast member | Admin |
| `flieks_reviews` | Ratings and comments | Everyone |
| `flieks_gifts` | Gift codes | Server only |
| `flieks_my_gifts` | A buyer's own codes | That buyer |
| `flieks_payouts` | Payout requests | That filmmaker |
| `flieks_bank` | Banking details | **Server only** |
| `flieks_moderation` | Hidden comments, for oversight | Admin |
| `flieks_result_keys` | Report link → film | Server only |

---

## Environment variables

Netlify holds these. They are in no file.

```
YOCO_SECRET_KEY          sk_live_… in production
YOCO_WEBHOOK_SECRET      differs between test and live
FIREBASE_DB_URL
FIREBASE_DB_SECRET
FIREBASE_API_KEY
BUNNY_LIBRARY_ID
BUNNY_API_KEY
BUNNY_CDN_HOSTNAME       vz-…b-cdn.net, no https://
SETUP_PASSWORD           guards one-off setup functions
PAYOUT_MINIMUM           defaults to 250
```

`BUNNY_TOKEN_KEY` is deliberately absent. Bunny's CDN token authentication
signs per file and cannot cover HLS segments, so the library uses referrer
protection instead — allowed referrers set to `*.4flieks.com`.

---

## Running it week to week

**When a filmmaker applies** — they appear in admin. Approve, then send them
the distribution agreement and the summary. Get it signed before the film goes
live.

**When a film is uploaded** — review it, set it live, then press **Prepare for
streaming** so Bunny transcodes it. Playback falls back to Firebase until it is
ready, so nothing breaks midway.

**Before cast links go out** — check the film has a link preview image. That
picture is what sells the film in every WhatsApp message, and a cropped
portrait poster undersells it.

**Every few weeks** — admin → Films → **Update** on each film. It writes the
message with real numbers in it. Read it before you send; a cheerful note about
a film nobody bought does more harm than silence.

**When a payout is requested** — admin → Payouts. Bank details are there with a
copy button. Pay by EFT, then mark it settled so those sales cannot be paid
again.

---

## Known gaps

**No refund path.** Refunding in Yoco does not revoke access, and if the
filmmaker has already been paid their share, nothing claws it back. Fine at
this volume. A real problem at a hundred sales a month.

**No way to reach past buyers.** Someone who bought Metamorph has no way to
learn Wormwood exists. This is the most valuable thing still missing — it is
what makes the tenth film launch to an audience rather than from zero.

**No moderation queue in admin.** Hidden comments collect in
`flieks_moderation` but nothing displays them. Worth building before volume,
so a filmmaker hiding every criticism is something you notice.

**Cast payments are manual and outside the platform.** Deliberate for now.

---

## In an emergency

**Payments failing** — Netlify → Logs → Functions → `yoco-webhook`. You want
`payment.succeeded` followed by `Access granted`. `webhook signature rejected`
means `YOCO_WEBHOOK_SECRET` is wrong or the site has not been redeployed since
it was set.

**A film will not play** — Logs → `flieks-play`. It logs the URL it served.
A 403 from Bunny usually means the referrer settings changed.

**Numbers look wrong in admin** — suspect the Firebase SDK cache first, not
your arithmetic. It has been the cause three times.

**Someone paid and got nothing** — find the transaction in
`flieks_transactions`, check `status`. If the webhook never landed, you can
write the purchase record by hand in `flieks_purchases/{uid}/{filmId}`.
