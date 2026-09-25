/**
 * actors-spaces — the Actors Spaces talent pool, read through their API.
 *
 * OFF until these are set in Netlify (Site settings → Environment variables):
 *   ACTORS_SPACES_API_URL   base address of their API, e.g. https://api.actorsspaces.com/v1
 *   ACTORS_SPACES_API_KEY   the key they give us
 * Optional:
 *   ACTORS_SPACES_SEARCH_PATH   default /talent       (the list/search endpoint)
 *   ACTORS_SPACES_PROFILE_PATH  default /talent/{id}  (one person)
 *   ACTORS_SPACES_AUTH          default "bearer"      ("bearer" → Authorization: Bearer <key>; "header" → X-API-Key: <key>)
 *
 * Everything that depends on the shape of their data is in toCard() below. When their
 * API documentation arrives, adjust toCard() (and the query names in search()) and
 * nothing else changes: search, profiles and cast match all use these cards.
 *
 * Their people are shown with a "via Actors Spaces" badge and a link to their Actors
 * Spaces profile. We never get or show their email; contact goes through Actors Spaces.
 */
const BASE = () => String(process.env.ACTORS_SPACES_API_URL || '').replace(/\/+$/, '');
const KEY = () => process.env.ACTORS_SPACES_API_KEY || '';
const enabled = () => !!(BASE() && KEY() && /^https:\/\//.test(BASE()));

const str = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
const httpsUrl = v => { const s = str(v, 500); return /^https:\/\/\S+$/i.test(s) ? s : ''; };
const first = (...vals) => vals.find(v => v != null && v !== '');
const arr = v => Array.isArray(v) ? v : (typeof v === 'string' && v ? v.split(',') : []);

/* Their skills or job titles, mapped onto our disciplines. */
const DISCIPLINE_WORDS = [
  ['Actor', /\b(actor|actress|acting|performer|voice)/i], ['Director', /\bdirect/i], ['Writer', /\b(writer|screenwrit|script)/i],
  ['Producer', /\bproduc/i], ['Camera / DOP', /\b(dop|cinematograph|camera|director of photography)/i], ['Editor', /\bedit/i],
  ['Sound', /\b(sound|audio|boom)/i], ['Production design', /\b(production design|art direct|set design)/i],
  ['Wardrobe', /\b(wardrobe|costume)/i], ['Make-up', /\b(make-?up|hair|sfx makeup)/i], ['Music', /\b(music|composer)/i]
];

/**
 * ONE person from their API → our card. Field names are best guesses until we see
 * their docs: each line tries the likely names in order.
 */
function toCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(first(raw.id, raw.uuid, raw.slug, raw.talent_id), 80);
  const name = str(first(raw.name, raw.full_name, [raw.first_name, raw.last_name].filter(Boolean).join(' ')), 80);
  if (!id || !name) return null;
  const roles = arr(first(raw.disciplines, raw.roles, raw.skills, raw.categories, raw.type, raw.profession)).map(r => str(r && (r.name || r), 60));
  const disciplines = [...new Set(DISCIPLINE_WORDS.filter(([, re]) => roles.some(r => re.test(r))).map(([d]) => d))];
  const lo = Number(first(raw.playing_age_min, raw.age_min, raw.playing_age && raw.playing_age.min)) || null;
  const hi = Number(first(raw.playing_age_max, raw.age_max, raw.playing_age && raw.playing_age.max)) || null;
  const credits = arr(first(raw.credits, raw.work, raw.filmography)).slice(0, 6).map(w => w && {
    title: str(first(w.title, w.production, w.name), 80), role: str(first(w.role, w.character, w.position), 60),
    kind: 'Other', year: Number(first(w.year, w.release_year)) || null, url: httpsUrl(first(w.url, w.link, w.imdb))
  }).filter(w => w && w.title && w.url);
  const imdb = /imdb\.com\/name\/nm\d+/i.test(String(first(raw.imdb, raw.imdb_url, raw.links && raw.links.imdb) || ''))
    ? httpsUrl(first(raw.imdb, raw.imdb_url, raw.links && raw.links.imdb)) : '';
  return {
    id: `as:${id}`, source: 'actorsspaces', name,
    photo_url: httpsUrl(first(raw.photo_url, raw.headshot, raw.image, raw.avatar, raw.photo)),
    city: str(first(raw.city, raw.location && raw.location.city), 60), province: str(first(raw.province, raw.region, raw.location && raw.location.region), 60),
    country: str(first(raw.country, raw.location && raw.location.country), 60),
    playing_age: lo && hi ? `${lo}–${hi}` : '', playing_age_min: lo, playing_age_max: hi,
    languages: arr(first(raw.languages, raw.language)).map(l => str(l && (l.name || l), 30)).filter(Boolean).slice(0, 8),
    showreel: httpsUrl(first(raw.showreel, raw.showreel_url, raw.reel)), instagram: str(raw.instagram, 60).replace(/^@/, ''),
    bio: str(first(raw.bio, raw.about, raw.summary), 400), imdb, work: credits,
    disciplines: disciplines.length ? disciplines : ['Other crew'], record: { films: [], clicks: 0, trailer: 0, sales: 0 },
    profile_url: httpsUrl(first(raw.profile_url, raw.url, raw.public_url))
  };
}

function headers() {
  const h = { Accept: 'application/json' };
  if ((process.env.ACTORS_SPACES_AUTH || 'bearer') === 'header') h['X-API-Key'] = KEY(); else h.Authorization = `Bearer ${KEY()}`;
  return h;
}

async function getJson(path, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);   // never hold up our own search for long
  try {
    const r = await fetchImpl(BASE() + path, { headers: headers(), signal: ctrl.signal });
    if (!r.ok) throw new Error(`Actors Spaces ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* A short cache so repeated searches don't hammer their API. */
const cache = new Map();
const CACHE_MS = 10 * 60e3;

/** Search their pool. Returns [] (never throws) when off or unavailable. */
async function search(f = {}, { fetchImpl } = {}) {
  if (!enabled()) return [];
  const qs = new URLSearchParams();
  if (f.q) qs.set('search', String(f.q).slice(0, 80));
  if (f.discipline) qs.set('role', f.discipline);
  if (f.country) qs.set('country', f.country);
  if (f.language) qs.set('language', String(f.language).slice(0, 30));
  qs.set('limit', '60');
  const path = (process.env.ACTORS_SPACES_SEARCH_PATH || '/talent') + '?' + qs;
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cards;
  try {
    const data = await getJson(path, fetchImpl);
    const list = Array.isArray(data) ? data : (data.results || data.data || data.talent || data.items || []);
    const cards = list.map(toCard).filter(Boolean);
    cache.set(path, { at: Date.now(), cards });
    return cards;
  } catch (e) {
    console.error('[actors-spaces] search', e.message);
    return [];
  }
}

/** One person by our id ("as:<their id>"). null when off, missing or unavailable. */
async function profile(id, { fetchImpl } = {}) {
  if (!enabled() || !/^as:[A-Za-z0-9_-]{1,80}$/.test(id || '')) return null;
  const path = (process.env.ACTORS_SPACES_PROFILE_PATH || '/talent/{id}').replace('{id}', encodeURIComponent(id.slice(3)));
  try { const d = await getJson(path, fetchImpl); return toCard(d && (d.data || d.talent || d)); }
  catch (e) { console.error('[actors-spaces] profile', e.message); return null; }
}

module.exports = { enabled, search, profile, toCard };
