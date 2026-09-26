/**
 * flieks-ops-watch — urgent alerts. Scheduled in netlify.toml every 15 min.
 *
 * Messages Julian straight away, once per thing, when:
 *   - someone paid (confirmed with Yoco) but has no access
 *   - a film is submitted (or re-submitted) for review
 *   - someone applies to be a filmmaker
 *   - a filmmaker requests a payout
 *   - a support ticket comes in
 * It also sends trailer-premiere reminders when a premiere time passes.
 * Abandoned checkouts never alert. Several things at once go out as one
 * message. What has been alerted on is remembered in flieks_ops/seen.
 */
const ops = require('../lib/ops-core');
const { startNotify } = require('../lib/watchlist');

/* Trailer premieres: once the premiere time passes, email everyone who asked
   for a reminder. Once per film (flieks_ops/premiere_kicked); the email itself
   also skips anyone already sent it. */
async function premiereReminders() {
  const [films, kicked] = await Promise.all([ops.dbGet('flieks_films'), ops.dbGet('flieks_ops/premiere_kicked')]);
  const now = Date.now();
  for (const [id, f] of Object.entries(films || {})) {
    if (!f || !f.premiere || !f.premiere_at || f.premiere_at > now) continue;
    if (now - f.premiere_at > 7 * 864e5 || (kicked || {})[id]) continue;
    await ops.dbWrite(`flieks_ops/premiere_kicked/${id}`, { at: now, by: 'schedule' });
    const ok = await startNotify(id, { kind: 'premiere' });
    console.log('[ops-watch] premiere reminders', id, ok ? 'started' : 'did not start');
  }
}

const LABEL = {
  paidNoAccess: n => `${n} buyer${n === 1 ? '' : 's'} paid but got no access`,
  filmReview:   n => `${n} film${n === 1 ? '' : 's'} waiting for review`,
  application:  n => `${n} new filmmaker application${n === 1 ? '' : 's'}`,
  payout:       n => `${n} payout request${n === 1 ? '' : 's'}`,
  support:      n => `${n} new support ticket${n === 1 ? '' : 's'}`
};

exports.handler = async () => {
  await premiereReminders().catch(e => console.error('[ops-watch] premiere reminders', e));
  try {
    const [facts, seenRaw] = await Promise.all([
      ops.buildFacts(),
      ops.dbGet('flieks_ops/seen').catch(() => null)
    ]);
    const seen = seenRaw || {};
    const firstRun = !seenRaw;

    const fresh = {};
    for (const [kind, keys] of Object.entries(facts.alertKeys)) {
      const before = new Set(seen[kind] || []);
      fresh[kind] = keys.filter(k => !before.has(k));
    }

    // Remember everything current (so resolved things drop out, and a
    // re-submitted film alerts again because its key includes the time).
    const next = Object.fromEntries(Object.entries(facts.alertKeys).map(([k, v]) => [k, v.slice(0, 200)]));
    await ops.dbWrite('flieks_ops/seen', next);

    // The very first run only records what's already there — no flood of
    // alerts about things you already know about.
    if (firstRun) { console.log('[ops-watch] first run: baseline recorded'); return { statusCode: 200, body: 'baseline' }; }

    const parts = Object.entries(fresh).filter(([, v]) => v.length).map(([k, v]) => LABEL[k](v.length));
    if (!parts.length) return { statusCode: 200, body: 'quiet' };

    const headline = parts.join(' · ');
    const detail = facts.attention.filter(a => a.level !== 'fyi').slice(0, 8).map(a => '- ' + a.text).join('\n');
    const sent = await ops.notify('alert', headline, detail || headline);
    console.log('[ops-watch] alert:', headline, JSON.stringify(sent));
    return { statusCode: 200, body: 'alerted' };
  } catch (e) {
    console.error('[ops-watch]', e);
    return { statusCode: 500, body: e.message };
  }
};
