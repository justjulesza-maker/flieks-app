/**
 * flieks-payout — what a filmmaker has earned, and paying it to them.
 *
 * Earnings are computed from completed live transactions, never stored as a
 * running total. A balance that is derived cannot drift; one that is
 * incremented eventually does, and with money that matters.
 *
 * Every payout records the exact transaction ids it covers, and those
 * transactions are stamped when it is paid. The same sale can therefore never
 * be paid out twice, however many times a request is made.
 *
 * POST { token, action, ... }
 *   statement                  what you have earned, been paid, and are owed
 *   bank      { bank details } save where to send it
 *   request                    ask for the outstanding balance
 *   list                       admin: every pending request
 *   settle    { uid, payoutId, reference }  admin: mark one as paid
 */
const https = require('https');

const DB      = (process.env.FIREBASE_DB_URL || 'https://flieks-app-default-rtdb.firebaseio.com').replace(/\/$/, '');
const SECRET  = process.env.FIREBASE_DB_SECRET;
const API_KEY = process.env.FIREBASE_API_KEY;

const MINIMUM = Number(process.env.PAYOUT_MINIMUM || 250);   // rand

function req(url, opts = {}, body = null) {
  return new Promise((res, rej) => {
    const r = https.request(url, opts, x => {
      let d = ''; x.on('data', c => d += c);
      x.on('end', () => res({ status: x.statusCode, body: d }));
    });
    r.on('error', rej);
    if (body) r.write(body);
    r.end();
  });
}

const dbGet = async p => JSON.parse((await req(`${DB}/${p}.json?auth=${SECRET}`)).body || 'null');
const write = (p, data, method) => {
  const b = JSON.stringify(data);
  return req(`${DB}/${p}.json?auth=${SECRET}`, {
    method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
};
const dbPut   = (p, d) => write(p, d, 'PUT');
const dbPatch = (p, d) => write(p, d, 'PATCH');

async function verifyToken(token) {
  if (!API_KEY) throw new Error('FIREBASE_API_KEY is not set.');
  const b = JSON.stringify({ idToken: token });
  const r = await req(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }
  }, b);
  const d = JSON.parse(r.body || '{}');
  if (!d.users || !d.users[0]) throw new Error('bad token');
  return d.users[0];
}

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});

const money = n => +Number(n || 0).toFixed(2);

/**
 * Works out a filmmaker's position from the transactions themselves.
 * Test-mode payments are excluded — they are not real money.
 */
