/**
 * og.js — per-film link previews.
 *
 * The site is a single page, so its Open Graph tags are the same for every
 * film. The crawlers that build WhatsApp and Instagram preview cards do not
 * run JavaScript, so they only ever see the generic 4flieks card — whatever
 * film the link actually points at.
 *
 * For a business whose distribution is people posting links, that preview is
 * doing a large share of the selling. This edge function looks the film up by
 * slug and rewrites the tags before the HTML is sent.
 *
 * Deploy to: netlify/edge-functions/og.js
 * and add to netlify.toml:
 *
 *   [[edge_functions]]
 *   function = "og"
 *   path = "/*"
 */

const DB = 'https://flieks-app-default-rtdb.firebaseio.com';

const RESERVED = new Set([
  'index', 'admin', 'filmmaker', 'cast', 'attribution', 'about', 'terms',
  'privacy', 'login', 'signup', 'account', 'assets', 'images', 'static', 'brand'
]);

const esc = s => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export default async (request, context) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/|\/$/g, '');

  // only single-segment paths that could be a film slug
  if (!path || path.includes('/') || path.includes('.') || RESERVED.has(path.toLowerCase())) {
    return;
  }

  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  let film = null;
  try {
    // slug -> id, then the film itself
    const idRes = await fetch(`${DB}/flieks_film_slugs/${encodeURIComponent(path)}.json`);
    const filmId = idRes.ok ? await idRes.json() : null;
    if (!filmId) return response;

    const fRes = await fetch(`${DB}/flieks_films/${encodeURIComponent(filmId)}.json`);
    film = fRes.ok ? await fRes.json() : null;
  } catch {
    return response;               // never break the page over a preview
  }

  if (!film || film.status !== 'live') return response;

  const title = film.title || 'A film on 4flieks';
  const desc  = (film.synopsis || 'Watch it on 4flieks.').slice(0, 200);
  const image = film.og_image || film.still_url || film.poster_url || '';
  const mins  = film.duration_mins ? `${film.duration_mins} min` : '';
  const maker = film.filmmaker ? ` — a film by ${film.filmmaker}` : '';

  const tags = `
<meta property="og:site_name" content="4flieks">
<meta property="og:type" content="video.movie">
<meta property="og:url" content="${esc(url.origin + '/' + path)}">
<meta property="og:title" content="${esc(title + maker)}">
<meta property="og:description" content="${esc(desc)}">
${image ? `<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(title)}">` : ''}
<meta property="og:locale" content="en_ZA">
<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">` : ''}
<meta name="description" content="${esc(desc)}">
<title>${esc(title)}${mins ? ' · ' + mins : ''} · 4flieks</title>
`.trim();

  let html = await response.text();

  // drop the generic tags, then insert the film's own
  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+(?:property|name)="(?:og:|twitter:|description)[^"]*"[^>]*>/gi, '')
    .replace(/<\/head>/i, tags + '\n</head>');

  return new Response(html, {
    status: response.status,
    headers: {
      ...Object.fromEntries(response.headers),
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300'
    }
  });
};

export const config = { path: '/*' };
