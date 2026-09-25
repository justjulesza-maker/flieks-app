/**
 * cast-match-background — suggests opted-in actors for a Script Report's
 * characters. Called only by flieks-script-report (shared secret).
 * Writes flieks_script_reports/<id>/cast_match for the owner's page to poll.
 */
const crypto = require('crypto');
const ops = require('../lib/ops-core');
const { matchCast } = require('../lib/script-report-core');
const { record, card } = require('../lib/talent');
const actorsSpaces = require('../lib/actors-spaces');

const MAX_CANDIDATES = 120;
const secret = () => crypto.createHash('sha256').update(String(process.env.FIREBASE_DB_SECRET) + ':castmatch').digest('hex');

exports.handler = async event => {
  const given = String((event.headers || {})['x-job-secret'] || '');
  const want = secret();
  if (given.length !== want.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(want))) return { statusCode: 403 };
  let id;
  const set = f => ops.dbWrite(`flieks_script_reports/${id}/cast_match`, f, 'PATCH');
  try {
    ({ id } = JSON.parse(event.body || '{}'));
    if (!/^[A-Za-z0-9]{12,40}$/.test(id || '')) return { statusCode: 400 };
    const rec = await ops.dbGet(`flieks_script_reports/${id}`);
    if (!rec || !rec.report || !rec.cast_match || rec.cast_match.status !== 'queued') return { statusCode: 200 };
    await set({ status: 'working' });

    // Only people who switched on "suggest me", and who act.
    const all = await ops.dbGet('flieks_talent') || {};
    const opted = Object.entries(all)
      .filter(([uid, p]) => p && p.suggest === true && (p.disciplines || []).includes('Actor') && uid !== rec.owner)
      .sort(([, a], [, b]) => Object.keys(b.credits || {}).length - Object.keys(a.credits || {}).length || (b.updated_at || 0) - (a.updated_at || 0))
      .slice(0, MAX_CANDIDATES);

    const cards = {};
    for (const [uid, p] of opted) cards[uid] = card(uid, p, await record(p));
    // Actors Spaces' pool too, once it's connected (their ids start with "as:").
    for (const c of (await actorsSpaces.search({ discipline: 'Actor' })).slice(0, 60)) cards[c.id] = c;

    const characters = (rec.report.characters || []).map(c => ({ name: c.name, role: c.role, casting: c.casting, description: c.description }));
    let matches = [];
    if (Object.keys(cards).length && characters.length) {
      const candidates = Object.values(cards).map(c => ({
        id: c.id, playing_age: c.playing_age, languages: c.languages, city: c.city, province: c.province, country: c.country, bio: c.bio,
        films: c.record.films.length, people_via_link: c.record.clicks, sales_via_link: c.record.sales
      }));
      matches = await matchCast(characters, candidates);
    }
    const used = new Set(matches.flatMap(m => m.picks.map(p => p.id)));
    const people = Object.fromEntries(Object.entries(cards).filter(([uid]) => used.has(uid)));
    await set({ status: 'done', matches, people, pool: Object.keys(cards).length, error: null, finished_at: Date.now() });
    return { statusCode: 200 };
  } catch (e) {
    console.error('[cast-match]', id, e);
    if (id) await set({ status: 'error', error: String(e.message || e).slice(0, 300) }).catch(() => {});
    return { statusCode: 200 };
  }
};
