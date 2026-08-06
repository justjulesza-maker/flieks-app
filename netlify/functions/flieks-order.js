/**
 * flieks-order — what happened with this transaction?
 *
 * Called when PayFast sends the buyer back. The transaction id is an
 * unguessable token created at checkout and carried in the return URL, so this
 * works even if the sign-in session didn't survive the round trip — which it
 * often doesn't on mobile browsers.
 *
 * Returns only what the buyer needs to see: whether it completed, and for a
 * gift, the code to pass on. No personal data, nothing about other orders.
 *
 * POST { txId } -> { status, type, filmId, filmTitle, filmSlug, code?, toName?, message? }
 */
const https = require('https');

const DB     = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET = process.env.FIREBASE_DB_SECRET;

function req(url) {
  return new Promise((res, rej) => {
    https.get(url, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res(d));
    }).on('error', rej);
  });
}
const dbGet = async p => JSON.parse((await req(`${DB}/${p}.json?auth=${SECRET}`)) || 'null');

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  try {
    const { txId } = JSON.parse(event.body || '{}');

    // Only ids we minted, and long enough not to be guessable by hand.
    if (!txId || !/^fl-(rent|own|gift)-[A-Za-z0-9]{4,10}-[a-z0-9]{6,}$/.test(txId)) {
      return reply(400, { message: 'Unknown order.' });
    }

    const tx = await dbGet(`flieks_transactions/${txId}`);
    if (!tx) return reply(404, { status: 'unknown' });

    if (tx.status !== 'complete') {
      // The webhook may simply not have landed yet.
      return reply(200, { status: tx.status || 'pending', type: tx.type || null });
    }

    const out = {
      status: 'complete',
      type: tx.type,
      filmId: tx.film_id,
      filmTitle: tx.film_title || '',
      toName: tx.gift_to || '',
      message: tx.gift_msg || ''
    };

    // A film's slug is public anyway; it makes the share link readable.
    if (tx.film_id) {
      const film = await dbGet(`flieks_films/${tx.film_id}`);
      out.filmSlug = (film && film.slug) || tx.film_id;
      if (!out.filmTitle) out.filmTitle = (film && film.title) || '';
    }

    if (tx.type === 'gift') {
      // Find the code minted for this transaction. Only the buyer has the txId.
      const gifts = await dbGet('flieks_gifts');
      if (gifts) {
        // Match on the transaction id the ITN stamped onto the gift. Older
        // records predate that, so fall back to buyer + film + timing.
        let found = Object.entries(gifts).find(([, g]) => g && g.txId === txId);
        if (!found) {
          found = Object.entries(gifts).find(([, g]) =>
            g && g.buyerUid === tx.uid && g.filmId === tx.film_id &&
            Math.abs((g.createdAt || 0) - (tx.completed_at || tx.created_at || 0)) < 5 * 60 * 1000
          );
        }
        if (found) {
          out.code = found[0];
          // The buyer's name, so the share message reads properly even when
          // the sign-in session didn't survive the trip to PayFast.
          out.buyerName = found[1].buyerName || '';
        }
      }
    }

    return reply(200, out);

  } catch (e) {
    console.error('order lookup failed:', e);
    return reply(500, { message: 'Could not look that up.' });
  }
};
