/**
 * news-core — the Lab's industry news: headlines from South African film and TV
 * news sites, read from their public RSS feeds on the server.
 *
 * Only the headline, source, date and a link to the original are kept and shown.
 * No article text or images are copied, and the browser never contacts these
 * sites (no new Content-Security-Policy hosts).
 *
 * Stories that mention a blocked word (Showmax) are never stored or shown.
 * The team can also hide any single story from the Lab page.
 *
 * Data (server-only in the rules):
 *   flieks_news/items/<id>    { title, link, source, at, tag, manual? }
 *   flieks_news/hidden/<id>   true   hidden by the team; a refresh never brings it back
 *   flieks_news/meta          { at, by, schedule_at?, watch_at?, sources: { <sourceId>: { ok, count, error?, fails, last_ok_at? } } }
 *
 * Who reads the feeds (meta.by): 'schedule' (flieks-news-refresh, every three hours),
 * 'watch' (flieks-ops-watch, as a backup when the feeds are more than 3½ hours old)
 * or 'team' (Read the feeds now).
 */
const crypto = require('crypto');

/* Each source: the feed, and the only sites its links may point to. */
const SOURCES = [
  { id: 'callsheet', name: 'The Callsheet', feed: 'https://www.thecallsheet.co.za/feed/', hosts: ['thecallsheet.co.za', 'www.thecallsheet.co.za'] },
  { id: 'nfvf', name: 'NFVF', feed: 'https://www.nfvf.co.za/feed/', hosts: ['nfvf.co.za', 'www.nfvf.co.za'] },
  { id: 'dfm', name: 'Durban FilmMart', feed: 'https://durbanfilmmart.co.za/feed/', hosts: ['durbanfilmmart.co.za', 'www.durbanfilmmart.co.za'] },
  { id: 'kznfilm', name: 'KZN Film Commission', feed: 'https://visitkzn-sa.com/film/feed/', hosts: ['visitkzn-sa.com', 'www.visitkzn-sa.com'] }
];
const SOURCE_IDS = SOURCES.map(s => s.id).concat('team');
const SOURCE_NAME = Object.fromEntries(SOURCES.map(s => [s.id, s.name]).concat([['team', '4flieks']]));

/* Kept out of everything public on 4flieks (see project rules). Matched on the headline and the link. */
const BLOCKED = [/show[\s_.-]*max/i];

const KEEP_DAYS = 45;          // older stories drop off
const MAX_ITEMS = 80;          // stored at most
const MAX_FEED_BYTES = 1.5e6;  // a feed bigger than this is not read
const ID = /^n[0-9a-f]{16}$/;
const TAGS = ['funding', 'call', 'news'];

