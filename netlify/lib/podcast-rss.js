/**
 * podcast-rss — a podcast channel kept in step with the show's RSS feed.
 *
 * The feed is read on the server only. Each episode's audio (or video) plays
 * straight from the show's own host (e.g. content.rss.com), so their download
 * stats keep counting; we store the episode details and the media link.
 *
 *   flieks_pod_channels/{id}/rss   { url, auto, title, items_in_feed, last_at, last_ok_at, last_error, by }
 *   flieks_pod_episodes/{id}       source: 'rss', ref: 'r' + hash of the feed's guid (how we spot repeats)
 *   flieks_private/pod_{id}        { audio_url } or { video_url }   (never public, like uploads)
 *   flieks_pod_rss_skip/{channelId}/{ref}  true   an imported episode someone deleted; never re-added
 *
 * New episodes come in from the scheduled flieks-podcasts-rss (every three
 * hours, when the channel's auto is on) or "Check the feed now" in the Studio.
 * An episode already imported is never overwritten, so edits made in the
 * Studio stick; only its media link is refreshed if the feed moves the file.
 */
const crypto = require('crypto');

const MAX_FEED_BYTES = 10 * 1048576;  // podcast feeds with long show notes run to several MB
const MAX_ITEMS = 300;                // newest episodes taken from one feed
const UA = '4flieks-podcasts/1.0 (+https://4flieks.com/podcasts)';

/* ---------- text ---------- */
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', rsaquo: '›', lsaquo: '‹', laquo: '«', raquo: '»', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', ocirc: 'ô', uuml: 'ü', ouml: 'ö', auml: 'ä', ccedil: 'ç', ntilde: 'ñ' };
const unCdata = s => String(s || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
function entities(s) {
  return String(s || '')
    .replace(/&#(\d{1,7});/g, (_, n) => { const c = Number(n); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => { const c = parseInt(n, 16); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ' '; })
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? ' ');
}
/** One line of plain text (titles, names). */
const line = (s, max) => entities(unCdata(s).replace(/<[^>]*>/g, ' ')).replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** Show notes → plain text with paragraph breaks kept. Never HTML: the site shows it as text. */
function notes(s, max) {
  let t = unCdata(s);
  if (!/<[a-z!/]/i.test(t) && /&lt;/i.test(t)) t = entities(t);   // feeds that escape their HTML instead of using CDATA
  t = t.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|h[1-6]|blockquote)>/gi, '\n\n').replace(/<\/(li|tr)>/gi, '\n').replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]*>/g, '');
  t = entities(t).replace(/\r/g, '').replace(/[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029]/g, ' ');
  t = t.split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (t.length > max) t = t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
  return t;
}

