/**
 * Lab industry news: feed parsing, the blocked-word rule, link safety and the
 * team-only actions, run against the real function with an in-memory database.
 *   node tests/news.test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('./budget-mocks.cjs');
const { addUser, get, put } = T;
const news = require('../netlify/lib/news-core.js');
const fn = require('../netlify/functions/flieks-news.js');
const refreshFn = require('../netlify/functions/flieks-news-refresh.js');

let failed = 0, passed = 0;
function check(label, cond, extra) { if (cond) { passed++; console.log('PASS ', label); } else { failed++; console.log('FAIL ', label, extra !== undefined ? JSON.stringify(extra).slice(0, 300) : ''); } }
async function api(body) { const r = await fn.handler({ httpMethod: 'POST', body: JSON.stringify(body), headers: {} }); return { status: r.statusCode, d: JSON.parse(r.body || '{}') }; }

addUser('tV', 'viewerVVVVVVVVV');
addUser('tF', 'filmmakerFFFFFF', { role: 'filmmaker' });
addUser('tM', 'adminMMMMMMMMMM', { role: 'admin' });

const now = Date.now();
const rfc = t => new Date(t).toUTCString();
const item = (title, link, at = now - 36e5, extra = '') => `<item><title>${title}</title><link>${link}</link><pubDate>${rfc(at)}</pubDate>${extra}<description><![CDATA[<p>Body text <img src="https://evil/x.png"></p>]]></description></item>`;
const rss = items => `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>${items.join('')}</channel></rss>`;
const FEEDS = {
  'https://www.thecallsheet.co.za/feed/': rss([
    item('NFVF ANNOUNCES &#8220;VARIASIES OP &#8216;N TEMA&#8221; AS SA&#8217;S OFFICIAL OSCARS&#8217; SELECTION', 'https://thecallsheet.co.za/2026/10/01/nfvf-oscars/?utm_source=rss&utm_medium=rss#more'),
    item('Showmax to shut down: what it means for local productions', 'https://thecallsheet.co.za/2026/09/20/streamer-closing/'),
    item('Local streamer news', 'https://thecallsheet.co.za/2026/09/19/show-max-wind-down/'),
    item('<![CDATA[Film students get crash course from industry titans]]>', 'https://thecallsheet.co.za/2026/10/01/students/'),
    item('Evil link elsewhere', 'https://evil.example/phish'),
    item('Script link', 'javascript:alert(1)'),
    item('Plain http link', 'http://thecallsheet.co.za/2026/09/01/http/'),
    item('Too old to show anymore', 'https://thecallsheet.co.za/2025/01/01/old/', now - 400 * 864e5),
    item('</title><script>window.__x=1</script> &lt;img src=x onerror=alert(1)&gt; headline', 'https://thecallsheet.co.za/2026/09/30/xss/'),
    item('Date from the future gets today', 'https://thecallsheet.co.za/2026/09/30/future/', now + 30 * 864e5)
  ]),
  'https://www.nfvf.co.za/feed/': rss([
    item('CALL FOR THE SEVENTH PRESIDENTIAL EMPLOYMENT STIMULUS PROGRAMME (PESP 7) IS OPEN', 'https://www.nfvf.co.za/call-for-pesp-7/'),
    item('NFVF Sediba creative enterprise programme call for applications', 'https://www.nfvf.co.za/sediba/')
  ]),
  'https://www.durbanfilmmart.co.za/feed/': '<html>not a feed</html>',
  'https://visitkzn-sa.com/film/feed/': null   // network failure
};
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  url = String(url);
  if (url in FEEDS) {
    if (FEEDS[url] === null) throw new Error('getaddrinfo ENOTFOUND');
    const body = FEEDS[url];
    return { ok: true, status: 200, headers: { get: () => String(body.length) }, text: async () => body };
  }
  return realFetch(url, opts);
};

/* ---------- pieces ---------- */
check('tag: PESP call is funding', news.tagFor('Call for the seventh PESP') === 'funding');
check('tag: applications are an open call', news.tagFor('Sediba programme call for applications') === 'call');
check('tag: ordinary story is news', news.tagFor('Minister dissolves NFVF council') === 'news');
check('link: javascript refused', news.safeLink('javascript:alert(1)', null) === '');
check('link: http refused', news.safeLink('http://x.co/a', null) === '');
check('link: credentials refused', news.safeLink('https://a:b@thecallsheet.co.za/x', ['thecallsheet.co.za']) === '');
check('link: wrong host refused', news.safeLink('https://evil.example/x', ['thecallsheet.co.za']) === '');
check('link: tracking stripped', news.safeLink('https://thecallsheet.co.za/a/?utm_source=rss&id=3#x', ['thecallsheet.co.za']) === 'https://thecallsheet.co.za/a/?id=3');
check('blocked: Showmax in any spelling', news.blocked('SHOWMAX closes', '') && news.blocked('Show Max', '') && news.blocked('x', 'https://a.co/showmax-x'));
for (const [inp, want] of [
  ['NFVF ANNOUNCES THE OFFICIAL SELECTION FOR THIS YEAR', 'NFVF announces the official selection for this year'],
  ['WATCH GROUNDBREAKING DOCUMENTARY MOTHER CITY AT STER-KINEKOR FOR R50', 'Watch groundbreaking documentary mother city at Ster-Kinekor for R50'],
  ['MINISTER MCKENZIE DISSOLVES NFVF COUNCIL OVER GOVERNANCE CONCERNS', 'Minister Mckenzie dissolves NFVF council over governance concerns'],
  ['Durban FilmMart Welcomes Canadian Delegation', 'Durban FilmMart Welcomes Canadian Delegation']]) {
  check('title: ' + want, news.tidyTitle(inp) === want, news.tidyTitle(inp));
}
check('parse: huge feed refused', news.parseFeed('x'.repeat(2e6), news.SOURCES[0]).length === 0);
check('parse: garbage is empty, no throw', news.parseFeed('<rss><item><title>', news.SOURCES[0]).length === 0);