const idFor = link => 'n' + crypto.createHash('sha256').update(String(link)).digest('hex').slice(0, 16);

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d{1,7});/g, (_, n) => { const c = Number(n); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => { const c = parseInt(n, 16); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? ' ')
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const field = (block, tag) => { const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i')); return m ? m[1] : ''; };

/* Shouty all-caps headlines (common on press releases) read badly in a list:
   turn them into sentence case, keeping known acronyms and names. */
const KEEP_UPPER = /\b(sa|nfvf|pesp|diff|dfm|kzn|gfc|safta|saftas|tv|ai|vfx|uk|us|usa|mict|seta|sabc|etv|dstv|dti|dsac|nyda|idc|bbc|hbo|ceo|ii|iii|iv)\b/gi;
const KEEP_NAME = /\b(south africa|south african|africa|african|johannesburg|joburg|cape town|durban|pretoria|soweto|gauteng|kwazulu-natal|eastern cape|western cape|limpopo|mpumalanga|nigeria|kenya|ghana|nollywood|mzansi|oscars?|academy awards?|emmys?|berlinale|cannes|sundance|toronto|venice|fespaco|netflix|amazon|prime video|disney|apple|youtube|tiktok|ster-kinekor|nu metro|durban filmmart|minister|mckenzie|january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;
function tidyTitle(t) {
  t = decode(t).slice(0, 220);
  const letters = t.replace(/[^A-Za-z]/g, '');
  if (letters.length > 12 && letters === letters.toUpperCase()) {
    t = t.toLowerCase()
      .replace(KEEP_NAME, w => w.replace(/(^|[\s-])([a-z])/g, (m, p, c) => p + c.toUpperCase()))
      .replace(KEEP_UPPER, w => w.toUpperCase())
      .replace(/\br(\d)/g, 'R$1')
      .replace(/(^\W*|[.!?:]\s+|\s[–—-]\s+|[“"])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  }
  return t.length > 200 ? t.slice(0, 199).replace(/\s+\S*$/, '') + '…' : t;
}

function safeLink(link, hosts) {
  let u;
  try { u = new URL(decode(link)); } catch { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
  if (hosts && !hosts.includes(u.hostname.toLowerCase())) return '';
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/i.test(k)) u.searchParams.delete(k);
  const s = u.toString();
  return s.length <= 500 ? s : '';
}

function tagFor(title) {
  if (/\b(fund(s|ing|ed)?|grants?|bursar(y|ies)|pesp|incentives?|rebates?|stimulus|financ(e|ing)|investment)\b/i.test(title)) return 'funding';
  if (/\b(calls? for|open call|submissions?|applications?|apply|nominations?|entries|deadline|auditions?|casting call|workshop|lab|masterclass|programme)\b/i.test(title)) return 'call';
  return 'news';
}
const blocked = (title, link) => BLOCKED.some(r => r.test(title) || r.test(link));

/* One feed's XML → clean items. RSS 2.0 and Atom. Never throws. */
function parseFeed(xml, source, now = Date.now()) {
  const out = [];
  if (typeof xml !== 'string' || xml.length > MAX_FEED_BYTES) return out;
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 40)) {
    const title = tidyTitle(field(b, 'title'));
    let rawLink = field(b, 'link');
    if (!rawLink) { const m = b.match(/<link[^>]*href="([^"]+)"/i); rawLink = m ? m[1] : ''; }
    const link = safeLink(rawLink, source.hosts);
    if (title.length < 6 || !link || blocked(title, link)) continue;
    let at = Date.parse(decode(field(b, 'pubDate') || field(b, 'published') || field(b, 'updated') || field(b, 'dc:date')));
    if (!Number.isFinite(at) || at > now + 864e5) at = now;
    if (at < now - KEEP_DAYS * 864e5) continue;
    out.push({ id: idFor(link), title, link, source: source.id, at, tag: tagFor(title) });
  }
  return out;
}

/* Fetch every source and merge into what is stored. Returns { items, meta }. */
const STALE_MS = 3.5 * 36e5;
const isStale = (meta, now = Date.now()) => !meta || !(Number(meta.at) > now - STALE_MS);
const BY = ['schedule', 'watch', 'team'];

async function refresh(ops, { fetchImpl = fetch, now = Date.now(), by = 'team', timeoutMs = 9000 } = {}) {
  const [stored, hidden, prevMeta] = await Promise.all([ops.dbGet('flieks_news/items'), ops.dbGet('flieks_news/hidden'), ops.dbGet('flieks_news/meta')]);
  const prev = (prevMeta && prevMeta.sources) || {};
  if (!BY.includes(by)) by = 'team';
  const items = {};
  for (const [id, it] of Object.entries(stored || {})) {
    if (ID.test(id) && it && it.at >= now - KEEP_DAYS * 864e5 && !blocked(it.title || '', it.link || '')) items[id] = { ...it, id };
  }
  const meta = { at: now, by, sources: {} };
  for (const k of ['schedule_at', 'watch_at']) if (prevMeta && Number(prevMeta[k]) > 0) meta[k] = Number(prevMeta[k]);
  if (by !== 'team') meta[by + '_at'] = now;
  await Promise.all(SOURCES.map(async s => {
    try {
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let r;
      try { r = await fetchImpl(s.feed, { headers: { 'User-Agent': '4flieks-news/1.0 (+https://4flieks.com/lab)', Accept: 'application/rss+xml, application/xml, text/xml' }, signal: ctl.signal, redirect: 'follow' }); }
      finally { clearTimeout(timer); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const len = Number(r.headers && r.headers.get ? r.headers.get('content-length') : 0);
      if (len > MAX_FEED_BYTES) throw new Error('feed too big');
      const got = parseFeed(await r.text(), s, now);
      for (const it of got) if (!items[it.id] || !items[it.id].manual) items[it.id] = it;
      meta.sources[s.id] = { ok: true, count: got.length, fails: 0, last_ok_at: now };
    } catch (e) {
      const p = prev[s.id] || {};
      meta.sources[s.id] = { ok: false, count: 0, error: String(e.name === 'AbortError' ? 'timed out' : e.message).slice(0, 120),
        fails: (Number(p.fails) || 0) + 1, ...(Number(p.last_ok_at) > 0 ? { last_ok_at: Number(p.last_ok_at) } : {}) };
    }
  }));
  for (const id of Object.keys(hidden || {})) delete items[id];
  const keep = Object.values(items).sort((a, b) => b.at - a.at).slice(0, MAX_ITEMS);
  const out = Object.fromEntries(keep.map(it => [it.id, it]));
  await ops.dbWrite('flieks_news/items', out);
  await ops.dbWrite('flieks_news/meta', meta);
  return { items: out, meta };
}

/* What the page gets: only these fields, re-checked on the way out. */
function publicItem(id, it) {
  const link = safeLink(it.link, null);
  if (!link || blocked(it.title || '', link)) return null;
  return { id, title: String(it.title || '').slice(0, 220), link, source: SOURCE_NAME[it.source] || '4flieks',
    at: Number(it.at) || 0, tag: TAGS.includes(it.tag) ? it.tag : 'news' };
}

module.exports = { STALE_MS, isStale, SOURCES, SOURCE_IDS, BLOCKED, ID, TAGS, KEEP_DAYS, idFor, decode, tidyTitle, safeLink, tagFor, blocked, parseFeed, refresh, publicItem };
