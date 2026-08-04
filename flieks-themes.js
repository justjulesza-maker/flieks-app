/* ============================================================================
   flieks-themes.js
   Per-film look and feel.

   A filmmaker picks a theme; the film's page renders in it. Each theme is a
   set of CSS custom properties plus a Google Fonts link, so applying one is
   a single function call and costs nothing at runtime.

   USE (on the film page):
     FlieksThemes.apply(film.theme);        // 'midnight' if unset

   USE (in the picker):
     FlieksThemes.list()                    // [{id, name, note, swatch:[...]}]
   ============================================================================ */
(function (global) {
'use strict';

const THEMES = {

  midnight: {
    name: 'Midnight',
    note: 'The 4flieks house look. Warm amber on near-black.',
    fonts: 'Archivo+Black&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700',
    display: "'Archivo Black', system-ui, sans-serif",
    body: "'DM Sans', system-ui, sans-serif",
    hand: "'DM Sans', system-ui, sans-serif",
    vars: {
      '--t-bg':      '#12100F',
      '--t-surface': '#1C1917',
      '--t-raised':  '#262220',
      '--t-text':    '#F5F1EA',
      '--t-muted':   '#9A9088',
      '--t-accent':  '#F0A62E',
      '--t-accent-2':'#D85A2C',
      '--t-on-accent':'#12100F',
      '--t-line':    'rgba(245,241,234,.14)',
      '--t-radius':  '10px'
    }
  },

  paper: {
    name: 'Paper',
    note: 'Torn-paper collage, handwritten titles. Warm and irreverent.',
    fonts: 'Anton&family=Caveat:wght@500;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700',
    display: "'Anton', Impact, sans-serif",
    body: "'DM Sans', system-ui, sans-serif",
    hand: "'Caveat', cursive",
    vars: {
      '--t-bg':      '#EDE7DD',
      '--t-surface': '#F6F2EC',
      '--t-raised':  '#FFFFFF',
      '--t-text':    '#211E22',
      '--t-muted':   '#5A545B',
      '--t-accent':  '#E0559F',
      '--t-accent-2':'#1B181C',
      '--t-on-accent':'#FFFFFF',
      '--t-line':    'rgba(33,30,34,.16)',
      '--t-radius':  '3px'
    }
  },

  noir: {
    name: 'Noir',
    note: 'High contrast black and white. Editorial, serious.',
    fonts: 'Bebas+Neue&family=Inter:wght@400;500;700',
    display: "'Bebas Neue', Impact, sans-serif",
    body: "'Inter', system-ui, sans-serif",
    hand: "'Inter', system-ui, sans-serif",
    vars: {
      '--t-bg':      '#0A0A0A',
      '--t-surface': '#141414',
      '--t-raised':  '#1E1E1E',
      '--t-text':    '#FAFAFA',
      '--t-muted':   '#8A8A8A',
      '--t-accent':  '#FAFAFA',
      '--t-accent-2':'#C4302B',
      '--t-on-accent':'#0A0A0A',
      '--t-line':    'rgba(250,250,250,.16)',
      '--t-radius':  '0px'
    }
  },

  sunburst: {
    name: 'Sunburst',
    note: 'Hot and bright. Comedy, music, anything joyful.',
    fonts: 'Archivo+Black&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700',
    display: "'Archivo Black', system-ui, sans-serif",
    body: "'DM Sans', system-ui, sans-serif",
    hand: "'DM Sans', system-ui, sans-serif",
    vars: {
      '--t-bg':      '#1A0F2E',
      '--t-surface': '#241640',
      '--t-raised':  '#2E1D52',
      '--t-text':    '#FFF4E6',
      '--t-muted':   '#A995C4',
      '--t-accent':  '#FF6B35',
      '--t-accent-2':'#FFC93C',
      '--t-on-accent':'#1A0F2E',
      '--t-line':    'rgba(255,244,230,.16)',
      '--t-radius':  '14px'
    }
  },

  verdant: {
    name: 'Verdant',
    note: 'Earthy greens. Documentary, rural stories, nature.',
    fonts: 'Fraunces:opsz,wght@9..144,600;9..144,900&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,700',
    display: "'Fraunces', Georgia, serif",
    body: "'DM Sans', system-ui, sans-serif",
    hand: "'Fraunces', Georgia, serif",
    vars: {
      '--t-bg':      '#121A14',
      '--t-surface': '#1B261E',
      '--t-raised':  '#243228',
      '--t-text':    '#F0EDE4',
      '--t-muted':   '#93A396',
      '--t-accent':  '#8FBF6B',
      '--t-accent-2':'#D9A441',
      '--t-on-accent':'#121A14',
      '--t-line':    'rgba(240,237,228,.14)',
      '--t-radius':  '8px'
    }
  },

  ice: {
    name: 'Ice',
    note: 'Cool and clean. Thrillers, sci-fi, anything with edge.',
    fonts: 'Space+Grotesk:wght@500;700&family=Inter:wght@400;500;700',
    display: "'Space Grotesk', system-ui, sans-serif",
    body: "'Inter', system-ui, sans-serif",
    hand: "'Space Grotesk', system-ui, sans-serif",
    vars: {
      '--t-bg':      '#0B1418',
      '--t-surface': '#122027',
      '--t-raised':  '#193039',
      '--t-text':    '#E8F4F8',
      '--t-muted':   '#7D9AA6',
      '--t-accent':  '#4CC9E0',
      '--t-accent-2':'#7B61FF',
      '--t-on-accent':'#0B1418',
      '--t-line':    'rgba(232,244,248,.15)',
      '--t-radius':  '6px'
    }
  }
};

const DEFAULT = 'midnight';

function get(id) { return THEMES[id] || THEMES[DEFAULT]; }

function list() {
  return Object.entries(THEMES).map(([id, t]) => ({
    id, name: t.name, note: t.note,
    swatch: [t.vars['--t-bg'], t.vars['--t-surface'], t.vars['--t-accent'], t.vars['--t-text']]
  }));
}

let loadedFonts = null;

/** Apply a theme to the page. Safe to call repeatedly. */
function apply(id, target) {
  const t = get(id);
  const el = target || document.documentElement;

  Object.entries(t.vars).forEach(([k, v]) => el.style.setProperty(k, v));
  el.style.setProperty('--t-display', t.display);
  el.style.setProperty('--t-body', t.body);
  el.style.setProperty('--t-hand', t.hand);

  if (loadedFonts !== t.fonts) {
    let link = document.getElementById('flieks-theme-fonts');
    if (!link) {
      link = document.createElement('link');
      link.id = 'flieks-theme-fonts';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = `https://fonts.googleapis.com/css2?family=${t.fonts}&display=swap`;
    loadedFonts = t.fonts;
  }

  // let the page colour its own chrome to match
  let meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.content = t.vars['--t-bg'];

  el.setAttribute('data-flieks-theme', THEMES[id] ? id : DEFAULT);
  return t;
}

/** A small preview card's worth of inline style, for the picker. */
function previewStyle(id) {
  const t = get(id);
  return `background:${t.vars['--t-surface']};color:${t.vars['--t-text']};` +
         `border:1px solid ${t.vars['--t-line']};border-radius:${t.vars['--t-radius']}`;
}

global.FlieksThemes = { apply, get, list, previewStyle, DEFAULT, THEMES };

})(window);
