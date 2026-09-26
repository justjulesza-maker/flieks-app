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

/* Swap the page's generic tags for these. */
async function withTags(response, tags) {
  let html = await response.text();
  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+(?:property|name)="(?:og:|twitter:|description)[^"]*"[^>]*>/gi, '')
    .replace(/<\/head>/i, tags + '\n</head>');
  const headers = new Headers();
  for (const [k, v] of response.headers) {
    const key = k.toLowerCase();
    if (['content-length', 'content-encoding', 'transfer-encoding', 'content-type'].includes(key)) continue;
    headers.set(k, v);
  }
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'public, max-age=300');
  return new Response(html, { status: 200, statusText: 'OK', headers });
}

/* A filmmaker's page (4flieks.com/by/<slug>): name, bio, their latest poster. */
async function makerPreview(request, context, url, slug) {
  const response = await context.next();
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;
  let page = null, poster = '';
  try {
    const r = await fetch(`${url.origin}/.netlify/functions/flieks-follow?slug=${encodeURIComponent(slug)}`);
    page = r.ok ? (await r.json()).page : null;
    if (page && page.films && page.films[0]) {
      const f = await (await fetch(`${DB}/flieks_films/${encodeURIComponent(page.films[0])}.json`)).json();
      poster = (f && (f.og_image || f.still_url || f.poster_url)) || '';
    }
  } catch { return response; }
  if (!page) return response;
  const n = (page.films || []).length;
  const title = `${page.name} · filmmaker on 4flieks`;
  const desc = page.bio ? page.bio.slice(0, 200) : `${n} film${n === 1 ? '' : 's'} by ${page.name}${page.location ? ', ' + page.location : ''}. Watch on 4flieks.`;
  return withTags(response, `
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:site_name" content="4flieks">
<meta property="og:type" content="profile">
<meta property="og:url" content="${esc(url.origin + url.pathname)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
${poster ? `<meta property="og:image" content="${esc(poster)}">` : ''}
<meta name="twitter:card" content="${poster ? 'summary_large_image' : 'summary'}">`);
}

/* A list page (4flieks.com/list/<slug>): its title, description and the first film's poster. */
async function listPreview(request, context, url, slug) {
  const response = await context.next();
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;
  let list = null, poster = '';
  try {
    const r = await fetch(`${url.origin}/.netlify/functions/flieks-lists?slug=${encodeURIComponent(slug)}`);
    list = r.ok ? (await r.json()).list : null;
    if (list && list.films && list.films[0]) {
      const f = await (await fetch(`${DB}/flieks_films/${encodeURIComponent(list.films[0])}.json`)).json();
      poster = (f && (f.og_image || f.still_url || f.poster_url)) || '';
    }
  } catch { return response; }
  if (!list) return response;
  const n = (list.films || []).length;
  const title = `${list.title} · a list of ${n} film${n === 1 ? '' : 's'} on 4flieks`;
  const desc = list.description || `${n} African independent film${n === 1 ? '' : 's'}, chosen by 4flieks.`;
  const tags = `
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:site_name" content="4flieks">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(url.origin + url.pathname)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
${poster ? `<meta property="og:image" content="${esc(poster)}">` : ''}
<meta name="twitter:card" content="${poster ? 'summary_large_image' : 'summary'}">`;
  let html = await response.text();
  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+(?:property|name)="(?:og:|twitter:|description)[^"]*"[^>]*>/gi, '')
    .replace(/<\/head>/i, tags + '\n</head>');
  const headers = new Headers();
  for (const [k, v] of response.headers) {
    const key = k.toLowerCase();
    if (['content-length', 'content-encoding', 'transfer-encoding', 'content-type'].includes(key)) continue;
    headers.set(k, v);
  }
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'public, max-age=300');
  return new Response(html, { status: 200, statusText: 'OK', headers });
}

