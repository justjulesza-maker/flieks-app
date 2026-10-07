/**
 * crm-send-background — sends one CRM campaign (see netlify/lib/crm.js runCampaign).
 * Started by flieks-crm 'send'. Needs the x-job-secret header. Safe to start
 * twice: a lock keeps it to one run, and anyone already sent to is skipped.
 */
const crm = require('../lib/crm');

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  if (!process.env.FIREBASE_DB_SECRET || (event.headers || {})['x-job-secret'] !== crm.jobSecret()) return { statusCode: 403, body: 'no' };
  let id = '';
  try { id = String(JSON.parse(event.body || '{}').id || ''); } catch {}
  try {
    console.log('[crm-send]', id, JSON.stringify(await crm.runCampaign(id)));
  } catch (e) {
    if (e.busy) console.log('[crm-send]', id, 'already sending');
    else {
      // Leave it resumable from /crm rather than stuck on "sending".
      console.error('[crm-send]', id, e);
      await crm.markFailed(id, e.message);
    }
  }
  return { statusCode: 200, body: 'done' };
};
