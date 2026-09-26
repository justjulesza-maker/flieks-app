/**
 * flieks-podcasts — podcast channels and episodes: the catalogue, playback, and the Studio.
 *
 * Anyone:
 *   catalog                          live channels, and the newest episodes
 *   channel { slug }                 a channel and its episodes (no players)
 * Signed in (any account — this is what drives registration):
 *   play { episodeId }               the player; a paid episode needs a purchase
 * Studio (filmmakers for their own channels; admin for all):
 *   studio                           my channels with every episode (admin: all, plus the review queue)
 *   save-channel { channel }         new filmmaker channels wait for admin approval
 *   save-episode { episode, link? }  link = YouTube / Vimeo / Spotify / SoundCloud / Apple Podcasts
 *   bulk-add { channelId, links[] }  one episode per link, titles and pictures fetched automatically
 *   delete-episode { id }
 *   episode-media { episodeId, kind: 'video'|'audio', url }   after an upload: audio kept, video sent to Bunny
 *   link-bunny { episodeId, bunnyId }  use a video already in the Bunny library
 *   media-status { episodeId }
 * Admin:
 *   set-channel { id, status?, featured? }
 *   delete-channel { id }
 */
const https = require('https');
const crypto = require('crypto');
const ops = require('../lib/ops-core');
const P = require('../lib/podcasts');

const LIB = () => (process.env.BUNNY_LIBRARY_ID || '').trim();
const BKEY = () => (process.env.BUNNY_API_KEY || '').trim();
const BUNNY_HOST = () => (process.env.BUNNY_CDN_HOSTNAME || '').trim().replace(/^https?:\/\//, '');
const BUNNY_TOKEN = () => (process.env.BUNNY_TOKEN_KEY || '').trim();
const MAX_BULK = 50;

const reply = (code, obj, cache) => ({
  statusCode: code,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': cache ? 'public, max-age=60' : 'no-store' },
  body: JSON.stringify(obj)
});

async function lookup(token) {
  const key = process.env.FIREBASE_API_KEY;
  if (!token || !key) return null;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token })
  });
  const u = ((await r.json().catch(() => ({}))).users || [])[0];
  if (!u) return null;
  const profile = await ops.dbGet(`flieks_users/${u.localId}`) || {};
  return { uid: u.localId, email: u.email || '', role: profile.role || 'viewer', name: profile.name || u.displayName || '' };
}