/* ---------- refresh ---------- */
put('flieks_news/hidden/' + news.idFor('https://www.nfvf.co.za/sediba/'), true);
put('flieks_news/items/n0000000000000001', { title: 'Old Showmax story already stored', link: 'https://thecallsheet.co.za/old/', source: 'callsheet', at: now - 864e5, tag: 'news' });
const r0 = await refreshFn.handler({});
check('scheduled refresh runs', r0.statusCode === 200);
const stored = Object.values(get('flieks_news/items') || {});
const titles = stored.map(i => i.title);
check('refresh: good stories stored (a headline that breaks out of <title> is dropped)', stored.length === 4, titles);
check('refresh: no Showmax story stored (feed or already stored)', !titles.some(t => /show\s*max/i.test(t)) && !stored.some(i => /show-?max/i.test(i.link)));
check('refresh: off-site, javascript and http links dropped', stored.every(i => i.link.startsWith('https://thecallsheet.co.za/') || i.link.startsWith('https://www.nfvf.co.za/')));
check('refresh: old story dropped', !titles.some(t => /Too old/.test(t)));
check('refresh: hidden story stays hidden', !stored.some(i => i.link === 'https://www.nfvf.co.za/sediba/'));
check('refresh: entities decoded, no markup kept', titles.some(t => t.includes('“Variasies op ‘n tema” as SA’s official Oscars’ selection')) && !titles.some(t => /[<>]/.test(t)), titles);
check('refresh: future date clamped', stored.every(i => i.at <= Date.now() + 1000));
check('refresh: tracking params stripped', stored.every(i => !/utm_|#/.test(i.link)));
const meta = get('flieks_news/meta');
check('meta: broken feeds reported, not fatal', meta.sources.callsheet.ok && meta.sources.nfvf.ok && meta.sources.dfm.ok && meta.sources.dfm.count === 0 && !meta.sources.kznfilm.ok, meta);

/* ---------- list ---------- */
const l = await api({ action: 'list' });
check('list: anyone can read', l.status === 200 && l.d.items.length === 4 && l.d.admin === false);
check('list: only public fields', l.d.items.every(i => Object.keys(i).sort().join() === 'at,id,link,source,tag,title'));
check('list: says when the feeds were last read', l.d.updated > 0 && l.d.updated <= Date.now());
check('list: newest first', l.d.items.every((x, i, a) => !i || a[i - 1].at >= x.at));
check('list: source names, not ids', l.d.items.every(i => ['The Callsheet', 'NFVF'].includes(i.source)));
const opps = await api({ action: 'list', tag: 'opps' });
check('list: opps = funding and calls only', opps.d.items.length >= 1 && opps.d.items.every(i => i.tag !== 'news'));
check('list: limit capped', (await api({ action: 'list', limit: 9999 })).d.items.length <= 40 && (await api({ action: 'list', limit: 2 })).d.items.length === 2);
check('list: bad tag ignored', (await api({ action: 'list', tag: '../x' })).d.items.length === 4);
check('list: admin flag only for admins', (await api({ action: 'list', token: 'tF' })).d.admin === false && (await api({ action: 'list', token: 'bogus' })).d.admin === false);

/* ---------- team only ---------- */
for (const [tok, who] of [[undefined, 'signed out'], ['tV', 'viewer'], ['tF', 'filmmaker'], ['bogus', 'bad token']]) {
  const res = await Promise.all(['hide', 'add', 'refresh', 'status'].map(a => api({ action: a, token: tok, id: stored[0].id, title: 'A real headline', link: 'https://x.co/a' })));
  check(`team actions refused for ${who}`, res.every(r => r.status === 403), res.map(r => r.status));
}
check('unknown action refused', (await api({ action: 'drop', token: 'tM' })).status === 400);
check('GET refused', (await fn.handler({ httpMethod: 'GET', headers: {} })).statusCode === 405);
check('bad JSON refused', (await fn.handler({ httpMethod: 'POST', body: '{', headers: {} })).statusCode === 400);

const victim = l.d.items[0];
check('hide: bad id refused', (await api({ action: 'hide', token: 'tM', id: '../../flieks_films' })).status === 404 && get('flieks_films') === null);
const h = await api({ action: 'hide', token: 'tM', id: victim.id });
check('hide: works for admin', h.status === 200 && get(`flieks_news/hidden/${victim.id}`) === true && !get(`flieks_news/items/${victim.id}`));
check('hide: gone from list at once', !(await api({ action: 'list' })).d.items.some(i => i.id === victim.id));
await refreshFn.handler({});
check('hide: refresh does not bring it back', !get(`flieks_news/items/${victim.id}`));

check('add: javascript link refused', (await api({ action: 'add', token: 'tM', title: 'A real headline', link: 'javascript:alert(1)' })).status === 400);
check('add: http link refused', (await api({ action: 'add', token: 'tM', title: 'A real headline', link: 'http://x.co/a' })).status === 400);
check('add: Showmax refused even by admin', (await api({ action: 'add', token: 'tM', title: 'Showmax news', link: 'https://x.co/a' })).status === 400);
check('add: needs a headline', (await api({ action: 'add', token: 'tM', title: 'x', link: 'https://x.co/a' })).status === 400);
const ad = await api({ action: 'add', token: 'tM', title: 'Gauteng Film Commission opens bursary applications\n<script>', link: 'https://www.gfc.gov.za/bursary', tag: 'call' });
const added = get(`flieks_news/items/${ad.d.id}`);
check('add: stored, cleaned, tagged', ad.status === 200 && added.manual && added.tag === 'call' && !/[\n]/.test(added.title) && added.source === 'team');
check('add: shows in list as 4flieks', (await api({ action: 'list' })).d.items.some(i => i.id === ad.d.id && i.source === '4flieks'));
await refreshFn.handler({});
check('add: survives a refresh', !!get(`flieks_news/items/${ad.d.id}`));

/* A bad row written straight into the database still can't reach the page. */
put('flieks_news/items/n00000000000000ff', { title: 'x<img>', link: 'javascript:alert(1)', source: 'evil', at: now, tag: '<b>' });
put('flieks_news/items/bad-id', { title: 'Wrong id', link: 'https://x.co', source: 'team', at: now, tag: 'news' });
const fresh = require('../netlify/functions/flieks-news.js');
// the instance cache is cleared by any team write
await api({ action: 'add', token: 'tM', title: 'Cache buster headline', link: 'https://x.co/cache' });
const l2 = (await api({ action: 'list', limit: 40 })).d.items;
check('list: bad stored rows never sent', !l2.some(i => i.id === 'n00000000000000ff' || i.id === 'bad-id' || /javascript/.test(i.link)));
check('list: tags always known', l2.every(i => news.TAGS.includes(i.tag)));

const st = await api({ action: 'status', token: 'tM' });
check('status: admin sees feeds and hidden count', st.status === 200 && st.d.hidden >= 2 && st.d.sources.length === 4 && st.d.meta.at > 0);
for (let i = 0; i < 10; i++) await api({ action: 'refresh', token: 'tM' });
check('refresh: rate limited at 10 an hour', (await api({ action: 'refresh', token: 'tM' })).status === 429);
T.setFailCounters(true);
check('refresh: limit fails closed', (await api({ action: 'refresh', token: 'tM' })).status === 429);
T.setFailCounters(false);
void fresh;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
