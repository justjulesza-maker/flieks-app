/**
 * sitemap — tells search engines which films exist, generated from the database.
 *
 * A static sitemap.xml goes stale the moment a film is added or taken down.
 * This reads the catalogue on request, so it is right by construction.
 *
 * Served at /sitemap.xml via _redirects.
 */
const https = require('https');

const DB = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SITE = 'https://4flieks.com';

function get(path) {
  return new Promise(resolve => {
    https.get(`${DB}/${path}.json`, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

const esc = s => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

exports.handler = async () => {
  const films = (await get('flieks_films')) || {};

  const urls = [
    { loc: SITE + '/', priority: '1.0', freq: 'daily' },
    { loc: SITE + '/terms', priority: '0.3', freq: 'yearly' },
    { loc: SITE + '/help', priority: '0.4', freq: 'monthly' },
    { loc: SITE + '/filmmaker', priority: '0.6', freq: 'monthly' }
  ];

  Object.entries(films).forEach(([id, f]) => {
    // Only what a visitor can actually watch. Listing drafts wastes crawl
    // budget and puts dead pages in results.
    if (!f || f.status !== 'live') return;
    const slug = f.slug || id;
    urls.push({
      loc: `${SITE}/${encodeURIComponent(slug)}`,
      priority: f.featured ? '0.9' : '0.8',
      freq: 'weekly',
      lastmod: f.published_at
        ? new Date(f.published_at).toISOString().slice(0, 10)
        : undefined,
      image: f.og_image || f.poster_url || null,
      title: f.title || ''
    });
  });

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map(u => `  <url>
    <loc>${esc(u.loc)}</loc>${u.lastmod ? `
    <lastmod>${u.lastmod}</lastmod>` : ''}
    <changefreq>${u.freq}</changefreq>
    <priority>${u.priority}</priority>${u.image ? `
    <image:image>
      <image:loc>${esc(u.image)}</image:loc>
      <image:title>${esc(u.title)}</image:title>
    </image:image>` : ''}
  </url>`).join('\n')}
</urlset>`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    },
    body
  };
};
