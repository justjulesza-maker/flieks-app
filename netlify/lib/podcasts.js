/**
 * podcasts — channels and episodes (video or audio), from other platforms or our own uploads.
 *
 *   flieks_pod_channels/{id}  { title, slug, description, host, cover_url, owner_uid,
 *                               status: 'live'|'pending'|'rejected', featured, created_at, updated_at }
 *   flieks_pod_slugs/{slug}   channel id
 *   flieks_pod_episodes/{id}  { channel_id, title, description, number, kind: 'video'|'audio',
 *                               source: youtube|vimeo|spotify|soundcloud|apple|bunny|upload,
 *                               ref (the platform's id or page link), thumbnail_url, duration_mins,
 *                               price (0 = free), status: 'live'|'draft', published_at, created_at }
 *   flieks_private/pod_{episodeId}  { bunny_id, bunny_ready, video_url, audio_url }   (never public)
 *
 * Nothing here is public in the database: the site reads it through
 * flieks-podcasts, which only hands out a player to signed-in viewers
 * (and, for a paid episode, to people who bought it).
 */
const str = (v, n) => (v == null ? '' : String(v)).trim().slice(0, n);
const okId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(id);
const slugify = s => str(s, 80).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const httpsUrl = v => { const s = str(v, 600); return /^https:\/\/[^\s<>"]+$/i.test(s) ? s : ''; };

/**
 * A link from another platform → { source, kind, ref }, or null.
 * YouTube, Vimeo, Spotify, SoundCloud and Apple Podcasts.
 */
function parseLink(input) {
  const raw = str(input, 600);
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? { source: 'youtube', kind: 'video', ref: id } : null;
  }
  if (host === 'youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
    let id = u.searchParams.get('v');
    const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
    if (!id && m) id = m[1];
    return /^[A-Za-z0-9_-]{11}$/.test(id || '') ? { source: 'youtube', kind: 'video', ref: id } : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const m = u.pathname.match(/(?:^|\/)(\d{6,12})(?:\/([0-9a-f]{6,20}))?/);
    return m ? { source: 'vimeo', kind: 'video', ref: m[1] + (m[2] ? ':' + m[2] : '') } : null;
  }
  if (host === 'open.spotify.com') {
    const m = u.pathname.match(/\/(?:embed\/)?(episode|show)\/([A-Za-z0-9]{22})/);
    return m ? { source: 'spotify', kind: 'audio', ref: `${m[1]}/${m[2]}` } : null;
  }
  if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
    return u.pathname.length > 1 ? { source: 'soundcloud', kind: 'audio', ref: `https://soundcloud.com${u.pathname.replace(/\/$/, '')}` } : null;
  }
  if (host === 'podcasts.apple.com' || host === 'embed.podcasts.apple.com') {
    return /\/podcast\//.test(u.pathname) ? { source: 'apple', kind: 'audio', ref: `https://embed.podcasts.apple.com${u.pathname}${u.search}` } : null;
  }
  return null;
}

/** The player a signed-in viewer gets for a linked episode. */
function embedFor(ep) {
  const r = ep.ref || '';
  switch (ep.source) {
    case 'youtube': return /^[A-Za-z0-9_-]{11}$/.test(r) ? { type: 'iframe', url: `https://www.youtube-nocookie.com/embed/${r}?rel=0&modestbranding=1`, ratio: '16:9' } : null;
    case 'vimeo': { const [id, h] = r.split(':'); return /^\d+$/.test(id) ? { type: 'iframe', url: `https://player.vimeo.com/video/${id}${h ? '?h=' + h : ''}`, ratio: '16:9' } : null; }
    case 'spotify': return /^(episode|show)\/[A-Za-z0-9]{22}$/.test(r) ? { type: 'iframe', url: `https://open.spotify.com/embed/${r}`, height: 232 } : null;
    case 'soundcloud': return /^https:\/\/soundcloud\.com\//.test(r) ? { type: 'iframe', url: `https://w.soundcloud.com/player/?url=${encodeURIComponent(r)}&visual=true`, height: 300 } : null;
    case 'apple': return /^https:\/\/embed\.podcasts\.apple\.com\//.test(r) ? { type: 'iframe', url: r, height: 175 } : null;
    default: return null;
  }
}

/* The platforms' public oEmbed endpoints give a title and picture without any API key. */
const OEMBED = {
  youtube: ep => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + ep.ref)}`,
  vimeo: ep => `https://vimeo.com/api/oembed.json?url=${encodeURIComponent('https://vimeo.com/' + ep.ref.split(':')[0] + (ep.ref.includes(':') ? '/' + ep.ref.split(':')[1] : ''))}`,
  spotify: ep => `https://open.spotify.com/oembed?url=${encodeURIComponent('https://open.spotify.com/' + ep.ref)}`,
  soundcloud: ep => `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(ep.ref)}`
};

async function lookupDetails(link, fetchImpl = fetch) {
  const make = OEMBED[link.source];
  if (!make) return {};
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetchImpl(make(link), { signal: ctrl.signal });
    if (!r.ok) return {};
    const d = await r.json();
    return {
      title: str(d.title, 140),
      thumbnail_url: httpsUrl(d.thumbnail_url),
      duration_mins: d.duration ? Math.max(1, Math.round(Number(d.duration) / 60)) : null,
      author: str(d.author_name, 80)
    };
  } catch { return {}; } finally { clearTimeout(t); }
}

function cleanChannel(c) {
  return {
    title: str(c && c.title, 80), description: str(c && c.description, 800) || null,
    host: str(c && c.host, 80) || null, cover_url: httpsUrl(c && c.cover_url) || null
  };
}

function cleanEpisode(e) {
  const price = Math.round(Number(e && e.price) || 0);
  return {
    title: str(e && e.title, 140), description: str(e && e.description, 2000) || null,
    number: Math.max(0, Math.min(9999, parseInt(e && e.number, 10) || 0)) || null,
    duration_mins: Math.max(0, Math.min(600, parseInt(e && e.duration_mins, 10) || 0)) || null,
    thumbnail_url: httpsUrl(e && e.thumbnail_url) || null,
    price: price >= 5 && price <= 5000 ? price : 0,
    status: e && e.status === 'draft' ? 'draft' : 'live'
  };
}

/* What anyone may see about an episode: no player, no media links. */
function publicEpisode(id, e) {
  return { id, channel_id: e.channel_id, title: e.title, description: e.description || '', number: e.number || null,
    kind: e.kind, source: e.source, thumbnail_url: e.thumbnail_url || null, duration_mins: e.duration_mins || null,
    price: e.price || 0, published_at: e.published_at || e.created_at || 0 };
}

function publicChannel(id, c, episodes) {
  const eps = episodes.filter(e => e.channel_id === id);
  return { id, slug: c.slug, title: c.title, description: c.description || '', host: c.host || '', cover_url: c.cover_url || null,
    owner_uid: c.owner_uid || null, featured: !!c.featured, episodes: eps.length,
    latest_at: eps.reduce((m, e) => Math.max(m, e.published_at || 0), 0),
    has_paid: eps.some(e => e.price > 0), kinds: [...new Set(eps.map(e => e.kind))] };
}

module.exports = { str, okId, slugify, httpsUrl, parseLink, embedFor, lookupDetails, cleanChannel, cleanEpisode, publicEpisode, publicChannel };
