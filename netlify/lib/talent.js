/**
 * talent — shared pieces of the 4flieks talent directory.
 *
 * flieks_talent/<uid>                        a person's profile (server-only node)
 * flieks_talent_claims/<filmId>/<castKey>/<uid>  "that cast credit is me", waiting for the filmmaker
 *
 * Built to be the seed of 4flieks.biz: actors now, crew next. Nobody is ever
 * suggested to a filmmaker unless they switched `suggest` on themselves.
 */
const ops = require('./ops-core');

const DISCIPLINES = ['Actor', 'Director', 'Writer', 'Producer', 'Camera / DOP', 'Editor', 'Sound', 'Production design',
  'Wardrobe', 'Make-up', 'Music', 'Other crew'];
// Talent anywhere in Africa. Provinces are asked for South Africa only.
const COUNTRIES = [
  'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cabo Verde', 'Cameroon',
  'Central African Republic', 'Chad', 'Comoros', "Côte d'Ivoire", 'Democratic Republic of the Congo',
  'Djibouti', 'Egypt', 'Equatorial Guinea', 'Eritrea', 'Eswatini', 'Ethiopia', 'Gabon', 'Gambia', 'Ghana',
  'Guinea', 'Guinea-Bissau', 'Kenya', 'Lesotho', 'Liberia', 'Libya', 'Madagascar', 'Malawi', 'Mali',
  'Mauritania', 'Mauritius', 'Morocco', 'Mozambique', 'Namibia', 'Niger', 'Nigeria', 'Republic of the Congo',
  'Rwanda', 'São Tomé and Príncipe', 'Senegal', 'Seychelles', 'Sierra Leone', 'Somalia', 'South Africa',
  'South Sudan', 'Sudan', 'Tanzania', 'Togo', 'Tunisia', 'Uganda', 'Zambia', 'Zimbabwe', 'Outside Africa'
];
const PROVINCES = ['Gauteng', 'Western Cape', 'KwaZulu-Natal', 'Eastern Cape', 'Free State', 'Limpopo', 'Mpumalanga',
  'North West', 'Northern Cape'];

/* Profiles made before countries were asked for only have a province. */
const countryOf = p => (p && COUNTRIES.includes(p.country)) ? p.country : (p && PROVINCES.includes(p.province) ? 'South Africa' : '');

const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const url = v => { const s = str(v, 300); return /^https:\/\/\S+$/i.test(s) ? s : ''; };

/* Only what the person typed, cleaned. Credits are never taken from the browser. */
function cleanProfile(p) {
  p = p && typeof p === 'object' ? p : {};
  let lo = int(p.playing_age_min, 1, 99), hi = int(p.playing_age_max, 1, 99);
  if (lo && hi && lo > hi) [lo, hi] = [hi, lo];
  const photo = str(p.photo_url, 600);
  return {
    name: str(p.name, 80),
    disciplines: (Array.isArray(p.disciplines) ? p.disciplines : []).filter(d => DISCIPLINES.includes(d)).slice(0, 6),
    playing_age_min: lo, playing_age_max: hi,
    languages: (Array.isArray(p.languages) ? p.languages : String(p.languages || '').split(','))
      .map(l => str(l, 30)).filter(Boolean).slice(0, 8),
    city: str(p.city, 60),
    country: countryOf(p),
    province: countryOf(p) === 'South Africa' && PROVINCES.includes(p.province) ? p.province : '',
    showreel: url(p.showreel),
    instagram: str(p.instagram, 60).replace(/^@/, ''),
    bio: str(p.bio, 400),
    // Headshots are uploaded to our own bucket; nothing else is accepted.
    photo_url: photo.startsWith('https://firebasestorage.googleapis.com/v0/b/flieks-app.firebasestorage.app/o/') ? photo : '',
    suggest: p.suggest === true
  };
}

/* The numbers behind each approved credit: people their link brought in, trailer plays, sales. */
async function record(profile) {
  const credits = Object.values((profile && profile.credits) || {});
  let clicks = 0, trailer = 0, sales = 0;
  await Promise.all(credits.map(async c => {
    const s = await ops.dbGet(`flieks_stats/${c.film_id}/refs/${c.cast_key}`).catch(() => null) || {};
    clicks += s.clicks || 0; trailer += s.trailerPlays || 0; sales += s.sales || 0;
  }));
  return { films: credits.map(c => ({ title: c.film_title, role: c.role || '' })), clicks, trailer, sales };
}

/* What a filmmaker may see about a suggested actor. Never the email. */
function card(uid, p, rec) {
  return {
    id: uid, name: p.name, photo_url: p.photo_url || '', city: p.city || '', province: p.province || '', country: countryOf(p),
    playing_age: p.playing_age_min && p.playing_age_max ? `${p.playing_age_min}–${p.playing_age_max}` : '',
    languages: p.languages || [], showreel: p.showreel || '', instagram: p.instagram || '', bio: p.bio || '',
    disciplines: p.disciplines || [], record: rec
  };
}

module.exports = { DISCIPLINES, COUNTRIES, PROVINCES, countryOf, cleanProfile, record, card };
