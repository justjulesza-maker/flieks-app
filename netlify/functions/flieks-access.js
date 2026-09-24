/**
 * flieks-access — who has extra access, set from the admin panel.
 *
 *   Admin          flieks_users/<uid>/role = 'admin'. The whole back office:
 *                  users, payouts, bank details, film approval, control centre,
 *                  and no limits in the Lab. For directors only.
 *   Lab unlimited  flieks_lab_unlimited/<uid>. No monthly limits in 4flieks Lab
 *                  and no email confirmation, but NO admin access. For partners.
 *                  A server-only node: nobody can grant it to themselves.
 *
 * POST { token, action }   (admins only)
 *   list                          everyone with admin or Lab unlimited
 *   grant  { email, level }       level: 'admin' | 'lab'; the person must have a 4flieks account
 *   revoke { uid, level }         you cannot remove your own admin access
 */
const ops = require('../lib/ops-core');

const reply = (code, obj) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  body: JSON.stringify(obj)
});
const okUid = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  try {
    const admin = await ops.verifyAdmin(b.token);
    if (!admin) return reply(403, { message: 'Admins only.' });

    if (b.action === 'list') {
      const [users, lab] = await Promise.all([ops.dbGet('flieks_users'), ops.dbGet('flieks_lab_unlimited')]);
      const u = users || {};
      const admins = Object.entries(u).filter(([, p]) => p && p.role === 'admin')
        .map(([uid, p]) => ({ uid, name: p.name || '', email: p.email || '', me: uid === admin.localId }));
      const partners = Object.entries(lab || {})
        .map(([uid, g]) => ({ uid, name: (u[uid] && u[uid].name) || '', email: (u[uid] && u[uid].email) || g.email || '', at: g.at || null, role: (u[uid] && u[uid].role) || 'viewer' }));
      return reply(200, { admins, partners });
    }

    if (b.action === 'grant') {
      const email = String(b.email || '').trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email)) return reply(400, { message: 'Type their email address.' });
      if (b.level !== 'admin' && b.level !== 'lab') return reply(400, { message: 'Choose Admin or Lab unlimited.' });
      const users = await ops.dbGet('flieks_users') || {};
      const hit = Object.entries(users).find(([, p]) => p && String(p.email || '').trim().toLowerCase() === email);
      if (!hit) return reply(404, { message: `No 4flieks account uses ${email}. Ask them to join at 4flieks.com/lab first, then try again.` });
      const [uid, p] = hit;
      const who = p.name || email;

      if (b.level === 'admin') {
        if (p.role === 'admin') return reply(200, { ok: true, uid, note: `${who} is already an admin.` });
        await ops.dbWrite(`flieks_users/${uid}`, { role: 'admin', role_before_admin: p.role || 'viewer' }, 'PATCH');
        await ops.dbWrite(`flieks_lab_unlimited/${uid}`, null);   // admin already includes it
        return reply(200, { ok: true, uid, note: `${who} is now an admin. They need to sign out and back in.` });
      }

      if (p.role === 'admin') return reply(200, { ok: true, uid, note: `${who} is an admin, which already includes the Lab without limits.` });
      await ops.dbWrite(`flieks_lab_unlimited/${uid}`, { at: Date.now(), by: admin.email || admin.localId, email });
      await ops.sendEmailTo({
        to: email,
        subject: 'Your 4flieks Lab access has no limits',
        text: `Hi ${p.name || 'there'},\n\nYou now have unlimited access to 4flieks Lab: Script Report, the one-page pitch, ` +
          `cast match and Script Coach, with no monthly limits.\n\nStart here: ${ops.SITE}/lab\n\n` +
          `Sign in with this email address (${email}).\n\n4flieks`
      }).catch(() => {});
      return reply(200, { ok: true, uid, note: `${who} now has Lab unlimited. We emailed them.` });
    }

    if (b.action === 'revoke') {
      if (!okUid(b.uid)) return reply(400, { message: 'Bad request.' });
      if (b.level === 'admin') {
        if (b.uid === admin.localId) return reply(400, { message: 'You cannot remove your own admin access. Ask another admin.' });
        const p = await ops.dbGet(`flieks_users/${b.uid}`);
        if (!p || p.role !== 'admin') return reply(404, { message: 'They are not an admin.' });
        const back = ['viewer', 'filmmaker'].includes(p.role_before_admin) ? p.role_before_admin : 'viewer';
        await ops.dbWrite(`flieks_users/${b.uid}`, { role: back, role_before_admin: null }, 'PATCH');
        return reply(200, { ok: true, note: `Admin access removed. They are a ${back} again.` });
      }
      if (b.level === 'lab') {
        await ops.dbWrite(`flieks_lab_unlimited/${b.uid}`, null);
        return reply(200, { ok: true, note: 'Lab unlimited removed. The normal monthly limits apply again.' });
      }
      return reply(400, { message: 'Bad request.' });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[access]', e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