export default async (request, context) => {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/|\/$/g, '');

  const listMatch = path.match(/^list\/([a-z0-9-]{1,80})$/);
  if (listMatch) return listPreview(request, context, url, listMatch[1]);
  const byMatch = path.match(/^by\/([a-z0-9-]{1,60})$/);
  if (byMatch) return makerPreview(request, context, url, byMatch[1]);

  // only single-segment paths that could be a film slug
  if (!path || path.includes('/') || path.includes('.') || RESERVED.has(path.toLowerCase())) {
    return;
  }

  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return response;

  let film = null, cast = null;
  try {
    // A link may carry a slug or, if none has been set, the raw film id.
    const idRes = await fetch(`${DB}/flieks_film_slugs/${encodeURIComponent(path)}.json`);
    const fromSlug = idRes.ok ? await idRes.json() : null;
    const filmId = fromSlug || path;

    const fRes = await fetch(`${DB}/flieks_films/${encodeURIComponent(filmId)}.json`);
    film = fRes.ok ? await fRes.json() : null;

    const cRes = await fetch(`${DB}/flieks_cast/${encodeURIComponent(filmId)}.json`);
    cast = cRes.ok ? await cRes.json() : null;
  } catch {
    return response;               // never break the page over a preview
  }

  // Coming-soon films get a preview too: their links are shared before release.
  if (!film || (film.status !== 'live' && film.status !== 'soon')) return response;
  const soon = film.status === 'soon';

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
  const maker = (film.filmmaker ? ` — a film by ${film.filmmaker}` : '') + (film.premiere ? ' · Exclusive trailer, only on 4flieks' : soon ? ' · Coming soon to 4flieks' : '');

  /* ---------- structured data ----------
     Google renders ratings, runtime and price directly in results for a film
     that declares them properly. Ours come from people who actually paid,
     which is worth more than the aggregate on most film sites. */
  const people = Object.values(cast || {});
  const actors = people.filter(p => p && (p.kind || 'cast') === 'cast' && p.name);
  const crew   = people.filter(p => p && p.kind === 'crew' && p.name);
  const director = crew.find(p => /director/i.test(p.role || '') && !/photograph/i.test(p.role || ''));

  const ld = {
    '@context': 'https://schema.org',
    '@type': film.duration_mins && film.duration_mins > 40 ? 'Movie' : 'ShortFilm',
    name: title,
    description: desc,
    url: `${url.origin}/${path}`,
    inLanguage: film.language || 'en-ZA',
    countryOfOrigin: { '@type': 'Country', name: 'South Africa' }
  };
  if (image) ld.image = image;
  if (film.duration_mins) ld.duration = `PT${Math.round(film.duration_mins)}M`;
  if (film.published_at) ld.datePublished = new Date(film.published_at).toISOString().slice(0, 10);
  if (Array.isArray(film.genre) && film.genre.length) ld.genre = film.genre;

  if (director || film.filmmaker) {
    ld.director = { '@type': 'Person', name: (director && director.name) || film.filmmaker };
  }
  if (actors.length) {
    ld.actor = actors.slice(0, 12).map(a => ({
      '@type': 'Person', name: a.name,
      ...(a.role ? { characterName: a.role } : {})
    }));
  }
  if (film.rating_count && film.rating_avg) {
    ld.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: Number(film.rating_avg).toFixed(1),
      reviewCount: film.rating_count,
      bestRating: 5, worstRating: 1
    };
  }
  if (!film.premiere && (film.price_rent || film.price_own)) {
    ld.offers = [];
    if (film.price_rent) ld.offers.push({
      '@type': 'Offer', price: String(film.price_rent), priceCurrency: 'ZAR',
      availability: soon ? 'https://schema.org/PreOrder' : 'https://schema.org/InStock',
      category: 'rental', url: `${url.origin}/${path}`
    });
    if (film.price_own) ld.offers.push({
      '@type': 'Offer', price: String(film.price_own), priceCurrency: 'ZAR',
      availability: soon ? 'https://schema.org/PreOrder' : 'https://schema.org/InStock',
      category: 'purchase', url: `${url.origin}/${path}`
    });
  }

  /* Real text in the HTML, for crawlers that never run the JavaScript.
     Hidden from people, who get the rendered page. */
  const crawlable = `
<div hidden aria-hidden="true">
  <h1>${esc(title)}</h1>
  <p>${esc(desc)}</p>
  ${film.filmmaker ? `<p>A film by ${esc(film.filmmaker)}</p>` : ''}
  ${film.duration_mins ? `<p>${film.duration_mins} minutes</p>` : ''}
  ${actors.length ? `<p>Starring ${actors.slice(0, 8).map(a => esc(a.name)).join(', ')}</p>` : ''}
  ${crew.length ? `<p>Crew: ${crew.slice(0, 8).map(c =>
      esc(c.name) + (c.role ? ` (${esc(c.role)})` : '')).join(', ')}</p>` : ''}
  ${film.premiere ? `<p>Watch the ${esc(title)} trailer, exclusively on 4flieks.${film.release_line ? ' ' + esc(film.release_line) + '.' : ''}</p>`
    : `<p>Watch ${esc(title)} on 4flieks — South African independent film, streaming
  ${film.price_rent ? `from R${esc(film.price_rent)}` : ''}.</p>`}
</div>`;

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
<link rel="canonical" href="${esc(url.origin + '/' + path)}">
<title>${esc(title)}${mins ? ' · ' + mins : ''} · 4flieks</title>
<script type="application/ld+json">${JSON.stringify(ld)}</script>
`.trim();

  let html = await response.text();

  // drop the generic tags, then insert the film's own
  html = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+(?:property|name)="(?:og:|twitter:|description)[^"]*"[^>]*>/gi, '')
    .replace(/<\/head>/i, tags + '\n</head>')
    .replace(/<body([^>]*)>/i, `<body$1>${crawlable}`);

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
