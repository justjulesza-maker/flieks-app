/**
 * Podcast RSS import: feed parsing, connecting a feed in the Studio, re-reading
 * it (no repeats, edits kept, deleted episodes stay gone), the scheduled sync,
 * who may do what, and addresses we refuse to fetch.
 *   node tests/podcast-rss.test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('./budget-mocks.cjs');
const { addUser, get, put } = T;
const RSS = require('../netlify/lib/podcast-rss.js');
const fn = require('../netlify/functions/flieks-podcasts.js');
const scheduled = require('../netlify/functions/flieks-podcasts-rss.js');

let failed = 0, passed = 0;
function check(label, cond, extra) { if (cond) { passed++; console.log('PASS ', label); } else { failed++; console.log('FAIL ', label, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); } }
async function api(body) { const r = await fn.handler({ httpMethod: 'POST', body: JSON.stringify(body), headers: {} }); return { status: r.statusCode, d: JSON.parse(r.body || '{}') }; }

addUser('tV', 'viewerVVVVVVVVV');
addUser('tF', 'filmmakerFFFFFF', { role: 'filmmaker' });
addUser('tF2', 'filmmakerGGGGGG', { role: 'filmmaker' });
addUser('tM', 'adminMMMMMMMMMM', { role: 'admin' });

/* A feed shaped exactly like media.rss.com's (The Video Store). */
const FEED_URL = 'https://media.rss.com/thevideostore/feed.xml';
const item = (n, day, extra = '') => `
    <item>
      <title><![CDATA[Episode ${n} title & more]]></title>
      <itunes:title><![CDATA[Episode ${n} title & more]]></itunes:title>
      <description><![CDATA[<p>Russell does a shift with Gad.</p><p><strong>Hey did you guys see….</strong></p><p>Avengers <a href="https://x.example/">highest grossing</a> ever… again.</p><script>alert(1)</script><p><img src=x onerror=alert(1)>Contact us</p>]]></description>
      <link>https://rss.com/podcasts/thevideostore/${3200000 + n}</link>
      <enclosure url="https://content.rss.com/episodes/132395/${3200000 + n}/thevideostore/ep${n}.mp3" length="98358795" type="audio/mpeg"/>
      <guid isPermaLink="false">guid-${n}</guid>
      <itunes:duration>${n === 243 ? '6147' : '1:28:36'}</itunes:duration>
      <itunes:episodeType>full</itunes:episodeType>
      <itunes:episode>${n}</itunes:episode>
      <pubDate>${new Date(Date.UTC(2026, 8, day, 3)).toUTCString()}</pubDate>
      <itunes:image href="https://media.rss.com/thevideostore/ep_cover_${n}.jpg"/>${extra}
    </item>`;
const feed = items => `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="https://media.rss.com/style.xsl"?>
<rss xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" xml:lang="en" version="2.0">
  <channel>
    <title><![CDATA[The Video Store]]></title>
    <link>https://rss.com/podcasts/thevideostore</link>
    <description><![CDATA[<p>A weekly chat amongst friends working a shift at your local video store.</p>]]></description>
    <itunes:image href="https://media.rss.com/thevideostore/cover.jpg"/>
    <image><url>https://media.rss.com/thevideostore/cover.jpg</url><title>The Video Store IMAGE</title><link>https://rss.com/podcasts/thevideostore</link></image>
    <itunes:author>Red Team Go</itunes:author>
    <itunes:owner><itunes:name>Red Team Go</itunes:name></itunes:owner>
    ${items.join('')}
  </channel>
</rss>`;

let FEEDS = { [FEED_URL]: feed([item(243, 29), item(242, 22), item(241, 15)]) };
const fetched = [];
const mockFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith('https://media.rss.com/') || url.startsWith('https://feeds.example/') || url.startsWith('http://feeds.example/')) {
    fetched.push(url);
    if (url === 'http://feeds.example/moved') return { ok: false, status: 301, headers: new Map([['location', FEED_URL]]), text: async () => '' };
    if (url === 'https://feeds.example/evil-redirect') return { ok: false, status: 302, headers: new Map([['location', 'http://169.254.169.254/latest/meta-data/']]), text: async () => '' };
    if (url === 'https://feeds.example/html') return { ok: true, status: 200, headers: new Map(), text: async () => '<html><body>Not a feed</body></html>' };
    if (!(url in FEEDS)) return { ok: false, status: 404, headers: new Map(), text: async () => 'nope' };
    return { ok: true, status: 200, headers: new Map(), text: async () => FEEDS[url] };
  }
  return mockFetch(url, opts);
};

