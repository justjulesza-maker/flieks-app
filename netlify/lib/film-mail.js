/**
 * film-mail — emails to filmmakers about their films.
 *
 * sendLiveEmail(filmId): "your film is live", with the link and what to do
 * next (cast links first). Sent once per film; flieks_ops/live_emails/{filmId}
 * records it so approving twice, or taking a film down and back up, doesn't
 * email the filmmaker again unless an admin asks for it (force).
 */
const ops = require('./ops-core');

const SITE = ops.SITE;
const REPLY_TO = process.env.SUPPORT_EMAIL || 'support@4flieks.com';

const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const firstName = n => String(n || '').trim().split(/\s+/)[0] || 'there';

function liveEmail({ name, title, filmUrl, portalUrl, payoutsUrl }) {
  const subject = `${title} is live on 4flieks`;

  const steps = [
    ['Create your cast and crew links',
     'Everyone who worked on the film gets their own link and QR code. When they share it, you see exactly what it brings in: opens, trailer plays and sales.',
     'Open your film → Cast & crew'],
    ['Decide the cast share',
     'Choose what each person earns from the sales their link brings in, and tell them before they start posting.',
     'Same page, under Cast share'],
    ['Share it on the same day',
     'Post the film link on your own socials and WhatsApp, and ask your cast and crew to post their links that day too. The first days matter most.',
     null],
    ['Add your bank details',
     'You earn 70% of net revenue on every sale. Add your bank details under Payouts so you can request a payout once you are over the minimum.',
     null]
  ];

  const text = [
    `Hi ${name},`,
    '',
    `Congratulations: ${title} is live on 4flieks.`,
    '',
    `Watch it here: ${filmUrl}`,
    '',
    'What to do next:',
    '',
    ...steps.flatMap(([t, b, where], i) => [`${i + 1}. ${t}`, b + (where ? ` (${where})` : ''), '']),
    `Your film in the portal: ${portalUrl}`,
    `Payouts: ${payoutsUrl}`,
    '',
    'Questions? Just reply to this email.',
    '',
    'Julian and the 4flieks team',
    SITE.replace('https://', '')
  ].join('\n');

  const btn = (href, label, primary) =>
    `<a href="${escHtml(href)}" style="display:inline-block;padding:13px 22px;border-radius:10px;` +
    `font:700 15px/1 Arial,Helvetica,sans-serif;text-decoration:none;` +
    (primary ? 'background:#D85A2C;color:#1C1512' : 'background:#FBF6EC;color:#1C1512;border:1px solid #DCCFB9') +
    `">${escHtml(label)}</a>`;

  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F2EADA">
<div style="max-width:560px;margin:0 auto;padding:28px 18px;font-family:Arial,Helvetica,sans-serif;color:#1C1512">
  <div style="background:#1C1512;border-radius:14px;padding:22px 22px 18px">
    <img src="${SITE}/brand/png/logo-reversed-2x.png" width="260" alt="4flieks" style="display:block;width:260px;height:auto;border:0">
  </div>
  <p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#B0441A;font-weight:700;margin:26px 0 6px">Now showing</p>
  <h1 style="font-size:28px;line-height:1.2;margin:0 0 14px">${escHtml(title)} is live</h1>
  <p style="font-size:16px;line-height:1.55;margin:0 0 20px">Hi ${escHtml(name)}, congratulations. Your film is up on 4flieks and anyone can rent or buy it now.</p>
  <p style="margin:0 0 30px">${btn(filmUrl, 'See it live', false)}</p>

  <p style="font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#B0441A;font-weight:700;margin:0 0 12px">What to do next</p>
  ${steps.map(([t, b, where], i) => `
  <div style="background:#FBF6EC;border:1px solid #DCCFB9;border-radius:12px;padding:16px 18px;margin:0 0 10px">
    <p style="font-size:16px;font-weight:700;margin:0 0 6px">${i + 1}. ${escHtml(t)}</p>
    <p style="font-size:15px;line-height:1.5;color:#54483F;margin:0">${escHtml(b)}${where ? ` <span style="color:#1C1512">(${escHtml(where)})</span>` : ''}</p>
  </div>`).join('')}

  <p style="margin:22px 0 10px">${btn(portalUrl, 'Set up cast links', true)}</p>
  <p style="font-size:14px;line-height:1.5;color:#54483F;margin:0 0 26px">Your numbers update live in the portal. Questions? Just reply to this email.</p>
  <p style="font-size:15px;margin:0">Julian and the 4flieks team</p>
  <p style="font-size:13px;color:#6E6157;margin:4px 0 0"><a href="${SITE}" style="color:#6E6157">4flieks.com</a> · African independent films</p>
</div></body></html>`;

  return { subject, text, html };
}

async function sendLiveEmail(filmId, { force = false } = {}) {
  if (!filmId || /[.#$\[\]\/]/.test(filmId)) return { ok: false, reason: 'bad film id' };
  const film = await ops.dbGet(`flieks_films/${filmId}`);
  if (!film) return { ok: false, reason: 'film not found' };
  if (film.status !== 'live') return { ok: false, reason: 'the film is not live' };

  const marker = await ops.dbGet(`flieks_ops/live_emails/${filmId}`);
  if (marker && marker.status === 'sent' && !force) {
    return { ok: true, already: true, to: marker.to, at: marker.at };
  }

  const user = film.filmmaker_uid ? await ops.dbGet(`flieks_users/${film.filmmaker_uid}`) : null;
  const to = (user && user.email) || film.filmmaker_email;
  if (!to) return { ok: false, reason: 'no email address on file for this filmmaker' };

  const mail = liveEmail({
    name: firstName((user && (user.name || user.display_name)) || film.filmmaker),
    title: film.title || 'Your film',
    filmUrl: `${SITE}/${encodeURIComponent(film.slug || filmId)}`,
    portalUrl: `${SITE}/filmmaker?film=${encodeURIComponent(filmId)}`,
    payoutsUrl: `${SITE}/filmmaker`
  });

  const r = await ops.sendEmailTo({ to, ...mail, replyTo: REPLY_TO });
  await ops.dbWrite(`flieks_ops/live_emails/${filmId}`, {
    status: r.ok ? 'sent' : 'failed', to, at: Date.now(), reason: r.ok ? null : r.reason
  });
  return { ...r, to };
}

module.exports = { sendLiveEmail, liveEmail };
