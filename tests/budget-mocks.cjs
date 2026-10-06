/**
 * In-memory stand-ins for the database (ops-core) and the outside services,
 * so flieks-budget and budget-import-background can be attacked locally.
 * Used by tests/budget.test.mjs and tests/board.test.mjs.
 */
const path = require('path');
const Module = require('module');

process.env.FIREBASE_API_KEY = 'test-key';
process.env.FIREBASE_DB_SECRET = 'test-secret';
process.env.ANTHROPIC_API_KEY = 'test-anthropic';
process.env.URL = 'http://localhost:0';
process.env.OPS_EMAIL_TO = 'team@4flieks.test';

const db = {};
const segs = p => String(p).split('/').filter(Boolean);
function get(p) { let o = db; for (const k of segs(p)) { if (o == null || typeof o !== 'object') return null; o = o[k]; } return o === undefined ? null : JSON.parse(JSON.stringify(o)); }
function put(p, v) {
  const ks = segs(p); let o = db;
  for (const k of ks.slice(0, -1)) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  const last = ks[ks.length - 1];
  if (v === null || v === undefined) delete o[last]; else o[last] = JSON.parse(JSON.stringify(v));
}
const locks = new Map();
const emails = [];
let failCounters = false;
const ops = {
  dbGet: async p => get(p),
  dbWrite: async (p, v) => { put(p, v); return { status: 200, body: 'null' }; },
  dbIncrement: async (p, by = 1) => { if (failCounters) throw new Error('db down'); const n = (Number(get(p)) || 0) + by; put(p, n); return n; },
  takeSlot: async (p, limit) => { const n = await ops.dbIncrement(p, 1); if (n > limit) { await ops.dbIncrement(p, -1); return false; } return true; },
  withLock: async (name, fn) => { const prev = locks.get(name) || Promise.resolve(); let done; const cur = new Promise(r => done = r); locks.set(name, prev.then(() => cur));
    await prev; await new Promise(r => setTimeout(r, 1)); try { return await fn(); } finally { done(); } },
  logLabEvent: async () => {},
  SITE: 'https://4flieks.com',
  sendEmailTo: async m => { emails.push(m); return { ok: true }; },
};
const opsPath = path.resolve(__dirname, '../netlify/lib/ops-core.js');
require.cache[opsPath] = { id: opsPath, filename: opsPath, loaded: true, exports: ops };

/* Users by token: { uid, verified, role } */
const users = {};
function addUser(token, uid, { verified = true, role = 'viewer', unlimited = false } = {}) {
  users[token] = { localId: uid, emailVerified: verified, email: uid + '@test.dev' };
  put(`flieks_users/${uid}`, { role, name: uid });
  if (unlimited) put(`flieks_lab_unlimited/${uid}`, { at: 1 });
}

/* Outside services. */
let lastBackgroundCall = null, anthropicText = '[]', anthropicFn = null, scheduleBg = null, lastScheduleCall = null;
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  url = String(url);
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (url.startsWith('https://identitytoolkit.googleapis.com/')) {
    const { idToken } = JSON.parse(opts.body || '{}');
    return users[idToken] ? json(200, { users: [users[idToken]] }) : json(400, { error: { message: 'INVALID_ID_TOKEN' } });
  }
  if (url.includes('/.netlify/functions/budget-import-background')) { lastBackgroundCall = { url, opts }; return json(202, {}); }
  if (url.startsWith('https://api.anthropic.com/')) return json(200, { content: [{ type: 'text', text: anthropicFn ? anthropicFn(JSON.parse(opts.body || '{}')) : anthropicText }], stop_reason: 'end_turn' });
  if (url.includes('/.netlify/functions/schedule-breakdown-background')) {
    lastScheduleCall = { url, opts };
    if (scheduleBg) setTimeout(() => scheduleBg.handler({ httpMethod: 'POST', body: opts.body, headers: opts.headers }).catch(e => console.error('bg', e)), 5);
    return json(202, {});
  }
  if (url.startsWith('https://geocoding-api.open-meteo.com/')) return json(200, { results: [{ name: 'Fourways', latitude: -26.0, longitude: 28.0, country_code: 'ZA' }] });
  if (url.startsWith('https://api.open-meteo.com/')) return json(200, { daily: { time: ['2026-10-06'], weathercode: [2], temperature_2m_max: [28.4], temperature_2m_min: [15.6], precipitation_probability_max: [40], sunrise: ['2026-10-06T05:44'], sunset: ['2026-10-06T18:21'] } });
  if (realFetch && /^https?:\/\/(127\.0\.0\.1|localhost)/.test(url)) return realFetch(url, opts);
  throw new Error('unexpected fetch ' + url);
};

const budget = require('../netlify/functions/flieks-budget.js');
const background = require('../netlify/functions/budget-import-background.js');
const board = require('../netlify/functions/flieks-board.js');
scheduleBg = require('../netlify/functions/schedule-breakdown-background.js');
async function boardApi(body, headers = {}) {
  const r = await board.handler({ httpMethod: 'POST', body: JSON.stringify(body), headers });
  return { status: r.statusCode, d: JSON.parse(r.body || '{}') };
}
async function api(body, headers = {}) {
  const r = await budget.handler({ httpMethod: 'POST', body: JSON.stringify(body), headers });
  return { status: r.statusCode, d: JSON.parse(r.body || '{}') };
}
module.exports = {
  db, get, put, ops, users, addUser, api, budget, background, board, boardApi, emails,
  setAnthropic: t => { anthropicText = t; }, setAnthropicFn: f => { anthropicFn = f; }, lastBackground: () => lastBackgroundCall, lastSchedule: () => lastScheduleCall, scheduleBg: () => scheduleBg,
  setFailCounters: v => { failCounters = v; }
};