/* ---------- parsing ---------- */
const f = RSS.parseFeed(FEEDS[FEED_URL]);
check('channel title (not the <image> title)', f.title === 'The Video Store', f.title);
check('channel author and cover', f.author === 'Red Team Go' && f.image === 'https://media.rss.com/thevideostore/cover.jpg', f);
check('channel description is plain text', f.description === 'A weekly chat amongst friends working a shift at your local video store.', f.description);
check('three episodes, newest first', f.items.length === 3 && f.items[0].number === 243 && f.items[2].number === 241, f.items.map(i => i.number));
const i0 = f.items[0];
check('episode title decoded from CDATA', i0.title === 'Episode 243 title & more', i0.title);
check('audio from the enclosure', i0.kind === 'audio' && i0.media_url === 'https://content.rss.com/episodes/132395/3200243/thevideostore/ep243.mp3', i0);
check('duration in seconds → minutes', i0.duration_mins === 102, i0.duration_mins);
check('duration h:mm:ss → minutes', f.items[1].duration_mins === 89, f.items[1].duration_mins);
check('episode picture', i0.image === 'https://media.rss.com/thevideostore/ep_cover_243.jpg');
check('show notes: paragraphs kept, no HTML, no script', i0.description.startsWith('Russell does a shift with Gad.\n\nHey did you guys see….') && !/[<>]/.test(i0.description) && !/alert/.test(i0.description), i0.description);
check('date parsed', i0.published_at === Date.UTC(2026, 8, 29, 3));
check('escaped-HTML show notes are cleaned too', RSS.notes('&lt;p&gt;One&lt;/p&gt;&lt;p&gt;Two &amp;amp; three&lt;/p&gt;', 100) === 'One\n\nTwo & three', RSS.notes('&lt;p&gt;One&lt;/p&gt;&lt;p&gt;Two &amp;amp; three&lt;/p&gt;', 100));
check('video enclosure → video', RSS.parseFeed(feed([item(1, 1).replace('audio/mpeg', 'video/mp4').replace('ep1.mp3', 'ep1.mp4')])).items[0].kind === 'video');
check('http media is upgraded to https', RSS.parseFeed(feed([item(1, 1).replace('https://content.rss.com', 'http://content.rss.com')])).items[0].media_url.startsWith('https://content.rss.com/'));
check('item with no enclosure is skipped', RSS.parseFeed(feed([item(1, 1), item(2, 2).replace(/<enclosure[^>]*>/, '')])).items.length === 1);
check('PDF enclosure is skipped', (() => { try { return RSS.parseFeed(feed([item(1, 1).replace('audio/mpeg', 'application/pdf')])).items.length === 0; } catch (e) { return /no audio or video/.test(e.message); } })());
check('javascript: media link refused', (() => { try { RSS.parseFeed(feed([item(1, 1).replace(/url="[^"]+"/, 'url="javascript:alert(1)"')])); return false; } catch (e) { return true; } })());
check('HTML page is not a feed', (() => { try { RSS.parseFeed('<html><body>hi</body></html>'); return false; } catch (e) { return /isn't a podcast RSS feed/.test(e.message); } })());
check('feedUrl refuses localhost / IPs / odd ports', ['http://localhost/feed', 'http://169.254.169.254/x', 'https://10.0.0.1/f', 'https://example.com:8080/f', 'file:///etc/passwd', 'https://[::1]/x', 'https://user:pw@example.com/f'].every(u => RSS.feedUrl(u) === ''));
check('feedUrl accepts feed:// and bare addresses', RSS.feedUrl('feed://media.rss.com/x/feed.xml') === 'https://media.rss.com/x/feed.xml' && RSS.feedUrl('media.rss.com/x/feed.xml') === 'https://media.rss.com/x/feed.xml');
check('300 newest only from a huge feed', RSS.parseFeed(feed(Array.from({ length: 320 }, (_, k) => item(k + 1, 1 + (k % 28))))).items.length === 300);

/* ---------- Studio ---------- */
const mk = await api({ action: 'save-channel', token: 'tM', channel: { title: 'The Video Store' } });
const CH = mk.d.id;
check('admin channel created live', mk.status === 200 && get(`flieks_pod_channels/${CH}/status`) === 'live', mk);

let r = await api({ action: 'rss-preview', token: 'tV', url: FEED_URL });
check('viewer cannot preview a feed', r.status === 403, r);
r = await api({ action: 'rss-preview', token: 'tM', url: FEED_URL });
check('preview: title, count, newest', r.status === 200 && r.d.feed.title === 'The Video Store' && r.d.feed.total === 3 && r.d.feed.newest[0].title === 'Episode 243 title & more', r.d);
r = await api({ action: 'rss-preview', token: 'tM', url: 'https://feeds.example/html' });
check('preview of a web page explains itself', r.status === 400 && /isn't a podcast RSS feed/.test(r.d.message), r.d);
r = await api({ action: 'rss-preview', token: 'tM', url: 'https://feeds.example/evil-redirect' });
check('redirect to an internal address is refused', r.status === 400 && /redirected/.test(r.d.message) && !fetched.some(u => u.includes('169.254')), r.d);
r = await api({ action: 'rss-preview', token: 'tM', url: 'http://feeds.example/moved' });
check('normal redirect followed', r.status === 200 && r.d.feed.url === FEED_URL, r.d);

r = await api({ action: 'rss-connect', token: 'tF', channelId: CH, url: FEED_URL });
check('another filmmaker cannot connect a feed to my channel', r.status === 404, r);

r = await api({ action: 'rss-connect', token: 'tM', channelId: CH, url: FEED_URL, auto: true });
check('connect imports 3 episodes', r.status === 200 && r.d.added === 3 && r.d.feed_title === 'The Video Store', r.d);
const eps = () => Object.entries(get('flieks_pod_episodes') || {}).filter(([, e]) => e.channel_id === CH);
let list = eps();
check('episodes stored as live, free, rss', list.length === 3 && list.every(([, e]) => e.source === 'rss' && e.status === 'live' && e.price === 0 && e.kind === 'audio'), list);
check('feed numbering kept', list.map(([, e]) => e.number).sort().join() === '241,242,243');
check('published dates from the feed', list.find(([, e]) => e.number === 241)[1].published_at === Date.UTC(2026, 8, 15, 3));
const [e243id, e243] = list.find(([, e]) => e.number === 243);
check('media link private, not on the episode', get(`flieks_private/pod_${e243id}/audio_url`) === 'https://content.rss.com/episodes/132395/3200243/thevideostore/ep243.mp3' && !JSON.stringify(e243).includes('content.rss.com'));
const ch1 = get(`flieks_pod_channels/${CH}`);
check('channel blanks filled from the feed', ch1.cover_url === 'https://media.rss.com/thevideostore/cover.jpg' && ch1.host === 'Red Team Go' && /video store/.test(ch1.description), ch1);
check('feed saved on the channel', ch1.rss && ch1.rss.url === FEED_URL && ch1.rss.auto === true && ch1.rss.items_in_feed === 3 && !ch1.rss.last_error, ch1.rss);

// Public: catalogue and channel page show it; play needs an account and plays from rss.com
r = await api({ action: 'channel', slug: ch1.slug });
check('public channel page lists 3, no media links', r.status === 200 && r.d.episodes.length === 3 && !JSON.stringify(r.d).includes('content.rss.com') && !JSON.stringify(r.d).includes('"ref"'), r.d);
r = await api({ action: 'play', episodeId: e243id });
check('play needs an account', r.status === 401);
r = await api({ action: 'play', token: 'tV', episodeId: e243id });
check('viewer gets the audio player from rss.com', r.status === 200 && r.d.player.type === 'audio' && r.d.player.url.endsWith('/ep243.mp3'), r.d);

// Re-read: no repeats; edits kept; new episode added; moved file followed
await api({ action: 'save-episode', token: 'tM', episode: { id: e243id, channel_id: CH, title: 'Wonka (edited)', number: 243, price: 0, status: 'live' } });
FEEDS[FEED_URL] = feed([item(244, 6 + 30).replace('ep244.mp3', 'ep244.mp3'), item(243, 29).replace('ep243.mp3', 'ep243-v2.mp3'), item(242, 22), item(241, 15)]);
r = await api({ action: 'rss-sync', token: 'tM', channelId: CH });
check('sync adds only the new one', r.status === 200 && r.d.added === 1 && r.d.refreshed === 1, r.d);
list = eps();
check('4 episodes, no duplicates', list.length === 4 && new Set(list.map(([, e]) => e.ref)).size === 4);
check('my edit survived the sync', get(`flieks_pod_episodes/${e243id}/title`) === 'Wonka (edited)');
check('moved file followed', get(`flieks_private/pod_${e243id}/audio_url`).endsWith('ep243-v2.mp3'));

// Deleted stays deleted
const [e241id] = list.find(([, e]) => e.number === 241);
await api({ action: 'delete-episode', token: 'tM', id: e241id });
await api({ action: 'delete-episode', token: 'tM', id: e241id });
r = await api({ action: 'rss-sync', token: 'tM', channelId: CH });
check('deleted episode does not come back', r.d.added === 0 && eps().length === 3 && !eps().some(([, e]) => e.number === 241), r.d);

// Scheduled
FEEDS[FEED_URL] = feed([item(245, 6 + 37), item(244, 36), item(243, 29), item(242, 22), item(241, 15)]);
await scheduled.handler();
check('scheduled sync brings in the new episode', eps().length === 4 && eps().some(([, e]) => e.number === 245) && get(`flieks_pod_channels/${CH}/rss/by`) === 'schedule');
await api({ action: 'rss-set', token: 'tM', channelId: CH, auto: false });
FEEDS[FEED_URL] = feed([item(246, 6 + 44), item(245, 43)]);
await scheduled.handler();
check('auto off: schedule leaves it alone', eps().length === 4);
r = await api({ action: 'rss-sync', token: 'tM', channelId: CH });
check('…but Check now still works', r.d.added === 1 && eps().length === 5, r.d);

// Feed breaks: error recorded, nothing lost
FEEDS[FEED_URL] = '<html>maintenance</html>';
r = await api({ action: 'rss-sync', token: 'tM', channelId: CH });
check('broken feed: readable error, episodes kept', r.status === 400 && eps().length === 5 && /isn't a podcast RSS feed/.test(get(`flieks_pod_channels/${CH}/rss/last_error`)), r.d);

// Filmmaker's own channel; numbering without itunes:episode
const mk2 = await api({ action: 'save-channel', token: 'tF2', channel: { title: 'Indie Talk', description: 'Mine', host: 'Me' } });
FEEDS['https://feeds.example/indie.xml'] = feed([item(3, 3), item(2, 2), item(1, 1)].map(x => x.replace(/<itunes:episode>\d+<\/itunes:episode>/, '')));
r = await api({ action: 'rss-connect', token: 'tF2', channelId: mk2.d.id, url: 'https://feeds.example/indie.xml' });
const ind = Object.values(get('flieks_pod_episodes')).filter(e => e.channel_id === mk2.d.id);
check('filmmaker connects own (pending) channel; numbered oldest-first', r.status === 200 && ind.length === 3 && ind.find(e => e.title.startsWith('Episode 1 '))?.number === 1 && ind.find(e => e.title.startsWith('Episode 3 '))?.number === 3, ind.map(e => [e.title, e.number]));
const c2 = get(`flieks_pod_channels/${mk2.d.id}`);
check('typed channel details not overwritten', c2.description === 'Mine' && c2.host === 'Me' && c2.status === 'pending', c2);

// Disconnect keeps episodes
r = await api({ action: 'rss-set', token: 'tF2', channelId: mk2.d.id, disconnect: true });
check('disconnect: feed gone, episodes stay', r.status === 200 && !get(`flieks_pod_channels/${mk2.d.id}/rss`) && Object.values(get('flieks_pod_episodes')).filter(e => e.channel_id === mk2.d.id).length === 3);
r = await api({ action: 'rss-sync', token: 'tF2', channelId: mk2.d.id });
check('sync without a feed explains itself', r.status === 400 && /isn't connected/.test(r.d.message));

// Delete channel clears the skip list
await api({ action: 'delete-channel', token: 'tM', id: CH });
check('deleting the channel clears its skip list', !get(`flieks_pod_rss_skip/${CH}`) && !eps().length);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
