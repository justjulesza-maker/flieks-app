/**
 * budget-core — shared by flieks-budget and budget-import-background.
 *
 * Everything a Lab member saves in Budget & call sheets passes through
 * cleanProduction() on the server before it is stored: only known fields,
 * the right types, length caps, safe ids (M1/M7 in the September 2026 audit).
 * Pages still escape everything they show (C2); this is the second wall.
 *
 * sheetFrom() builds the public call sheet from the stored, cleaned
 * production, never from anything the browser sends.
 */

const ID = /^[a-z0-9]{2,40}$/;                 // ids the page makes: prefix + base36
const TOKEN = /^[a-z0-9]{20,40}$/;              // public call-sheet link ids, made here
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const FORMATS = ['short', 'music', 'feature', 'series', 'other'];
const GROUPS = ['atl', 'btl', 'post', 'other'];
const UNITS = ['Day', 'Week', 'Hour', 'Flat', 'Item', 'Head', 'KM', 'Episode'];
const LINKS = ['shoot', 'prep', 'post'];
const DEPTS = ['Production', 'Camera', 'Lighting & Grip', 'Sound', 'Art Department', 'Wardrobe', 'Hair & Make-up', 'Cast', 'Unit & Locations', 'Catering', 'Post-production'];

const LIMITS = { sections: 60, lines: 200, allLines: 1500, contacts: 300, locations: 50, scenes: 500, days: 120,
  deptCalls: 30, running: 60, costs: 2000, productions: 50 };