async function statement(uid) {
  const [txs, films, payouts] = await Promise.all([
    dbGet('flieks_transactions'),
    dbGet('flieks_films'),
    dbGet(`flieks_payouts/${uid}`)
  ]);

  const settled = new Set();
  Object.values(payouts || {}).forEach(p => {
    if (p.status === 'paid') (p.transaction_ids || []).forEach(id => settled.add(id));
  });

  const pendingIds = new Set();
  Object.values(payouts || {}).forEach(p => {
    if (p.status === 'pending') (p.transaction_ids || []).forEach(id => pendingIds.add(id));
  });

  const lines = [];
  let earned = 0, awaiting = 0, paid = 0;

  Object.entries(txs || {}).forEach(([txId, t]) => {
    if (!t || t.status !== 'complete') return;
    if (t.mode === 'test') return;                    // sandbox money is not money
    if (t.filmmaker_uid !== uid) return;

    const share = money(t.filmmaker_share);
    if (!share) return;

    earned += share;
    const state = settled.has(txId) ? 'paid' : pendingIds.has(txId) ? 'requested' : 'available';
    if (state === 'paid') paid += share;
    else if (state === 'requested') awaiting += share;

    lines.push({
      txId,
      film: t.film_title || (films && films[t.film_id] && films[t.film_id].title) || t.film_id,
      type: t.type,
      gross: money(t.total),
      yours: share,
      at: t.completed_at || t.created_at,
      state
    });
  });

  lines.sort((a, b) => (b.at || 0) - (a.at || 0));

  const available = money(earned - paid - awaiting);

  return {
    earned: money(earned),
    paid: money(paid),
    awaiting: money(awaiting),
    available,
    minimum: MINIMUM,
    canRequest: available >= MINIMUM,
    sales: lines.length,
    lines: lines.slice(0, 200),
    availableIds: lines.filter(l => l.state === 'available').map(l => l.txId)
  };
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  try {
    const p = JSON.parse(event.body || '{}');
    const { token, action } = p;
    if (!token || !action) return reply(400, { message: 'Missing details.' });

    const user = await verifyToken(token);
    const uid = user.localId;
    const profile = await dbGet(`flieks_users/${uid}`) || {};
    const isAdmin = profile.role === 'admin';

    /* ---- what am I owed ---- */
    if (action === 'statement') {
      const s = await statement(uid);
      const bank = await dbGet(`flieks_bank/${uid}`);
      return reply(200, {
        ...s,
        availableIds: undefined,                     // internal only
        hasBank: !!(bank && bank.account_number)
      });
    }

    /* ---- where to send it ---- */
    if (action === 'bank') {
      const b = p.bank || {};
      const need = ['holder', 'bank', 'account_number', 'branch_code'];
      for (const k of need) {
        if (!String(b[k] || '').trim()) return reply(400, { message: 'Please fill in every field.' });
      }
      const acct = String(b.account_number).replace(/\s/g, '');
      if (!/^\d{6,20}$/.test(acct)) return reply(400, { message: 'That account number does not look right.' });
      if (!/^\d{4,8}$/.test(String(b.branch_code).replace(/\s/g, ''))) {
        return reply(400, { message: 'That branch code does not look right.' });
      }

      await dbPut(`flieks_bank/${uid}`, {
        holder: String(b.holder).trim().slice(0, 80),
        bank: String(b.bank).trim().slice(0, 60),
        account_number: acct,
        branch_code: String(b.branch_code).replace(/\s/g, ''),
        account_type: String(b.account_type || '').slice(0, 30),
        updated_at: Date.now()
      });
      return reply(200, { ok: true });
    }

    /* ---- ask to be paid ---- */
    if (action === 'request') {
      const bank = await dbGet(`flieks_bank/${uid}`);
      if (!bank || !bank.account_number) {
        return reply(400, { message: 'Add your bank details first.' });
      }

      const s = await statement(uid);
      if (!s.canRequest) {
        return reply(400, {
          message: `You need at least R${MINIMUM} before requesting a payout. ` +
                   `You have R${s.available.toFixed(2)}.`
        });
      }

      const payoutId = `po-${Date.now().toString(36)}`;
      await dbPut(`flieks_payouts/${uid}/${payoutId}`, {
        uid,
        filmmaker_name: profile.name || user.displayName || '',
        filmmaker_email: profile.email || user.email || '',
        amount: s.available,
        // Recording exactly which sales this covers is what stops a sale being
        // paid twice — the next statement excludes them.
        transaction_ids: s.availableIds,
        sales: s.availableIds.length,
        status: 'pending',
        requested_at: Date.now()
      });

      console.log(`Payout requested: ${uid} R${s.available} across ${s.availableIds.length} sales`);
      return reply(200, { ok: true, amount: s.available, payoutId });
    }

    /* ---- admin: everything outstanding ---- */
    if (action === 'list') {
      if (!isAdmin) return reply(403, { message: 'Admin only.' });
      const all = await dbGet('flieks_payouts') || {};
      const out = [];
      for (const [ownerUid, records] of Object.entries(all)) {
        for (const [id, r] of Object.entries(records || {})) {
          if (r.status !== 'pending') continue;
          const bank = await dbGet(`flieks_bank/${ownerUid}`);
          out.push({
            id, uid: ownerUid,
            name: r.filmmaker_name, email: r.filmmaker_email,
            amount: money(r.amount), sales: r.sales || 0,
            requested_at: r.requested_at,
            bank: bank ? {
              holder: bank.holder, bank: bank.bank,
              account_number: bank.account_number,
              branch_code: bank.branch_code,
              account_type: bank.account_type || ''
            } : null
          });
        }
      }
      out.sort((a, b) => (a.requested_at || 0) - (b.requested_at || 0));
      return reply(200, { payouts: out });
    }

    /* ---- admin: mark one paid ---- */
    if (action === 'settle') {
      if (!isAdmin) return reply(403, { message: 'Admin only.' });
      const { uid: ownerUid, payoutId } = p;
      if (!ownerUid || !payoutId) return reply(400, { message: 'Which payout?' });

      const record = await dbGet(`flieks_payouts/${ownerUid}/${payoutId}`);
      if (!record) return reply(404, { message: 'No such payout.' });
      if (record.status === 'paid') return reply(409, { message: 'Already marked as paid.' });

      const now = Date.now();
      await dbPatch(`flieks_payouts/${ownerUid}/${payoutId}`, {
        status: 'paid',
        paid_at: now,
        reference: String(p.reference || '').slice(0, 60),
        paid_by: uid
      });

      // Stamp the transactions so they can never appear in another payout.
      for (const txId of (record.transaction_ids || [])) {
        await dbPatch(`flieks_transactions/${txId}`, {
          paid_out_at: now, paid_out_ref: payoutId
        });
      }

      console.log(`Payout settled: ${ownerUid} ${payoutId} R${record.amount}`);
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });

  } catch (e) {
    console.error('payout error:', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