/* ---------- xml ---------- */
const esc = t => t.replace(/[:.]/g, m => '\\' + m);
const field = (block, tag) => { const m = block.match(new RegExp(`<${esc(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${esc(tag)}>`, 'i')); return m ? m[1] : ''; };
function attr(block, tag, name) {
  const el = block.match(new RegExp(`<${esc(tag)}\\b[^>]*>`, 'i'));
  if (!el) return '';
  const m = el[0].match(new RegExp(`\\s${esc(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  return m ? entities(m[1] ?? m[2]).trim() : '';
}

/* ---------- links ---------- */
const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost|metadata\.google\.internal)$/i;
const isIpLiteral = h => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || /^\[/.test(h) || /^0x/i.test(h) || /^\d+$/.test(h);

/** A feed address we're willing to fetch from the server, or ''. */
function feedUrl(input) {
  let s = String(input || '').trim().slice(0, 600);
  if (/^feed:\/\//i.test(s)) s = 'https://' + s.slice(7);
  if (/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) return '';
  if (u.port && !['80', '443'].includes(u.port)) return '';
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || PRIVATE_HOST.test(h) || isIpLiteral(h)) return '';
  u.hash = '';
  return u.toString();
}

/** An episode's media link: https only (the site is https), or ''. */
function mediaUrl(input) {
  let s = entities(unCdata(input)).trim();
  if (/^http:\/\//i.test(s)) s = 'https://' + s.slice(7);
  let u;
  try { u = new URL(s); } catch { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password) return '';
  const h = u.hostname.toLowerCase();
  if (!h.includes('.') || PRIVATE_HOST.test(h) || isIpLiteral(h)) return '';
  const out = u.toString();
  return out.length <= 1000 && !/[\s<>"]/.test(out) ? out : '';
}
const imageUrl = s => { const u = mediaUrl(s); return u && u.length <= 600 ? u : ''; };

function durationMins(s) {
  s = line(s, 20);
  let secs = 0;
  if (/^\d+(\.\d+)?$/.test(s)) secs = Number(s);
  else if (/^\d+(:\d{1,2}){1,2}$/.test(s)) secs = s.split(':').map(Number).reduce((a, n) => a * 60 + n, 0);
  if (!secs) return null;
  return Math.max(1, Math.min(600, Math.round(secs / 60)));
}

const refFor = guid => 'r' + crypto.createHash('sha256').update(String(guid)).digest('hex').slice(0, 20);
const REF = /^r[0-9a-f]{20}$/;

/* ---------- the feed ---------- */
/**
 * Feed XML → { title, author, description, image, items[] } (items newest first).
 * Throws a readable Error when it isn't a podcast feed.
 */
function parseFeed(xml, now = Date.now()) {
  if (typeof xml !== 'string' || !xml.trim()) throw new Error('The feed is empty.');
  if (xml.length > MAX_FEED_BYTES) throw new Error('That feed is too big to read.');
  if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) throw new Error('That address isn\'t a podcast RSS feed.');
  const first = xml.search(/<item[\s>]/i);
  const head = first > 0 ? xml.slice(0, first) : xml;
  const headNoImage = head.replace(/<image[\s>][\s\S]*?<\/image>/i, '');
  const feed = {
    title: line(field(headNoImage, 'title'), 80),
    author: line(field(head, 'itunes:author') || field(head, 'itunes:name'), 80),
    description: notes(field(headNoImage, 'description') || field(head, 'itunes:summary'), 800),
    image: imageUrl(attr(head, 'itunes:image', 'href') || field(field(head, 'image'), 'url'))
  };
  const items = [];
  const seen = new Set();
  for (const b of xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || []) {
    let url = attr(b, 'enclosure', 'url'), type = attr(b, 'enclosure', 'type').toLowerCase();
    if (!url) { url = attr(b, 'media:content', 'url'); type = attr(b, 'media:content', 'type').toLowerCase(); }
    const media = mediaUrl(url);
    if (!media) continue;
    const path = media.split('?')[0].toLowerCase();
    const isVideo = /^video\//.test(type) || (!type && /\.(mp4|m4v|mov|webm)$/.test(path));
    const isAudio = /^audio\//.test(type) || (!type && /\.(mp3|m4a|aac|ogg|oga|opus|wav)$/.test(path)) || (/^application\/octet-stream$/.test(type) && /\.(mp3|m4a)$/.test(path));
    if (!isVideo && !isAudio) continue;
    const guid = line(field(b, 'guid'), 300) || media;
    const ref = refFor(guid);
    if (seen.has(ref)) continue;
    seen.add(ref);
    let at = Date.parse(line(field(b, 'pubDate') || field(b, 'dc:date'), 60));
    if (!Number.isFinite(at) || at > now + 864e5) at = null;
    const num = parseInt(line(field(b, 'itunes:episode') || field(b, 'podcast:episode'), 10), 10);
    items.push({
      ref,
      title: line(field(b, 'itunes:title') || field(b, 'title'), 140),
      description: notes(field(b, 'content:encoded') || field(b, 'description') || field(b, 'itunes:summary'), 2000) || null,
      media_url: media,
      kind: isVideo ? 'video' : 'audio',
      number: num > 0 && num <= 9999 ? num : null,
      duration_mins: durationMins(field(b, 'itunes:duration')),
      image: imageUrl(attr(b, 'itunes:image', 'href')) || null,
      published_at: at
    });
  }
  if (!items.length) throw new Error('That feed has no audio or video episodes in it.');
  items.sort((x, y) => (y.published_at || 0) - (x.published_at || 0));
  feed.items = items.slice(0, MAX_ITEMS);
  feed.total = items.length;
  return feed;
}

/** Fetch a feed, following up to 4 redirects and checking each hop. */
async function fetchFeed(url, { fetchImpl = fetch, timeoutMs = 9000 } = {}) {
  let at = feedUrl(url);
  if (!at) throw new Error('That isn\'t a feed address we can read. It should start with https://');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    for (let hop = 0; hop < 5; hop++) {
      let r;
      try {
        r = await fetchImpl(at, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.5' }, redirect: 'manual', signal: ctl.signal });
      } catch (e) { throw new Error(e.name === 'AbortError' ? 'The feed took too long to answer.' : 'Couldn\'t reach that feed.'); }
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers && r.headers.get ? r.headers.get('location') : '';
        const next = loc && feedUrl(new URL(loc, at).toString());
        if (!next) throw new Error('The feed redirected somewhere we won\'t follow.');
        at = next; continue;
      }
      if (!r.ok) throw new Error(`The feed answered with an error (${r.status}).`);
      const len = Number(r.headers && r.headers.get ? r.headers.get('content-length') : 0);
      if (len > MAX_FEED_BYTES) throw new Error('That feed is too big to read.');
      return { xml: await r.text(), url: at };
    }
    throw new Error('The feed redirected too many times.');
  } finally { clearTimeout(timer); }
}

/** Run writes a few at a time. */
async function writeAll(ops, writes, n = 8) {
  for (let i = 0; i < writes.length; i += n) {
    const res = await Promise.all(writes.slice(i, i + n).map(([p, v]) => ops.dbWrite(p, v)));
    const bad = res.find(r => r && r.status >= 400);
    if (bad) throw new Error('db write ' + bad.status);
  }
}

/**
 * Bring a channel up to date with its feed. Pass url (and auto) to connect a
 * feed; leave them out to re-read the one already connected.
 * defaultHost: the name the Studio put in as host, which the feed's author may replace on first connect.
 * Returns { added, refreshed, in_feed, feed_title }.
 */
async function syncChannel(ops, channelId, { url, auto, by = 'team', fetchImpl = fetch, now = Date.now(), newId, defaultHost } = {}) {
  const ch = await ops.dbGet(`flieks_pod_channels/${channelId}`);
  if (!ch) throw new Error('Channel not found.');
  const prev = ch.rss || {};
  const target = feedUrl(url || prev.url);
  if (!target) throw new Error(url ? 'That isn\'t a feed address we can read. It should start with https://' : 'This channel isn\'t connected to a feed.');
  const keepAuto = typeof auto === 'boolean' ? auto : prev.auto !== false;
  const meta = { url: target, auto: keepAuto, by, last_at: now, title: prev.title || null, items_in_feed: prev.items_in_feed || 0,
    last_ok_at: prev.last_ok_at || null, last_error: null, connected_at: prev.connected_at || now };

  let feed;
  try {
    const got = await fetchFeed(target, { fetchImpl });
    feed = parseFeed(got.xml, now);
  } catch (e) {
    if (prev.url || url) await ops.dbWrite(`flieks_pod_channels/${channelId}/rss`, { ...meta, last_error: String(e.message).slice(0, 160) }).catch(() => {});
    throw e;
  }

  const [allEps, skip, privs] = await Promise.all([
    ops.dbGet('flieks_pod_episodes'), ops.dbGet(`flieks_pod_rss_skip/${channelId}`), ops.dbGet('flieks_private')
  ]);
  const mine = Object.entries(allEps || {}).filter(([, e]) => e && e.channel_id === channelId);
  const byRef = new Map(mine.filter(([, e]) => e.source === 'rss' && e.ref).map(([id, e]) => [e.ref, [id, e]]));
  let n = mine.reduce((m, [, e]) => Math.max(m, e.number || 0), 0);
  const writes = [], records = [];
  let refreshed = 0;

  // Existing episodes: only the media link follows the feed.
  for (const it of feed.items) {
    const hit = byRef.get(it.ref);
    if (!hit) continue;
    const [eid] = hit, pv = (privs || {})[`pod_${eid}`] || {};
    const key = it.kind === 'video' ? 'video_url' : 'audio_url';
    if (pv[key] !== it.media_url) { writes.push([`flieks_private/pod_${eid}/${key}`, it.media_url]); refreshed++; }
  }
  // New ones, oldest first so the numbering runs in order.
  const fresh = feed.items.filter(it => !byRef.has(it.ref) && !(skip && skip[it.ref])).reverse();
  const makeId = newId || (() => crypto.randomBytes(6).toString('hex'));
  fresh.forEach((it, i) => {
    const id = makeId();
    const number = it.number || ++n;
    n = Math.max(n, number);
    const rec = { channel_id: channelId, title: it.title || `Episode ${number}`, description: it.description, number,
      kind: it.kind, source: 'rss', ref: it.ref, thumbnail_url: it.image || feed.image || null, duration_mins: it.duration_mins,
      price: 0, status: 'live', created_at: now, updated_at: now, published_at: it.published_at || now + i };
    writes.push([`flieks_private/pod_${id}`, it.kind === 'video' ? { video_url: it.media_url } : { audio_url: it.media_url }]);
    records.push([`flieks_pod_episodes/${id}`, rec]);
  });
  await writeAll(ops, writes);     // media first, so an episode never shows before it can play
  await writeAll(ops, records);

  // Fill in what the channel is missing; never overwrite what someone typed.
  const blanks = [];
  if (!ch.cover_url && feed.image) blanks.push([`flieks_pod_channels/${channelId}/cover_url`, feed.image]);
  if (!ch.description && feed.description) blanks.push([`flieks_pod_channels/${channelId}/description`, feed.description]);
  // The Studio fills the host with the creator's own name; on first connecting, the feed's author is better.
  const hostIsDefault = !ch.host || (!prev.url && defaultHost && ch.host === defaultHost);
  if (hostIsDefault && feed.author && ch.host !== feed.author) blanks.push([`flieks_pod_channels/${channelId}/host`, feed.author]);
  if (records.length) blanks.push([`flieks_pod_channels/${channelId}/updated_at`, now]);
  blanks.push([`flieks_pod_channels/${channelId}/rss`, { ...meta, title: feed.title || null, items_in_feed: feed.total, last_ok_at: now }]);
  await writeAll(ops, blanks);

  return { added: records.length, refreshed, in_feed: feed.total, feed_title: feed.title };
}

/** A quick look before connecting: what the feed is and its newest episodes. */
async function preview(url, { fetchImpl = fetch } = {}) {
  const got = await fetchFeed(url, { fetchImpl });
  const feed = parseFeed(got.xml);
  return { url: got.url, title: feed.title, author: feed.author, image: feed.image, total: feed.total, importing: feed.items.length,
    kinds: [...new Set(feed.items.map(i => i.kind))],
    newest: feed.items.slice(0, 3).map(i => ({ title: i.title, published_at: i.published_at, duration_mins: i.duration_mins })) };
}

module.exports = { MAX_ITEMS, REF, feedUrl, mediaUrl, durationMins, notes, line, refFor, parseFeed, fetchFeed, syncChannel, preview };