function signedBunnyUrl(videoId) {
  const path = `/${videoId}/playlist.m3u8`;
  const base = `https://${BUNNY_HOST()}${path}`;
  if (!BUNNY_TOKEN()) return base;
  const expires = Math.floor(Date.now() / 1000) + 240 * 60;
  const token = crypto.createHash('sha256').update(BUNNY_TOKEN() + path + expires).digest('base64')
    .replace(/\n/g, '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${base}?token=${token}&expires=${expires}`;
}

async function bunny(path, method, body) {
  const r = await fetch(`https://video.bunnycdn.com/library/${LIB()}${path}`, {
    method, headers: { AccessKey: BKEY(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
}
const BUNNY_STATE = { 0: 'queued', 1: 'processing', 2: 'processing', 3: 'processing', 4: 'ready', 5: 'failed', 6: 'uploading', 7: 'transcoding' };

async function loadAll() {
  const [channels, episodes] = await Promise.all([ops.dbGet('flieks_pod_channels'), ops.dbGet('flieks_pod_episodes')]);
  return { channels: channels || {}, episodes: episodes || {} };
}

const canEdit = (me, ch) => !!ch && (me.role === 'admin' || ch.owner_uid === me.uid);
const isStudioUser = me => me.role === 'admin' || me.role === 'filmmaker';

async function uniqueSlug(title, exceptId) {
  const base = P.slugify(title) || 'podcast';
  let slug = base, n = 2;
  for (;;) {
    const held = await ops.dbGet(`flieks_pod_slugs/${slug}`);
    if (!held || held === exceptId) return slug;
    slug = `${base}-${n++}`;
  }
}

exports.handler = async event => {
  if (event.httpMethod !== 'POST') return reply(405, { message: 'POST only' });
  let b;
  try { b = JSON.parse(event.body || '{}'); } catch { return reply(400, { message: 'Bad request.' }); }
  const a = b.action;
  try {
    /* ---------------- public ---------------- */
    if (a === 'catalog') {
      const { channels, episodes } = await loadAll();
      const eps = Object.entries(episodes).filter(([, e]) => e && e.status === 'live' && channels[e.channel_id] && channels[e.channel_id].status === 'live')
        .map(([id, e]) => P.publicEpisode(id, e));
      const list = Object.entries(channels).filter(([, c]) => c && c.status === 'live')
        .map(([id, c]) => P.publicChannel(id, c, eps)).filter(c => c.episodes)
        .sort((x, y) => (y.featured - x.featured) || (y.latest_at - x.latest_at));
      const slugOf = id => (channels[id] || {}).slug, titleOf = id => (channels[id] || {}).title;
      const latest = eps.sort((x, y) => y.published_at - x.published_at).slice(0, 12)
        .map(e => ({ ...e, channel_slug: slugOf(e.channel_id), channel_title: titleOf(e.channel_id) }));
      return reply(200, { channels: list, latest }, true);
    }

    if (a === 'channel') {
      const id = await ops.dbGet(`flieks_pod_slugs/${P.slugify(b.slug || '')}`);
      const ch = id && await ops.dbGet(`flieks_pod_channels/${id}`);
      if (!ch || ch.status !== 'live') return reply(404, { message: 'That podcast isn\'t available.' });
      const all = await ops.dbGet('flieks_pod_episodes') || {};
      const eps = Object.entries(all).filter(([, e]) => e && e.channel_id === id && e.status === 'live').map(([eid, e]) => P.publicEpisode(eid, e))
        .sort((x, y) => (y.number || 0) - (x.number || 0) || y.published_at - x.published_at);
      let maker = null;
      if (ch.owner_uid) { const m = await ops.dbGet(`flieks_makers/${ch.owner_uid}`); if (m && m.slug) maker = { slug: m.slug, name: m.name }; }
      return reply(200, { channel: { ...P.publicChannel(id, ch, eps), maker }, episodes: eps }, true);
    }

    const me = await lookup(b.token);
    if (!me) return reply(401, { message: 'Create a free account or sign in to watch and listen.', code: 'signin' });

    /* ---------------- playback ---------------- */
    if (a === 'play') {
      if (!P.okId(b.episodeId)) return reply(404, { message: 'Episode not found.' });
      const ep = await ops.dbGet(`flieks_pod_episodes/${b.episodeId}`);
      const ch = ep && await ops.dbGet(`flieks_pod_channels/${ep.channel_id}`);
      const mine = canEdit(me, ch);
      if (!ep || !ch || (!mine && (ep.status !== 'live' || ch.status !== 'live'))) return reply(404, { message: 'Episode not found.' });
      if (ep.price > 0 && !mine) {
        const bought = await ops.dbGet(`flieks_purchases/${me.uid}/pod_${b.episodeId}`);
        if (!bought) return reply(402, { message: `This masterclass is R${ep.price}.`, code: 'buy', price: ep.price });
      }
      await ops.dbWrite(`flieks_pod_stats/${b.episodeId}/plays`, ((await ops.dbGet(`flieks_pod_stats/${b.episodeId}/plays`)) || 0) + 1);
      const embed = P.embedFor(ep);
      if (embed) return reply(200, { player: embed });
      const priv = await ops.dbGet(`flieks_private/pod_${b.episodeId}`) || {};
      if (ep.kind === 'audio' && priv.audio_url) return reply(200, { player: { type: 'audio', url: priv.audio_url } });
      if (priv.bunny_id && BUNNY_HOST() && priv.bunny_ready !== false) return reply(200, { player: { type: 'hls', url: signedBunnyUrl(priv.bunny_id), fallback: priv.video_url || null } });
      if (priv.video_url) return reply(200, { player: { type: 'video', url: priv.video_url } });
      return reply(404, { message: 'This episode is still being prepared. Try again in a few minutes.' });
    }

    /* ---------------- studio ---------------- */
    if (!isStudioUser(me)) return reply(403, { message: 'The Podcast Studio is for filmmakers. Apply to be a filmmaker to add a podcast.' });

    if (a === 'studio') {
      const { channels, episodes } = await loadAll();
      const privs = await ops.dbGet('flieks_private') || {};
      const mineCh = Object.entries(channels).filter(([, c]) => c && (me.role === 'admin' || c.owner_uid === me.uid));
      const out = mineCh.map(([id, c]) => ({
        id, ...c,
        episodes: Object.entries(episodes).filter(([, e]) => e && e.channel_id === id).map(([eid, e]) => {
          const pv = privs[`pod_${eid}`] || {};
          return { id: eid, ...e, media: { bunny: !!pv.bunny_id, bunny_ready: !!pv.bunny_ready, audio: !!pv.audio_url, video: !!pv.video_url } };
        }).sort((x, y) => (y.number || 0) - (x.number || 0) || (y.created_at || 0) - (x.created_at || 0))
      })).sort((x, y) => (x.status === 'pending' ? -1 : 0) - (y.status === 'pending' ? -1 : 0) || (y.updated_at || 0) - (x.updated_at || 0));
      return reply(200, { role: me.role, channels: out, bunny: !!(LIB() && BKEY()) });
    }

    if (a === 'save-channel') {
      const c = P.cleanChannel(b.channel);
      if (c.title.length < 2) return reply(400, { message: 'Give the channel a name.' });
      const id = b.channel && b.channel.id;
      if (id) {
        const prev = P.okId(id) && await ops.dbGet(`flieks_pod_channels/${id}`);
        if (!canEdit(me, prev)) return reply(404, { message: 'Channel not found.' });
        await ops.dbWrite(`flieks_pod_channels/${id}`, { ...c, updated_at: Date.now() }, 'PATCH');
        return reply(200, { ok: true, id });
      }
      const newId = crypto.randomBytes(6).toString('hex');
      const slug = await uniqueSlug(c.title, newId);
      const status = me.role === 'admin' ? 'live' : 'pending';
      await ops.dbWrite(`flieks_pod_slugs/${slug}`, newId);
      await ops.dbWrite(`flieks_pod_channels/${newId}`, { ...c, host: c.host || me.name || null, slug, owner_uid: me.uid, status, featured: false, created_at: Date.now(), updated_at: Date.now() });
      if (status === 'pending') await ops.sendEmailTo({ to: process.env.OPS_EMAIL_TO || process.env.SUPPORT_EMAIL, subject: `New podcast channel to approve: ${c.title}`,
        text: `${me.name || me.email} added a podcast channel, "${c.title}". Approve it in the Podcast Studio: ${ops.SITE}/studio` }).catch(() => {});
      return reply(200, { ok: true, id: newId, status });
    }

    if (a === 'save-episode') {
      const e = b.episode || {};
      const ch = P.okId(e.channel_id) && await ops.dbGet(`flieks_pod_channels/${e.channel_id}`);
      if (!canEdit(me, ch)) return reply(404, { message: 'Channel not found.' });
      const clean = P.cleanEpisode(e);
      let prev = null;
      if (e.id) { prev = P.okId(e.id) && await ops.dbGet(`flieks_pod_episodes/${e.id}`); if (!prev || prev.channel_id !== e.channel_id) return reply(404, { message: 'Episode not found.' }); }
      let media = {};
      if (b.link) {
        const link = P.parseLink(b.link);
        if (!link) return reply(400, { message: 'That link isn\'t one we can play. Use a YouTube, Vimeo, Spotify, SoundCloud or Apple Podcasts link.' });
        const found = await P.lookupDetails(link);
        media = { source: link.source, kind: link.kind, ref: link.ref };
        if (!clean.title) clean.title = found.title || '';
        if (!clean.thumbnail_url) clean.thumbnail_url = found.thumbnail_url || null;
        if (!clean.duration_mins && found.duration_mins) clean.duration_mins = found.duration_mins;
      } else if (!prev) {
        const kind = e.kind === 'audio' ? 'audio' : 'video';
        media = { source: 'upload', kind, ref: null };
      }
      if (!clean.title) return reply(400, { message: 'Give the episode a title.' });
      const id = e.id || crypto.randomBytes(6).toString('hex');
      const now = Date.now();
      const rec = { ...(prev || {}), ...clean, ...media, channel_id: e.channel_id, updated_at: now,
        created_at: (prev && prev.created_at) || now, published_at: (prev && prev.published_at) || (clean.status === 'live' ? now : null) };
      if (rec.status === 'live' && !rec.published_at) rec.published_at = now;
      await ops.dbWrite(`flieks_pod_episodes/${id}`, rec);
      await ops.dbWrite(`flieks_pod_channels/${e.channel_id}/updated_at`, now);
      return reply(200, { ok: true, id, episode: rec });
    }

    if (a === 'bulk-add') {
      const ch = P.okId(b.channelId) && await ops.dbGet(`flieks_pod_channels/${b.channelId}`);
      if (!canEdit(me, ch)) return reply(404, { message: 'Channel not found.' });
      const links = (Array.isArray(b.links) ? b.links : []).map(l => String(l).trim()).filter(Boolean).slice(0, MAX_BULK);
      const all = await ops.dbGet('flieks_pod_episodes') || {};
      let n = Object.values(all).filter(e => e && e.channel_id === b.channelId).reduce((m, e) => Math.max(m, e.number || 0), 0);
      const added = [], skipped = [];
      const existing = new Set(Object.values(all).filter(e => e && e.channel_id === b.channelId).map(e => `${e.source}:${e.ref}`));
      for (const raw of links) {
        const link = P.parseLink(raw);
        if (!link) { skipped.push({ link: raw.slice(0, 120), why: 'not a link we can play' }); continue; }
        if (existing.has(`${link.source}:${link.ref}`)) { skipped.push({ link: raw.slice(0, 120), why: 'already in this channel' }); continue; }
        existing.add(`${link.source}:${link.ref}`);
        const found = await P.lookupDetails(link);
        const id = crypto.randomBytes(6).toString('hex'), now = Date.now();
        const rec = { channel_id: b.channelId, title: found.title || `Episode ${n + 1}`, description: null, number: ++n,
          kind: link.kind, source: link.source, ref: link.ref, thumbnail_url: found.thumbnail_url || null,
          duration_mins: found.duration_mins || null, price: 0, status: 'live', created_at: now, updated_at: now, published_at: now + added.length };
        await ops.dbWrite(`flieks_pod_episodes/${id}`, rec);
        added.push({ id, title: rec.title, number: rec.number });
      }
      if (added.length) await ops.dbWrite(`flieks_pod_channels/${b.channelId}/updated_at`, Date.now());
      return reply(200, { ok: true, added, skipped });
    }

    // Everything below acts on one episode the caller may edit.
    if (['delete-episode', 'episode-media', 'link-bunny', 'media-status'].includes(a)) {
      const eid = b.id || b.episodeId;
      const ep = P.okId(eid) && await ops.dbGet(`flieks_pod_episodes/${eid}`);
      const ch = ep && await ops.dbGet(`flieks_pod_channels/${ep.channel_id}`);
      if (!canEdit(me, ch)) return reply(404, { message: 'Episode not found.' });

      if (a === 'delete-episode') {
        const priv = await ops.dbGet(`flieks_private/pod_${eid}`) || {};
        if (priv.bunny_id && LIB()) await bunny(`/videos/${priv.bunny_id}`, 'DELETE').catch(() => {});
        await ops.dbWrite(`flieks_pod_episodes/${eid}`, null);
        await ops.dbWrite(`flieks_private/pod_${eid}`, null);
        return reply(200, { ok: true });
      }

      if (a === 'episode-media') {
        const url = String(b.url || '');
        if (!/^https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/[^/]+\/o\/flieks_podcasts%2F/.test(url)) return reply(400, { message: 'Upload the file first.' });
        if (b.kind === 'audio') {
          await ops.dbWrite(`flieks_private/pod_${eid}`, { audio_url: url }, 'PATCH');
          await ops.dbWrite(`flieks_pod_episodes/${eid}`, { source: 'upload', kind: 'audio', ref: null }, 'PATCH');
          return reply(200, { ok: true, ready: true });
        }
        await ops.dbWrite(`flieks_private/pod_${eid}`, { video_url: url }, 'PATCH');
        await ops.dbWrite(`flieks_pod_episodes/${eid}`, { source: 'upload', kind: 'video', ref: null }, 'PATCH');
        if (!LIB() || !BKEY()) return reply(200, { ok: true, ready: true, note: 'Saved. It plays from the upload (Bunny isn\'t set up).' });
        const made = await bunny('/videos', 'POST', { title: `Podcast: ${ep.title}`.slice(0, 120) });
        if (made.status >= 400 || !made.data.guid) return reply(200, { ok: true, ready: true, note: 'Saved. Bunny didn\'t accept it, so it plays from the upload.' });
        await ops.dbWrite(`flieks_private/pod_${eid}`, { bunny_id: made.data.guid, bunny_ready: false, bunny_started_at: Date.now() }, 'PATCH');
        // The same background mover films use (it gets 15 minutes).
        const origin = `https://${(event.headers || {}).host || '4flieks.com'}`;
        await new Promise(done => {
          const body = JSON.stringify({ filmId: `pod_${eid}`, videoId: made.data.guid, source: url, secret: process.env.FIREBASE_DB_SECRET });
          const r = https.request(`${origin}/.netlify/functions/flieks-bunny-upload-background`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          }, res => { res.resume(); res.on('end', done); });
          r.on('error', () => done()); r.write(body); r.end();
        });
        return reply(200, { ok: true, ready: false, note: 'Uploaded. Bunny is preparing it for streaming; it plays from the upload until then.' });
      }

      if (a === 'link-bunny') {
        const id = String(b.bunnyId || '').trim();
        if (!/^[0-9a-f-]{20,40}$/i.test(id)) return reply(400, { message: 'That doesn\'t look like a Bunny video ID.' });
        const v = await bunny(`/videos/${id}`, 'GET');
        if (v.status >= 400 || !v.data.guid) return reply(404, { message: 'Bunny has no video with that ID.' });
        await ops.dbWrite(`flieks_private/pod_${eid}`, { bunny_id: id, bunny_ready: BUNNY_STATE[v.data.status] === 'ready' }, 'PATCH');
        await ops.dbWrite(`flieks_pod_episodes/${eid}`, { source: 'bunny', kind: 'video', ref: null,
          ...(ep.duration_mins ? {} : v.data.length ? { duration_mins: Math.max(1, Math.round(v.data.length / 60)) } : {}) }, 'PATCH');
        return reply(200, { ok: true, state: BUNNY_STATE[v.data.status] || 'unknown' });
      }

      if (a === 'media-status') {
        const priv = await ops.dbGet(`flieks_private/pod_${eid}`) || {};
        if (!priv.bunny_id) return reply(200, { state: priv.audio_url ? 'audio ready' : priv.video_url ? 'uploaded' : 'no file yet' });
        const v = await bunny(`/videos/${priv.bunny_id}`, 'GET');
        const state = BUNNY_STATE[v.data.status] || 'unknown';
        if (state === 'ready' && !priv.bunny_ready) {
          await ops.dbWrite(`flieks_private/pod_${eid}/bunny_ready`, true);
          if (!ep.duration_mins && v.data.length) await ops.dbWrite(`flieks_pod_episodes/${eid}/duration_mins`, Math.max(1, Math.round(v.data.length / 60)));
        }
        return reply(200, { state, progress: v.data.encodeProgress || 0 });
      }
    }

    /* ---------------- admin ---------------- */
    if (a === 'set-channel' || a === 'delete-channel') {
      if (me.role !== 'admin') return reply(403, { message: 'Admin only.' });
      const ch = P.okId(b.id) && await ops.dbGet(`flieks_pod_channels/${b.id}`);
      if (!ch) return reply(404, { message: 'Channel not found.' });
      if (a === 'delete-channel') {
        const all = await ops.dbGet('flieks_pod_episodes') || {};
        for (const [eid, e] of Object.entries(all)) if (e && e.channel_id === b.id) { await ops.dbWrite(`flieks_pod_episodes/${eid}`, null); await ops.dbWrite(`flieks_private/pod_${eid}`, null); }
        await ops.dbWrite(`flieks_pod_slugs/${ch.slug}`, null);
        await ops.dbWrite(`flieks_pod_channels/${b.id}`, null);
        return reply(200, { ok: true });
      }
      const patch = { updated_at: Date.now() };
      if (['live', 'pending', 'rejected'].includes(b.status)) patch.status = b.status;
      if (typeof b.featured === 'boolean') patch.featured = b.featured;
      await ops.dbWrite(`flieks_pod_channels/${b.id}`, patch, 'PATCH');
      if (patch.status === 'live' && ch.status === 'pending' && ch.owner_uid) {
        const owner = await ops.dbGet(`flieks_users/${ch.owner_uid}`);
        if (owner && owner.email) await ops.sendEmailTo({ to: owner.email, subject: `Your podcast "${ch.title}" is live on 4flieks`,
          text: `Hi ${(owner.name || '').split(' ')[0] || 'there'},\n\n"${ch.title}" is approved and live: ${ops.SITE}/podcasts/${ch.slug}\n\nAdd episodes any time in the Podcast Studio: ${ops.SITE}/studio\n\nThe 4flieks team` }).catch(() => {});
      }
      return reply(200, { ok: true });
    }

    return reply(400, { message: 'Unknown action.' });
  } catch (e) {
    console.error('[podcasts]', a, e);
    return reply(500, { message: 'Something went wrong. Try again.' });
  }
};
