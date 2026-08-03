/* ============================================================================
   flieks-social.js
   Cast-led selling for the 4flieks platform.

   Adds to any film what Destroying Desmond has: a cast list, per-actor
   tracked links, QR-friendly deep links, and attribution from click to sale.

   DROP IN: <script src="/flieks-social.js"></script> after the Firebase SDKs.
   Then wire the three hooks marked INTEGRATION below.

   Expects the compat Firebase SDKs already initialised on the page:
   firebase.database() and firebase.auth().
   ============================================================================ */
(function (global) {
'use strict';

const REF_TTL_DAYS = 30;          // how long an actor keeps credit for a visit
const LS = 'flieks_ref_v1';

const db = () => firebase.database();
const esc = s => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
const bump = path => db().ref(path).transaction(v => (v || 0) + 1).catch(() => {});

/* ---------------------------------------------------------------------------
   Referral store — one referrer per film, so an actor on film A doesn't get
   credited for a sale on film B.
   --------------------------------------------------------------------------- */
function readStore() {
  try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; }
}
function writeStore(o) {
  try { localStorage.setItem(LS, JSON.stringify(o)); } catch {}
}
function pruneStore(o) {
  const cutoff = Date.now() - REF_TTL_DAYS * 864e5;
  Object.keys(o).forEach(k => { if (!o[k] || o[k].at < cutoff) delete o[k]; });
  return o;
}

function setRef(filmId, slug) {
  if (!filmId || !slug) return;
  const o = pruneStore(readStore());
  o[filmId] = { slug, at: Date.now() };
  writeStore(o);
}

/** The actor who should be credited for a sale of this film, if any. */
function getRef(filmId) {
  const o = pruneStore(readStore());
  writeStore(o);
  return (o[filmId] && o[filmId].slug) || null;
}

/* ---------------------------------------------------------------------------
   Slugs — films get a readable slug so links are shareable.
   flieks_film_slugs/{slug} -> filmId
   --------------------------------------------------------------------------- */
async function filmIdFromSlug(slug) {
  if (!slug) return null;
  const s = await db().ref('flieks_film_slugs/' + slug).get().catch(() => null);
  return (s && s.val()) || null;
}

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

/* ---------------------------------------------------------------------------
   init() — call once on page load, before your router decides what to show.

   Understands three link shapes:
     /?f=<slug|filmId>&a=<castSlug>     query form, works with no server config
     /f/<slug>?a=<castSlug>             pretty form, needs the _redirects rule
     /?a=<castSlug>                     no film given, ref ignored (ambiguous)

   Resolves to { filmId, ref } and logs the click. Your app should then open
   that film's detail view.
   --------------------------------------------------------------------------- */
async function init(opts) {
  opts = opts || {};
  const q = new URLSearchParams(location.search);

  let filmKey = q.get('f') || q.get('film');

  if (!filmKey) {
    // /f/<slug> (legacy) and /<slug> (primary)
    const legacy = location.pathname.match(/^\/f\/([^/?#]+)/);
    if (legacy) filmKey = decodeURIComponent(legacy[1]);
    else {
      const root = location.pathname.match(/^\/([^/?#]+)\/?$/);
      // ignore real files and known app routes
      const RESERVED = /^(index|admin|filmmaker|cast|attribution|about|terms|privacy|login|signup|account|assets|images|static)$|\.[a-z0-9]+$/i;
      if (root && !RESERVED.test(root[1])) filmKey = decodeURIComponent(root[1]);
    }
  }

  const rawRef = q.get('a') || q.get('ref');
  const ref = rawRef ? slugify(rawRef) : null;

  if (!filmKey) return { filmId: null, ref: null };

  // a slug resolves through the index; anything else is treated as a raw id
  const filmId = (await filmIdFromSlug(filmKey)) || filmKey;

  if (ref) {
    setRef(filmId, ref);
    bump(`flieks_stats/${filmId}/refs/${ref}/clicks`);
    bump(`flieks_stats/${filmId}/clicks`);
  }

  if (opts.clean !== false && (q.has('a') || q.has('ref'))) {
    // drop the tag from the address bar, keep the film's own path
    const onPath = /^\/[^/?#]+\/?$/.test(location.pathname) && location.pathname !== '/';
    history.replaceState({}, '', onPath ? location.pathname
                                        : `/${encodeURIComponent(filmKey)}`);
  }

  return { filmId, ref };
}

/* ---------------------------------------------------------------------------
   Counters
   --------------------------------------------------------------------------- */
function trailerPlayed(filmId) {
  if (!filmId) return;
  bump(`flieks_stats/${filmId}/trailerPlays`);
  const r = getRef(filmId);
  if (r) bump(`flieks_stats/${filmId}/refs/${r}/trailerPlays`);
}

function filmOpened(filmId) {
  if (!filmId) return;
  bump(`flieks_stats/${filmId}/views`);
}

/* ---------------------------------------------------------------------------
   Link building
   --------------------------------------------------------------------------- */
function linkFor(filmSlugOrId, castSlug) {
  const base = location.origin;
  const f = encodeURIComponent(filmSlugOrId);
  // /slug is the primary form: reads like the film's own address.
  return castSlug
    ? `${base}/${f}?a=${encodeURIComponent(castSlug)}`
    : `${base}/${f}`;
}

/* Free QR via a public renderer — swap for a local generator if you'd rather
   not depend on a third party for printed material. */
function qrFor(url, size) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size || 400}x${size || 400}` +
         `&ecc=H&margin=8&data=${encodeURIComponent(url)}`;
}

/* ---------------------------------------------------------------------------
   Cast strip — renders into any container you give it.
   Styling hooks: .fs-cast, .fs-member, .fs-face, .fs-name, .fs-role, .fs-socials
   --------------------------------------------------------------------------- */
const NETWORKS = {
  instagram: 'Instagram', tiktok: 'TikTok', x: 'X',
  youtube: 'YouTube', facebook: 'Facebook'
};

async function loadCast(filmId) {
  const s = await db().ref('flieks_cast/' + filmId).get().catch(() => null);
  const v = (s && s.val()) || {};
  return Object.entries(v)
    .map(([slug, c]) => ({ slug, ...c }))
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

async function renderCast(container, filmId, options) {
  const el = typeof container === 'string' ? document.querySelector(container) : container;
  if (!el) return [];
  const opts = options || {};
  const cast = await loadCast(filmId);

  if (!cast.length) { el.innerHTML = ''; return []; }

  const filmSlug = opts.filmSlug || filmId;
  const showLinks = opts.showLinks !== false;   // set false for public viewers

  el.innerHTML = `<div class="fs-cast">` + cast.map(c => `
    <div class="fs-member">
      ${c.photoUrl ? `<img class="fs-face" src="${esc(c.photoUrl)}" alt="${esc(c.name)}" loading="lazy">`
                   : `<div class="fs-face fs-face-empty"></div>`}
      <div class="fs-body">
        <div class="fs-name">${esc(c.name)}</div>
        ${c.role ? `<div class="fs-role">${esc(c.role)}</div>` : ''}
        ${c.reach ? `<div class="fs-reach">${esc(c.reach)} following</div>` : ''}
        <div class="fs-socials">
          ${Object.keys(NETWORKS).filter(k => c[k]).map(k =>
            `<a class="fs-soc" href="${esc(c[k])}" target="_blank" rel="noopener">${NETWORKS[k]}</a>`
          ).join('')}
        </div>
        ${showLinks ? `<button class="fs-copy" data-fs-copy="${esc(c.slug)}">Copy their link</button>` : ''}
      </div>
    </div>`).join('') + `</div>`;

  el.querySelectorAll('[data-fs-copy]').forEach(b => {
    b.addEventListener('click', () => {
      const url = linkFor(filmSlug, b.dataset.fsCopy);
      navigator.clipboard.writeText(url).then(() => {
        const was = b.textContent;
        b.textContent = 'Copied';
        setTimeout(() => (b.textContent = was), 1600);
      });
    });
  });

  return cast;
}

/* ---------------------------------------------------------------------------
   Share sheet — for the existing SHARE button. Uses the ref already held for
   this film, so a viewer who arrived through an actor keeps crediting them.
   --------------------------------------------------------------------------- */
async function share(filmId, filmTitle, filmSlug) {
  const url = linkFor(filmSlug || filmId, getRef(filmId));
  const text = `${filmTitle} — watch it on 4flieks`;
  if (navigator.share) {
    try { await navigator.share({ title: filmTitle, text, url }); return 'shared'; }
    catch { return 'cancelled'; }
  }
  await navigator.clipboard.writeText(`${text} ${url}`);
  return 'copied';
}

/* ---------------------------------------------------------------------------
   Minimal default styling. Skip it and write your own if you prefer —
   call FlieksSocial.injectStyles(false) or just don't call it.
   --------------------------------------------------------------------------- */
function injectStyles() {
  if (document.getElementById('fs-styles')) return;
  const css = `
  .fs-cast{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px}
  .fs-member{background:rgba(255,255,255,.04);border:1px solid rgba(242,234,218,.12);
    border-radius:6px;padding:12px;text-align:center}
  .fs-face{width:74px;height:74px;border-radius:50%;object-fit:cover;margin:0 auto 10px;display:block;
    background:rgba(242,234,218,.08)}
  .fs-face-empty{background:rgba(242,234,218,.08)}
  .fs-name{font-weight:700;font-size:14px;line-height:1.2}
  .fs-role{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#D85A2C;margin-top:4px}
  .fs-reach{font-size:11px;opacity:.6;margin-top:3px}
  .fs-socials{display:flex;flex-wrap:wrap;gap:5px;justify-content:center;margin-top:9px}
  .fs-soc{font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:6px 10px;
    border:1px solid rgba(242,234,218,.2);border-radius:99px;text-decoration:none;color:inherit;
    min-height:32px;display:inline-flex;align-items:center}
  .fs-soc:hover{border-color:#D85A2C;color:#D85A2C}
  .fs-copy{margin-top:9px;width:100%;min-height:38px;cursor:pointer;font:inherit;font-size:11px;
    letter-spacing:.1em;text-transform:uppercase;background:transparent;color:inherit;
    border:1px solid rgba(242,234,218,.25);border-radius:4px;padding:9px}
  .fs-copy:hover{border-color:#D85A2C;color:#D85A2C}`;
  const s = document.createElement('style');
  s.id = 'fs-styles'; s.textContent = css;
  document.head.appendChild(s);
}

global.FlieksSocial = {
  init, getRef, setRef, slugify,
  loadCast, renderCast, share,
  linkFor, qrFor,
  trailerPlayed, filmOpened, filmIdFromSlug,
  injectStyles
};

})(window);
