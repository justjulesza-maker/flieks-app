/**
 * flieks-results — a film's performance, for showing to someone who matters.
 *
 * Reached by an unguessable key the filmmaker turns on and can revoke. No
 * sign-in, because the people who need to see this — funders, festivals,
 * broadcasters — will not make an account.
 *
 * The filmmaker chooses whether revenue is included. Audience numbers are
 * evidence for a grant application; earnings are nobody's business unless the
 * filmmaker decides otherwise.
 *
 * POST { key }  ->  the film's figures
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

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
  body: JSON.stringify(obj)
});

const money = n => +Number(n || 0).toFixed(2);

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  try {
    const { key } = JSON.parse(event.body || '{}');
    if (!key || !/^[a-z0-9]{10,40}$/i.test(key)) {
      return reply(400, { message: 'Bad link.' });
    }

    const filmId = await get(`flieks_result_keys/${key}`);
    if (!filmId) return reply(404, { message: 'That link is no longer active.' });

    const film = await get(`flieks_films/${filmId}`);
    if (!film || !film.results_public) {
      return reply(404, { message: 'That link is no longer active.' });
    }

    const showMoney = film.results_show_revenue !== false;

    const [stats, cast, txs, reviews] = await Promise.all([
      get(`flieks_stats/${filmId}`),
      get(`flieks_cast/${filmId}`),
      get('flieks_transactions'),
      get(`flieks_reviews/${filmId}`)
    ]);

    const refs = (stats && stats.refs) || {};
    const totals = (stats && stats.totals) || {};

    /* Sales come from the transactions themselves, not a counter — a counter
       that has ever been wrong stays wrong, and this is evidence. */
    const sales = [];
    Object.values(txs || {}).forEach(t => {
      if (!t || t.film_id !== filmId) return;
      if (t.status !== 'complete' || t.mode === 'test') return;
      sales.push({ at: t.completed_at || t.created_at, type: t.type, total: money(t.total) });
    });
    sales.sort((a, b) => (a.at || 0) - (b.at || 0));

    const revenue = sales.reduce((s, x) => s + x.total, 0);
    const rentals = sales.filter(s => s.type === 'rent').length;
    const owned   = sales.filter(s => s.type === 'own').length;
    const gifted  = sales.filter(s => s.type === 'gift').length;

    /* Sales per day, so a funder can see the shape of a release rather than
       one flat number. */
    const byDay = {};
    sales.forEach(s => {
      const d = new Date(s.at || Date.now()).toISOString().slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
    });
    const timeline = Object.entries(byDay).sort().map(([date, n]) => ({ date, sales: n }));

    /* Who actually shifted tickets. Names only for people the filmmaker
       already shows publicly on the film page. */
    const people = Object.entries(refs).map(([slug, r]) => {
      const person = (cast && cast[slug]) || {};
      return {
        name: person.hidden ? 'A crew member' : (person.name || slug),
        role: person.hidden ? '' : (person.role || ''),
        clicks: r.clicks || 0,
        trailerPlays: r.trailerPlays || 0,
        sales: r.sales || 0,
        revenue: showMoney ? money(r.revenue) : null,
        conversion: r.clicks ? +((r.sales || 0) / r.clicks * 100).toFixed(1) : 0
      };
    }).filter(p => p.clicks > 0)
      .sort((a, b) => b.sales - a.sales || b.clicks - a.clicks);

    const reviewList = Object.values(reviews || {})
      .filter(r => r && !r.hidden && r.body && Number(r.rating) >= 4)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      .slice(0, 4)
      .map(r => ({ name: r.name || 'A viewer', rating: r.rating, body: String(r.body).slice(0, 260) }));

    const clicks = Object.values(refs).reduce((s, r) => s + (r.clicks || 0), 0) ||
                   (stats && stats.clicks) || 0;
    const views = (stats && stats.views) || 0;
    const trailers = Object.values(refs).reduce((s, r) => s + (r.trailerPlays || 0), 0) ||
                     (stats && stats.trailerPlays) || 0;

    return reply(200, {
      film: {
        title: film.title || '',
        filmmaker: film.filmmaker || '',
        synopsis: film.synopsis || '',
        minutes: film.duration_mins || null,
        language: film.language || '',
        genre: Array.isArray(film.genre) ? film.genre : (film.genre ? [film.genre] : []),
        poster: film.og_image || film.poster_url || '',
        released: film.published_at || null
      },
      showMoney,
      headline: {
        buyers: sales.length,
        clicks,
        views,
        trailers,
        conversion: clicks ? +(sales.length / clicks * 100).toFixed(1) : 0,
        revenue: showMoney ? money(revenue) : null,
        rentals, owned, gifted,
        rating: film.rating_avg || 0,
        ratingCount: film.rating_count || 0,
        firstSale: sales.length ? sales[0].at : null,
        lastSale: sales.length ? sales[sales.length - 1].at : null
      },
      timeline,
      people: people.slice(0, 12),
      reviews: reviewList
    });

  } catch (e) {
    console.error('results error:', e);
    return reply(500, { message: 'Could not load that.' });
  }
};
