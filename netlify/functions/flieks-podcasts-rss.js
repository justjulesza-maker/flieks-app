/**
 * flieks-podcasts-rss — brings in new episodes for podcast channels that follow
 * an RSS feed (auto on). Scheduled in netlify.toml every three hours; scheduled
 * functions can't be called from the web, so this takes no input.
 * See netlify/lib/podcast-rss.js.
 */
const ops = require('../lib/ops-core');
const RSS = require('../lib/podcast-rss');

exports.handler = async () => {
  const channels = await ops.dbGet('flieks_pod_channels').catch(() => null) || {};
  const due = Object.entries(channels).filter(([, c]) => c && c.rss && c.rss.url && c.rss.auto !== false && c.status !== 'rejected');
  const out = [];
  for (const [id, c] of due) {
    try {
      const r = await ops.withLock(`pod_rss_${id}`, () => RSS.syncChannel(ops, id, { by: 'schedule' }), { ttl: 40e3, wait: 2e3 });
      out.push(`${c.slug}: +${r.added}${r.refreshed ? ` (${r.refreshed} links updated)` : ''}`);
    } catch (e) { out.push(`${c.slug}: ${e.busy ? 'busy, next time' : 'failed: ' + e.message}`); }
  }
  console.log('[podcasts-rss]', due.length ? out.join(' · ') : 'no channels follow a feed');
  return { statusCode: 200, body: 'ok' };
};
