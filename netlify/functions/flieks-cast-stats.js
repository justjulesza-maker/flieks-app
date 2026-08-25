/**
 * flieks-cast-stats — what one cast member's link has brought in.
 *
 * No sign-in. The film slug and the person's slug are already in the link they
 * were given, so they are not secrets. What is withheld is everyone else's
 * figures and the film's totals — a cast member sees their own row, nothing more.
 *
 * POST { filmSlug, castSlug } -> { name, role, film, clicks, trailerPlays, sales, share }
 */
const https = require('https');

const DB     = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET = process.env.FIREBASE_DB_SECRET;

function get(path) {
  return new Promise(resolve => {
    https.get(`${DB}/${path}.json?auth=${SECRET}`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

/* The sentence the filmmaker chose, rendered for the person reading it. */
function shareText(castShare, priceOwn) {
  const type = (castShare && castShare.type) || 'none';
  const pct = { pct20: 20, pct15: 15, pct10: 10 }[type];

  if (pct) {
    const perSale = priceOwn ? ((priceOwn / 1.15) * (pct / 100)) : 0;
    return {
      headline: `${pct}% of every sale through your link`,
      detail: perSale
        ? `About R${perSale.toFixed(2)} each. Paid by the filmmaker, not by 4flieks.`
        : 'Paid by the filmmaker, not by 4flieks.',
      pct, perSale
    };
  }
  if (type === 'custom' && castShare.note) {
    return { headline: castShare.note, detail: 'Agreed with the filmmaker directly.', pct: 0, perSale: 0 };
  }
  return {
    headline: 'No revenue share on this film',
    detail: 'You still have your own link, and you can see exactly what it brings in.',
    pct: 0, perSale: 0
  };
}

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  try {
    const { filmSlug, castSlug } = JSON.parse(event.body || '{}');
    if (!filmSlug || !castSlug) return reply(400, { message: 'Missing details.' });

    const clean = s => String(s).replace(/[^a-z0-9-]/gi, '').slice(0, 80);
    const fSlug = clean(filmSlug), cSlug = clean(castSlug);

    const filmId = (await get(`flieks_film_slugs/${fSlug}`)) || fSlug;
    const film = await get(`flieks_films/${filmId}`);
    if (!film) return reply(404, { message: 'No such film.' });

    const person = await get(`flieks_cast/${filmId}/${cSlug}`);
    if (!person) return reply(404, { message: 'No such person on this film.' });

    const mine = (await get(`flieks_stats/${filmId}/refs/${cSlug}`)) || {};
    const share = shareText(film.cast_share, Number(film.price_own) || 0);

    const sales = mine.sales || 0;

    return reply(200, {
      name: person.name || '',
      role: person.role || '',
      film: film.title || '',
      filmSlug: film.slug || filmId,
      poster: film.poster_url || '',
      clicks: mine.clicks || 0,
      trailerPlays: mine.trailerPlays || 0,
      sales,
      // What they are owed, on the filmmaker's stated terms.
      earned: share.perSale ? +(share.perSale * sales).toFixed(2) : 0,
      share
    });

  } catch (e) {
    console.error('cast stats error:', e);
    return reply(500, { message: 'Could not load that.' });
  }
};
