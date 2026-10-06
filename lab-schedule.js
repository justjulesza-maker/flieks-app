/**
 * lab-schedule.js — the 4flieks Lab scheduling engine (Budget & call sheets → Schedule).
 *
 * Pure functions over a production { scenes, shootDays, contacts, locations, sched }.
 * The page calls these and then saves the production the usual way; nothing here
 * talks to the network. tests/schedule.test.mjs runs the same file.
 *
 * Rules the planner follows (all of them can be overridden by hand afterwards):
 * - A day holds about `sched.pace` pages of simple dialogue; harder scenes count for more
 *   (effort 1 simple ×0.85, 2 normal ×1.15, 3 complex ×1.45, 4 very heavy ×1.9).
 * - Each location is shot in one go where possible, at most `sched.maxLocs` locations a day,
 *   with time allowed for each move. Day shoots come before night shoots.
 * - Locked days are never touched. Dates skip weekdays off and avoid days an actor
 *   in that day's scenes can't work; when nothing fits, the clash is shown, not hidden.
 */
(function (root) {
  'use strict';
  const FACTOR = { 1: 0.85, 2: 1.15, 3: 1.45, 4: 1.9 };
  const EFFORT_NAME = { 1: 'Simple', 2: 'Normal', 3: 'Complex', 4: 'Very heavy' };
  const NIGHTISH = ['NIGHT', 'DAWN', 'DUSK'];
  const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const FULL = 1.1;   // a day may run 10% over before it splits

  const uid = p => (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const num = v => { const n = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, '')); return isFinite(n) ? n : 0; };
  function eighths(pages) { const s = String(pages || '').trim(); if (!s) return 0; let t = 0; s.split(/\s+/).forEach(p => { if (p.includes('/')) { const [a, b] = p.split('/').map(num); if (b) t += a / b; } else t += num(p); }); return Math.round(t * 8); }
  function pagesText(e) { e = Math.round(e || 0); if (!e) return '0'; const w = Math.floor(e / 8), r = e % 8; return (w ? String(w) : '') + (w && r ? ' ' : '') + (r ? r + '/8' : ''); }
  const settings = p => Object.assign({ start: '', off: [], pace: 4.25, maxLocs: 2 }, p.sched || {});
  const cap = p => Math.max(8, settings(p).pace * 8);
  const units = s => Math.max(1, eighths(s.pages)) * (FACTOR[s.effort] || FACTOR[2]);
  const isNight = s => NIGHTISH.includes(s.dn);
  const locKey = s => s.locationId || ('set:' + String(s.set || '').toLowerCase().replace(/\s*[–—-].*$/, '').trim());
  function sceneCmp(a, b) {
    const pa = String(a.no || '').match(/^(\d+)(.*)$/), pb = String(b.no || '').match(/^(\d+)(.*)$/);
    if (pa && pb) return (+pa[1] - +pb[1]) || pa[2].localeCompare(pb[2]);
    return String(a.no || '').localeCompare(String(b.no || ''));
  }

  /* ---------- dates ---------- */
  function addDays(d, n) { if (!DATE.test(d || '')) return ''; const x = new Date(d + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
  const weekday = d => DATE.test(d || '') ? new Date(d + 'T12:00:00Z').getUTCDay() : -1;
  const dayLabel = d => DATE.test(d || '') ? `${WEEKDAY[weekday(d)]} ${new Date(d + 'T12:00:00Z').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'UTC' })}` : 'No date';
  function sortDays(p) {
    const order = new Map(p.shootDays.map((d, i) => [d.id, i]));
    p.shootDays.sort((a, b) => {
      const da = DATE.test(a.date || ''), db = DATE.test(b.date || '');
      if (da && db && a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (da !== db) return da ? -1 : 1;
      return order.get(a.id) - order.get(b.id);
    });
  }

  /* ---------- reading a day ---------- */
  const scenesOf = (p, dayId) => p.scenes.filter(s => (s.dayId || '') === (dayId || '')).sort((a, b) => ((a.pos || 0) - (b.pos || 0)) || sceneCmp(a, b));
  function stats(p, d) {
    const sc = scenesOf(p, d.id);
    const locs = [...new Set(sc.map(locKey))];
    const u = sc.reduce((a, s) => a + units(s), 0) + Math.max(0, locs.length - 1) * cap(p) * 0.12;
    return { scenes: sc, eighths: sc.reduce((a, s) => a + eighths(s.pages), 0), units: u, load: u / cap(p),
      locs, cast: [...new Set(sc.flatMap(s => s.castIds || []))], night: sc.length > 0 && sc.every(isNight) };
  }
  function renumber(p, dayId) { scenesOf(p, dayId).forEach((s, i) => { s.pos = i + 1; }); }

  /* ---------- keeping call-sheet cast in step with the scenes ---------- */
  function syncCast(p) {
    p.shootDays.forEach(d => {
      d.cast = d.cast || {};
      const need = new Set(scenesOf(p, d.id).flatMap(s => s.castIds || []));
      need.forEach(id => {
        const e = d.cast[id];
        if (!e) d.cast[id] = { on: true, pickup: '', hmu: '', set: d.shootCall || '', auto: true };
        else if (!e.on) { e.on = true; e.auto = true; }
      });
      Object.keys(d.cast).forEach(id => {
        const e = d.cast[id];
        if (e && e.auto && e.on && !need.has(id)) { if (!e.pickup && !e.hmu) delete d.cast[id]; else { e.on = false; e.auto = false; } }
      });
    });
  }

  /* ---------- clashes ---------- */
  function conflicts(p) {
    const out = [], s = settings(p), cast = new Map(p.contacts.filter(c => c.kind === 'cast').map(c => [c.id, c]));
    const seen = new Map();
    p.shootDays.forEach((d, i) => {
      const st = stats(p, d), label = `Day ${i + 1}`;
      if (DATE.test(d.date || '')) {
        if (seen.has(d.date)) out.push({ dayId: d.id, kind: 'date', text: `${label} is on the same date as Day ${seen.get(d.date) + 1} (${dayLabel(d.date)}).` });
        else seen.set(d.date, i);
        if (s.off.includes(weekday(d.date))) out.push({ dayId: d.id, kind: 'off', text: `${label} falls on a ${WEEKDAY[weekday(d.date)]}, which is a day off in your settings.` });
        st.cast.forEach(id => {
          const c = cast.get(id);
          if (c && (c.unavail || []).includes(d.date)) {
            const sc = st.scenes.filter(x => (x.castIds || []).includes(id)).map(x => x.no).join(', ');
            out.push({ dayId: d.id, castId: id, kind: 'actor', text: `${c.name || c.character || 'An actor'}${c.name && c.character ? ' (' + c.character + ')' : ''} can't work on ${dayLabel(d.date)}, but is in ${label} (sc ${sc}).` });
          }
        });
      }
      const prev = p.shootDays[i - 1];
      if (prev && DATE.test(prev.date || '') && d.date === addDays(prev.date, 1) && stats(p, prev).night && st.scenes.length && !st.night)
        out.push({ dayId: d.id, kind: 'turnaround', text: `${label} is a day shoot the morning after a night shoot. The crew needs rest between them: add a day or start later.` });
      if (st.load > 1.25) out.push({ dayId: d.id, kind: 'heavy', text: `${label} is ${Math.round(st.load * 100)}% of a normal day's work. Move a scene or add a day.` });
    });
    return out;
  }

  /* ---------- moving things by hand ---------- */
  function moveScene(p, sceneId, dayId, beforeId) {
    const s = p.scenes.find(x => x.id === sceneId); if (!s) return false;
    const from = s.dayId || ''; dayId = dayId || '';
    const list = scenesOf(p, dayId).filter(x => x !== s);
    let at = beforeId ? list.findIndex(x => x.id === beforeId) : -1; if (at < 0) at = list.length;
    list.splice(at, 0, s); s.dayId = dayId;
    list.forEach((x, i) => { x.pos = i + 1; });
    if (from !== dayId) renumber(p, from);
    syncCast(p); return true;
  }
  function stepScene(p, sceneId, dir) {
    const s = p.scenes.find(x => x.id === sceneId); if (!s) return false;
    const list = scenesOf(p, s.dayId); const i = list.indexOf(s), j = i + dir;
    if (j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]]; list.forEach((x, k) => { x.pos = k + 1; }); return true;
  }
  function newDay(p, template, date) {
    const t = template || p.shootDays[p.shootDays.length - 1] || {};
    return { id: uid('d'), date: date || '', locationId: '', crewCall: t.crewCall || '07:00', shootCall: t.shootCall || '08:00', lunch: t.lunch || '13:00', wrap: t.wrap || '18:00',
      deptCalls: (t.deptCalls || []).map(x => ({ id: uid('dc'), dept: x.dept, time: x.time })), cast: {}, crewOff: Object.assign({}, t.crewOff || {}), running: [], notes: '',
      emergency: t.emergency || '112 (mobile) · 10177 (ambulance)', weather: {}, token: '', hidePhones: !!t.hidePhones, locked: false };
  }
  function nextFreeDate(p, from, taken) {
    const s = settings(p); let d = from;
    for (let i = 0; i < 400 && d; i++) { if (!s.off.includes(weekday(d)) && !taken.has(d)) return d; d = addDays(d, 1); }
    return '';
  }
  function insertDay(p, afterId) {
    const i = afterId ? p.shootDays.findIndex(d => d.id === afterId) : p.shootDays.length - 1;
    const after = p.shootDays[i];
    const taken = new Set(p.shootDays.map(d => d.date).filter(Boolean));
    const date = after && after.date ? nextFreeDate(p, addDays(after.date, 1), taken) : '';
    const d = newDay(p, after, date); p.shootDays.splice(i + 1, 0, d); sortDays(p); return d;
  }
  function deleteDay(p, dayId) {
    p.scenes.forEach(s => { if (s.dayId === dayId) { s.dayId = ''; } });
    p.shootDays = p.shootDays.filter(d => d.id !== dayId); renumber(p, ''); return true;
  }
  /* Move a day earlier or later: the two days swap their scenes' place in the shoot (and their dates). */
  function swapDay(p, dayId, dir) {
    const i = p.shootDays.findIndex(d => d.id === dayId), j = i + dir;
    if (i < 0 || j < 0 || j >= p.shootDays.length) return false;
    const a = p.shootDays[i], b = p.shootDays[j];
    if (a.locked || b.locked) return 'locked';
    [a.date, b.date] = [b.date, a.date];
    p.shootDays[i] = b; p.shootDays[j] = a; return true;
  }
  function setDate(p, dayId, date, shiftLater) {
    const i = p.shootDays.findIndex(d => d.id === dayId); if (i < 0) return false;
    const d = p.shootDays[i], old = d.date;
    d.date = DATE.test(date || '') ? date : '';
    if (shiftLater && DATE.test(old || '') && d.date) {
      const delta = Math.round((Date.parse(d.date) - Date.parse(old)) / 864e5);
      p.shootDays.slice(i + 1).forEach(x => { if (!x.locked && DATE.test(x.date || '')) x.date = addDays(x.date, delta); });
    }
    sortDays(p); return true;
  }
  /* Push this day and every unlocked day after it by n days (an actor drops out, rain, a day off). */
  function shiftFrom(p, dayId, n) {
    const i = p.shootDays.findIndex(d => d.id === dayId); if (i < 0) return 0;
    let moved = 0;
    p.shootDays.slice(i).forEach(x => { if (!x.locked && DATE.test(x.date || '')) { x.date = addDays(x.date, n); moved++; } });
    sortDays(p); return moved;
  }

  /* ---------- planning ---------- */
  /* The town or area a scene is shot in (its location's Town field), so a shoot in two cities isn't scattered. */
  function areaOf(p, s) { const l = (p.locations || []).find(x => x.id === s.locationId); return l && l.town ? String(l.town).toLowerCase().trim() : ''; }
  function packBlocks(p, pool) {
    const CAP = cap(p), MOVE = CAP * 0.12, MAXL = settings(p).maxLocs;
    // areas in story order: by where most of their scenes sit in the script (a flash-forward doesn't pull a whole city to the front)
    const sorted = pool.slice().sort(sceneCmp), where = new Map();
    sorted.forEach((s, i) => { const a = areaOf(p, s); if (!where.has(a)) where.set(a, []); where.get(a).push(i); });
    const median = l => l.slice().sort((x, y) => x - y)[Math.floor(l.length / 2)];
    const areas = [...where.keys()].sort((x, y) => median(where.get(x)) - median(where.get(y)));
    const blocks = [];
    for (const area of areas) {
    const groups = new Map();
    pool.filter(s => areaOf(p, s) === area).forEach(s => { const k = (isNight(s) ? 'N|' : 'D|') + locKey(s); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); });
    for (const night of [false, true]) {
      const ks = [...groups.keys()].filter(k => k.startsWith(night ? 'N|' : 'D|'))
        .sort((a, b) => groups.get(b).reduce((t, s) => t + units(s), 0) - groups.get(a).reduce((t, s) => t + units(s), 0));
      let d = null; const mine = [];
      for (const k of ks) {
        const ss = groups.get(k).sort(sceneCmp), loc = k.slice(2), tot = ss.reduce((t, s) => t + units(s), 0);
        if (d && !d.locs.includes(loc) && tot <= CAP * FULL && d.units + tot + MOVE > CAP * FULL) d = null;   // don't start a location you can't finish
        for (const s of ss) {
          const u = units(s), newLoc = d && !d.locs.includes(loc);
          const need = u + (newLoc ? MOVE : 0);
          if (!d || (newLoc && d.locs.length >= MAXL) || (d.scenes.length && d.units + need > CAP * FULL)) { d = { night, scenes: [], units: 0, locs: [] }; mine.push(d); }
          d.scenes.push(s); d.units += d.scenes.length === 1 ? u : need;
          if (!d.locs.includes(loc)) d.locs.push(loc);
        }
      }
      // fold very light days into another day of the same kind with room
      let changed = true;
      while (changed) {
        changed = false;
        for (const a of mine.slice().sort((x, y) => x.units - y.units)) {
          if (a.units > CAP * 0.5) break;
          const b = mine.find(x => x !== a && x.units + a.units + MOVE * a.locs.filter(l => !x.locs.includes(l)).length <= CAP * FULL
            && new Set(x.locs.concat(a.locs)).size <= MAXL + 1);
          if (b) { b.scenes.push(...a.scenes); b.units += a.units + MOVE * a.locs.filter(l => !b.locs.includes(l)).length; a.locs.forEach(l => { if (!b.locs.includes(l)) b.locs.push(l); }); mine.splice(mine.indexOf(a), 1); changed = true; break; }
        }
      }
      blocks.push(...mine);
    }
    }
    return blocks;
  }

  /**
   * Plan the shoot.
   *   mode 'all'         re-plan every scene that isn't on a locked day (unlocked days are reused, in order)
   *   mode 'unscheduled' only place scenes that have no day yet: into days with room at the same location, else new days at the end
   * Returns { days, added, removed, unplaced }.
   */
  function plan(p, opts) {
    opts = opts || {};
    const mode = opts.mode || 'all', s = settings(p), CAP = cap(p);
    const locked = p.shootDays.filter(d => d.locked);
    const lockedIds = new Set(locked.map(d => d.id));
    let added = 0, removed = 0;

    if (mode === 'unscheduled') {
      const pool = p.scenes.filter(x => !x.dayId).sort(sceneCmp);
      const left = [];
      pool.forEach(sc => {
        const fit = p.shootDays.find(d => !d.locked && (() => { const st = stats(p, d); return st.scenes.length && st.locs.includes(locKey(sc)) && st.night === isNight(sc) && st.units + units(sc) <= CAP * FULL; })());
        if (fit) { sc.dayId = fit.id; sc.pos = 9999; renumber(p, fit.id); } else left.push(sc);
      });
      const blocks = packBlocks(p, left);
      const taken = new Set(p.shootDays.map(d => d.date).filter(Boolean));
      let cursor = p.shootDays.filter(d => DATE.test(d.date || '')).map(d => d.date).sort().pop();
      cursor = cursor ? addDays(cursor, 1) : s.start;
      blocks.forEach(b => {
        const date = cursor ? nextFreeDate(p, cursor, taken) : '';
        if (date) { taken.add(date); cursor = addDays(date, 1); }
        const d = newDay(p, p.shootDays[p.shootDays.length - 1], date); p.shootDays.push(d); added++;
        b.scenes.forEach((x, i) => { x.dayId = d.id; x.pos = i + 1; });
        d.locationId = mainLocation(b.scenes);
      });
      sortDays(p); syncCast(p);
      return { days: p.shootDays.length, added, removed, unplaced: 0 };
    }

    // mode 'all'
    const pool = p.scenes.filter(x => !lockedIds.has(x.dayId));
    const reuse = p.shootDays.filter(d => !d.locked);
    const blocks = packBlocks(p, pool);
    // dates: from the start date (or the first existing date), skipping days off and locked dates,
    // picking for each date the first block whose actors can all work that day
    const castById = new Map(p.contacts.filter(c => c.kind === 'cast').map(c => [c.id, c]));
    const blockOk = (b, date) => !b.scenes.some(x => (x.castIds || []).some(id => ((castById.get(id) || {}).unavail || []).includes(date)));
    const firstDate = s.start || p.shootDays.map(d => d.date).filter(x => DATE.test(x || '')).sort()[0] || '';
    const taken = new Set(locked.map(d => d.date).filter(Boolean));
    const ordered = [];
    if (firstDate) {
      const left = blocks.slice(); let cursor = firstDate;
      while (left.length) {
        const date = nextFreeDate(p, cursor, taken); if (!date) break;
        let k = left.findIndex(b => blockOk(b, date));
        // nobody fits today: leave the date free if a later date would work for the next block, else take the clash
        if (k < 0) {
          const later = [1, 2, 3, 4, 5, 6, 7].map(n => addDays(date, n)).some(x => blockOk(left[0], x));
          if (later) { taken.add(date); cursor = addDays(date, 1); continue; }
          k = 0;
        }
        const b = left.splice(k, 1)[0]; b.date = date; ordered.push(b); taken.add(date); cursor = addDays(date, 1);
      }
      left.forEach(b => { b.date = ''; ordered.push(b); });
    } else blocks.forEach(b => { b.date = ''; ordered.push(b); });

    const days = [];
    ordered.forEach((b, i) => {
      const old = reuse[i];
      const d = old ? Object.assign(old, { date: b.date, locationId: '', running: [], notes: old.notes || '', weather: {}, cast: {} }) : newDay(p, reuse[0] || locked[0], b.date);
      if (!old) added++;
      d.locationId = mainLocation(b.scenes);
      b.scenes.forEach((x, k) => { x.dayId = d.id; x.pos = k + 1; });
      days.push(d);
    });
    removed = Math.max(0, reuse.length - ordered.length);
    p.shootDays = locked.concat(days);
    sortDays(p); syncCast(p);
    return { days: p.shootDays.length, added, removed, unplaced: 0 };
  }
  function mainLocation(scenes) {
    const t = new Map(); scenes.forEach(s => { if (s.locationId) t.set(s.locationId, (t.get(s.locationId) || 0) + units(s)); });
    let best = '', bu = -1; t.forEach((u, id) => { if (u > bu) { bu = u; best = id; } }); return best;
  }

  /* Each cast member's shoot days, for the availability table. */
  function castDays(p) {
    const out = {};
    p.shootDays.forEach((d, i) => stats(p, d).cast.forEach(id => { (out[id] = out[id] || []).push(i + 1); }));
    return out;
  }

  const api = { FACTOR, EFFORT_NAME, WEEKDAY, eighths, pagesText, units, cap, isNight, locKey, sceneCmp, addDays, weekday, dayLabel, sortDays,
    scenesOf, stats, areaOf, renumber, syncCast, conflicts, moveScene, stepScene, newDay, insertDay, deleteDay, swapDay, setDate, shiftFrom, plan, castDays, settings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SCHED = api;
})(typeof window !== 'undefined' ? window : this);
