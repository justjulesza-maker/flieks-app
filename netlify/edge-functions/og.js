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
    // A link may carry a slug or, if none has been set, the raw film id.
    const idRes = await fetch(`${DB}/flieks_film_slugs/${encodeURIComponent(path)}.json`);
    const fromSlug = idRes.ok ? await idRes.json() : null;
    const filmId = fromSlug || path;

    const fRes = await fetch(`${DB}/flieks_films/${encodeURIComponent(filmId)}.json`);
    film = fRes.ok ? await fRes.json() : null;
  } catch {
    return response;               // never break the page over a preview
  }

  if (!film || film.status !== 'live') return response;

  const title = film.title || 'A film on 4flieks';

  /* Cutting at a fixed character count leaves previews ending mid-word, which
     reads as carelessness in the one place a filmmaker's work is being sold. */
  const trim = (text, max) => {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    // Prefer ending on a sentence; failing that, on a whole word.
    if (stop > max * 0.55) return cut.slice(0, stop + 1);
    return cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:—-]$/, '') + '…';
  };

  const desc = trim(film.synopsis || 'Watch it on 4flieks.', 200);
  const image = film.og_image || film.still_url || film.poster_url || '';
  // A 9:16 poster is fine but crops oddly in a wide card; a 16:9 still is better.
  const wideImage = !!(film.og_image || film.still_url);
  const mins  = film.duration_mins ? `${film.duration_mins} min` : '';

  if (!wideImage && image) {
    // A 9:16 poster crops badly in a wide card and is often too large for
    // WhatsApp to fetch. The portal's Link Preview Image fixes both.
    console.log(`[og] ${path}: no og_image, falling back to the poster`);
  }
  const maker = film.filmmaker ? ` — a film by ${film.filmmaker}` : '';

  const tags = `
<meta property="og:site_name" content="4flieks">
<meta property="og:type" content="video.movie">
<meta property="og:url" content="${esc(url.origin + '/' + path)}">
<meta property="og:title" content="${esc(title + maker)}">
<meta property="og:description" content="${esc(desc)}">
${image ? `<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(
  film.filmmaker ? `${title} — a film by ${film.filmmaker}` : `Poster for ${title}`)}">
<meta property="og:image:width" content="${wideImage ? 1200 : 1080}">
<meta property="og:image:height" content="${wideImage ? 630 : 1920}">` : ''}
<meta property="og:locale" content="en_ZA">
<meta name="twitter:card" content="${wideImage ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
${image ? `<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:image:alt" content="${esc(title)}">` : ''}
<meta name="description" content="${esc(desc)}">
<title>${esc(title)}${mins ? ' · ' + mins : ''} · 4flieks</title>
`.trim();

  let html = await response.text();

  // drop the generic tags, then insert the film's own
  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+(?:property|name)="(?:og:|twitter:|description)[^"]*"[^>]*>/gi, '')
    .replace(/<\/head>/i, tags + '\n</head>');

  /* Build the headers fresh rather than copying the original's.
     The body has been rewritten, so content-length and content-encoding from
     the upstream response now describe something that no longer exists —
     browsers shrug at that, stricter scrapers report a bad response. */
  const headers = new Headers();
  for (const [k, v] of response.headers) {
    const key = k.toLowerCase();
    if (key === 'content-length' || key === 'content-encoding' ||
        key === 'transfer-encoding' || key === 'content-type') continue;
    headers.set(k, v);
  }
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'public, max-age=300');

  return new Response(html, { status: 200, statusText: 'OK', headers });
};

export const config = { path: '/*' };