/* Plain text: no control characters, trimmed, capped. */
const str = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
const num = (v, min, max, dflt = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const int = (v, min, max, dflt = 0) => Math.round(num(v, min, max, dflt));
const bool = v => v === true;
const oneOf = (v, list, dflt) => list.includes(v) ? v : dflt;
const id = v => (typeof v === 'string' && ID.test(v)) ? v : null;
const date = v => (typeof v === 'string' && DATE.test(v)) ? v : '';
const time = v => (typeof v === 'string' && TIME.test(v)) ? v : '';
const list = v => Array.isArray(v) ? v : (v && typeof v === 'object' ? Object.values(v) : []);
/* Phone numbers become tel: links on the shared sheet, so only digits and phone punctuation. */
const phone = v => { const s = str(v, 24); return /^\+?[0-9 ()-]{3,24}$/.test(s) ? s : ''; };
const email = v => { const s = str(v, 120); return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(s) ? s : ''; };
const pages = v => { const s = str(v, 12); return /^[0-9 /]*$/.test(s) ? s : ''; };

/* Keep items with a valid, unique id, up to a cap. */
function items(v, max, fn) {
  const seen = new Set(), out = [];
  for (const x of list(v)) {
    if (out.length >= max) break;
    if (!x || typeof x !== 'object') continue;
    const i = id(x.id); if (!i || seen.has(i)) continue;
    seen.add(i); out.push(fn(x, i));
  }
  return out;
}
/* A map keyed by ids (cast times, crew off, locked totals). */
function idMap(v, max, fn) {
  const out = {}; let n = 0;
  if (!v || typeof v !== 'object') return out;
  for (const [k, x] of Object.entries(v)) {
    if (n >= max) break;
    if (!ID.test(k)) continue;
    const c = fn(x); if (c === undefined) continue;
    out[k] = c; n++;
  }
  return out;
}

/* `prev` is the stored copy: fields only the server sets (share links) come from it, never from the browser. */
function cleanProduction(p, prev) {
  p = p && typeof p === 'object' ? p : {};
  prev = prev && typeof prev === 'object' ? prev : {};
  const prevTokens = {};
  list(prev.shootDays).forEach(d => { if (d && ID.test(d.id || '') && TOKEN.test(d.token || '')) prevTokens[d.id] = d.token; });

  let lineCount = 0;
  const sections = items(p.sections, LIMITS.sections, (s, sid) => ({
    id: sid, name: str(s.name, 80) || 'Section', group: oneOf(s.group, GROUPS, 'btl'), open: bool(s.open), onceOff: bool(s.onceOff),
    lines: items(s.lines, LIMITS.lines, (l, lid) => ({
      id: lid, desc: str(l.desc, 200), qty: num(l.qty, 0, 1e6), units: num(l.units, 0, 1e6),
      unit: oneOf(l.unit, UNITS, 'Day'), link: oneOf(l.link, LINKS, null), rate: num(l.rate, 0, 1e9),
      role: oneOf(l.role, ['crew', 'cast'], null), notes: str(l.notes, 300)
    })).filter(() => ++lineCount <= LIMITS.allLines)
  }));

  const contacts = items(p.contacts, LIMITS.contacts, (c, cid) => {
    const kind = oneOf(c.kind, ['crew', 'cast'], 'crew');
    return { id: cid, kind, name: str(c.name, 80), role: str(c.role, 80), character: str(c.character, 80), agent: str(c.agent, 80),
      dept: kind === 'cast' ? 'Cast' : (str(c.dept, 40) || 'Production'), phone: phone(c.phone), email: email(c.email) };
  });
  const locations = items(p.locations, LIMITS.locations, (l, lid) => ({
    id: lid, name: str(l.name, 80), address: str(l.address, 200), town: str(l.town, 80), parking: str(l.parking, 200),
    contact: str(l.contact, 120), hospital: str(l.hospital, 160)
  }));
  const shootDays = items(p.shootDays, LIMITS.days, (d, did) => ({
    id: did, date: date(d.date), locationId: id(d.locationId) || '',
    crewCall: time(d.crewCall), shootCall: time(d.shootCall), lunch: time(d.lunch), wrap: time(d.wrap),
    deptCalls: items(d.deptCalls, LIMITS.deptCalls, (x, xid) => ({ id: xid, dept: str(x.dept, 40), time: time(x.time) })),
    cast: idMap(d.cast, LIMITS.contacts, x => x && typeof x === 'object'
      ? { on: bool(x.on), pickup: time(x.pickup), hmu: time(x.hmu), set: time(x.set) } : undefined),
    crewOff: idMap(d.crewOff, LIMITS.contacts, x => x === true ? true : undefined),
    running: items(d.running, LIMITS.running, (x, xid) => ({ id: xid, time: str(x.time, 20), item: str(x.item, 200), who: str(x.who, 120) })),
    notes: str(d.notes, 2000), emergency: str(d.emergency, 160) || '112 (mobile) · 10177 (ambulance)',
    weather: cleanWeather(d.weather), hidePhones: bool(d.hidePhones),
    token: prevTokens[did] || ''
  }));
  const dayIds = new Set(shootDays.map(d => d.id));
  const scenes = items(p.scenes, LIMITS.scenes, (s, sid) => ({
    id: sid, no: str(s.no, 10), ie: oneOf(s.ie, ['INT', 'EXT', 'INT/EXT'], 'INT'), dn: oneOf(s.dn, ['DAY', 'NIGHT', 'DAWN', 'DUSK'], 'DAY'),
    set: str(s.set, 80), desc: str(s.desc, 300), pages: pages(s.pages), cast: str(s.cast, 200),
    dayId: dayIds.has(s.dayId) ? s.dayId : ''
  }));
  const secIds = new Set(sections.map(s => s.id));
  const costs = items(p.costs, LIMITS.costs, (c, cid) => ({
    id: cid, secId: secIds.has(c.secId) ? c.secId : '', lineId: id(c.lineId), supplier: str(c.supplier, 120),
    amount: num(c.amount, 0, 1e9), date: date(c.date), ref: str(c.ref, 60), notes: str(c.notes, 300), loggedAt: int(c.loggedAt, 0, 9e15)
  })).filter(c => c.secId);
  let locked = null;
  if (p.locked && typeof p.locked === 'object') {
    locked = { at: int(p.locked.at, 0, 9e15), grand: num(p.locked.grand, 0, 1e13),
      lines: idMap(p.locked.lines, LIMITS.allLines, x => Number.isFinite(Number(x)) ? num(x, 0, 1e13) : undefined),
      secs: idMap(p.locked.secs, LIMITS.sections, x => Number.isFinite(Number(x)) ? num(x, 0, 1e13) : undefined) };
  }
  const days = p.days && typeof p.days === 'object' ? p.days : {};
  return {
    title: str(p.title, 120) || 'Untitled production', type: oneOf(p.type, FORMATS, 'other'),
    company: str(p.company, 120), director: str(p.director, 120), producer: str(p.producer, 120),
    runtime: num(p.runtime, 0, 100000), episodes: int(p.episodes, 1, 500, 1),
    days: { prep: int(days.prep, 0, 1000), shoot: int(days.shoot, 0, 1000), post: int(days.post, 0, 1000) },
    contPct: num(p.contPct, 0, 100), feePct: num(p.feePct, 0, 100), vatOn: bool(p.vatOn), vatRate: num(p.vatRate, 0, 50, 15),
    sections, contacts, locations, scenes, shootDays, costs, locked
  };
}
function cleanWeather(w) {
  w = w && typeof w === 'object' ? w : {};
  const n = v => (v === '' || v == null || !Number.isFinite(Number(v))) ? '' : Math.round(Number(v));
  return { summary: str(w.summary, 80), high: n(w.high), low: n(w.low), rain: n(w.rain), sunrise: time(w.sunrise), sunset: time(w.sunset) };
}

/* Page counts in eighths ("1 3/8"). */
function eighths(s) { let t = 0; String(s || '').trim().split(/\s+/).forEach(p => { if (!p) return; if (p.includes('/')) { const [a, b] = p.split('/').map(Number); if (b) t += a / b; } else t += Number(p) || 0; }); return Math.round(t * 8); }
function pagesText(e) { if (!e) return '0'; const w = Math.floor(e / 8), r = e % 8; return [w || '', r ? r + '/8' : ''].filter(Boolean).join(' ') || '0'; }

/* The public call sheet: only what a crew member needs. Never the owner's uid, emails, rates or costs. */
function sheetFrom(p, dayId) {
  const days = p.shootDays || [];
  const i = days.findIndex(d => d.id === dayId); if (i < 0) return null;
  const d = days[i];
  const loc = (p.locations || []).find(l => l.id === d.locationId) || {};
  const byDept = {};
  (p.contacts || []).filter(c => c.kind !== 'cast' && !d.crewOff[c.id]).forEach(c => {
    const k = c.dept || 'Production';
    (byDept[k] = byDept[k] || []).push({ name: c.name, role: c.role, phone: d.hidePhones ? '' : c.phone });
  });
  const order = DEPTS.filter(k => byDept[k]).concat(Object.keys(byDept).filter(k => !DEPTS.includes(k)));
  const cast = (p.contacts || []).filter(c => c.kind === 'cast' && d.cast[c.id] && d.cast[c.id].on).map(c => ({
    name: c.name, character: c.character, pickup: d.cast[c.id].pickup, hmu: d.cast[c.id].hmu, set: d.cast[c.id].set,
    phone: d.hidePhones ? '' : c.phone }));
  const sc = (p.scenes || []).filter(s => s.dayId === d.id);
  const next = days[i + 1];
  const nextLoc = next ? ((p.locations || []).find(l => l.id === next.locationId) || {}) : {};
  return {
    title: p.title, company: p.company, director: p.director, producer: p.producer,
    dayNo: i + 1, dayCount: days.length, date: d.date,
    calls: { crew: d.crewCall, shoot: d.shootCall, lunch: d.lunch, wrap: d.wrap },
    loc: { name: loc.name || '', address: loc.address || '', town: loc.town || '', parking: loc.parking || '', contact: loc.contact || '', hospital: loc.hospital || '' },
    weather: d.weather, deptCalls: d.deptCalls.map(x => ({ dept: x.dept, time: x.time })),
    crew: order.map(k => ({ dept: k, people: byDept[k] })), cast,
    scenes: sc.map(s => ({ no: s.no, ie: s.ie, dn: s.dn, set: s.set, desc: s.desc, pages: s.pages, cast: s.cast })),
    pages: pagesText(sc.reduce((a, s) => a + eighths(s.pages), 0)),
    running: d.running.map(x => ({ time: x.time, item: x.item, who: x.who })),
    notes: d.notes, emergency: d.emergency,
    next: next ? { date: next.date, location: nextLoc.name || '', scenes: (p.scenes || []).filter(s => s.dayId === next.id).map(s => s.no).join(', ') } : null,
    updatedAt: Date.now()
  };
}

/* Supplier-quote lines coming back from the AI: numbers and short text only. */
function cleanImportItems(arr) {
  return list(arr).slice(0, 300).map(it => ({
    category: str(it && it.category, 80), name: str(it && it.name, 200),
    qty: num(it && it.qty, 0, 1e6, 1) || 1, days: num(it && it.days, 0, 1e6, 1) || 1, rate: num(it && it.rate, 0, 1e9)
  })).filter(it => it.name);
}

module.exports = { ID, TOKEN, DATE, LIMITS, cleanProduction, sheetFrom, cleanImportItems, str };
