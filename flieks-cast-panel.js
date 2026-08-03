/* ============================================================================
   flieks-cast-panel.js
   A cast manager that drops into the existing filmmaker.html.

   Filmmakers manage their own cast. Each member gets a tracked link and QR
   for selling to their own audience.

   USE:
     <script src="/flieks-social.js"></script>
     <script src="/flieks-cast-panel.js"></script>

     FlieksCastPanel.mount('#castPanel', {
       filmId:   currentFilmId,
       filmSlug: film.slug,
       canEdit:  true            // false renders read-only
     });

   Requires firebase.database() and firebase.storage() already initialised.
   ============================================================================ */
(function (global) {
'use strict';

const db = () => firebase.database();
const store = () => firebase.storage();
const esc = s => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
const slugify = s => (global.FlieksSocial ? FlieksSocial.slugify(s)
  : String(s||'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60));

const NETWORKS = { instagram:'Instagram', tiktok:'TikTok', x:'X', youtube:'YouTube', facebook:'Facebook' };

let state = { el:null, filmId:null, filmSlug:null, canEdit:true, cast:{} };

function linkFor(slug) {
  const base = location.origin;
  const f = state.filmSlug || state.filmId;
  return `${base}/${encodeURIComponent(f)}?a=${encodeURIComponent(slug)}`;
}
function qrFor(url, size) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&ecc=H&margin=8&data=${encodeURIComponent(url)}`;
}

async function load() {
  const s = await db().ref('flieks_cast/' + state.filmId).get().catch(() => null);
  state.cast = (s && s.val()) || {};
}

function styles() {
  if (document.getElementById('fcp-css')) return;
  const s = document.createElement('style');
  s.id = 'fcp-css';
  s.textContent = `
  .fcp-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
  .fcp-hint{font-size:13px;opacity:.65;margin-bottom:16px;max-width:62ch;line-height:1.5}
  .fcp-row{display:grid;grid-template-columns:58px 1fr auto;gap:14px;align-items:start;
    padding:15px 0;border-bottom:1px solid rgba(128,128,128,.2)}
  .fcp-row:last-of-type{border-bottom:0}
  .fcp-face{width:58px;height:58px;border-radius:50%;object-fit:cover;background:rgba(128,128,128,.15)}
  .fcp-name{font-weight:700;font-size:15px}
  .fcp-meta{font-size:12px;opacity:.6;margin-top:2px}
  .fcp-link{font-family:ui-monospace,monospace;font-size:11px;opacity:.55;margin-top:5px;word-break:break-all}
  .fcp-tools{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:9px}
  .fcp-qr{width:74px;height:74px;background:#fff;border-radius:4px;padding:4px}
  .fcp-btns{display:flex;gap:6px;flex-wrap:wrap}
  .fcp-b{font:inherit;font-size:11px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;
    padding:8px 12px;min-height:36px;border-radius:4px;border:1px solid rgba(128,128,128,.35);
    background:transparent;color:inherit;text-decoration:none;display:inline-flex;align-items:center}
  .fcp-b:hover{border-color:#D85A2C;color:#D85A2C}
  .fcp-b.primary{background:#D85A2C;border-color:#D85A2C;color:#fff}
  .fcp-b.primary:hover{background:#c14e24;color:#fff}
  .fcp-b.danger:hover{border-color:#E5484D;color:#E5484D}
  .fcp-form{border:1px solid #D85A2C;border-radius:6px;padding:18px;margin-top:16px}
  .fcp-grid{display:grid;gap:12px}
  @media(min-width:620px){.fcp-grid.two{grid-template-columns:1fr 1fr}
    .fcp-grid.three{grid-template-columns:1fr 1fr 1fr}}
  .fcp-f label{display:block;font-size:11px;letter-spacing:.1em;text-transform:uppercase;opacity:.6;margin-bottom:5px}
  .fcp-f input{width:100%;font:inherit;font-size:16px;padding:10px;border-radius:4px;
    border:1px solid rgba(128,128,128,.35);background:rgba(128,128,128,.08);color:inherit}
  .fcp-f input:focus{border-color:#D85A2C;outline:none}
  .fcp-f .note{font-size:11px;opacity:.55;margin-top:4px}
  .fcp-drop{border:1px dashed rgba(128,128,128,.4);border-radius:5px;padding:16px;text-align:center;
    cursor:pointer;font-size:13px;opacity:.75;margin-top:4px}
  .fcp-drop:hover{border-color:#D85A2C;opacity:1}
  .fcp-prog{height:3px;background:rgba(128,128,128,.2);border-radius:2px;margin-top:8px;overflow:hidden;display:none}
  .fcp-prog i{display:block;height:100%;background:#D85A2C;width:0}
  .fcp-msg{font-size:13px;opacity:.7}
  .fcp-msg.bad{color:#E5484D;opacity:1}
  .fcp-msg.ok{color:#2E9E6B;opacity:1}
  .fcp-empty{opacity:.6;font-size:14px;padding:14px 0}
  .fcp-count{font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.55}`;
  document.head.appendChild(s);
}

function render() {
  const rows = Object.entries(state.cast).sort((a,b) => (a[1].order??99)-(b[1].order??99));
  state.el.innerHTML = `
    <div class="fcp-head">
      <h3 style="margin:0">Cast</h3>
      <span class="fcp-count">${rows.length} ${rows.length===1?'person':'people'}</span>
    </div>
    <p class="fcp-hint">Each person gets their own link and QR code. When someone buys through
    it, that sale is recorded against them — so you can see who is actually selling your film.</p>
    <div id="fcpList">${rows.length ? rows.map(([slug,c]) => {
      const url = linkFor(slug);
      return `<div class="fcp-row">
        <img class="fcp-face" src="${esc(c.photoUrl||'')}" alt="">
        <div>
          <div class="fcp-name">${esc(c.name)}</div>
          <div class="fcp-meta">${esc(c.role||'')}${c.reach?' · '+esc(c.reach)+' following':''}</div>
          <div class="fcp-link">${esc(url)}</div>
          <div class="fcp-tools">
            <img class="fcp-qr" src="${qrFor(url,160)}" alt="QR code" loading="lazy">
            <div class="fcp-btns">
              <button class="fcp-b" data-copy="${esc(url)}">Copy link</button>
              <a class="fcp-b" href="${qrFor(url,1000)}" target="_blank" rel="noopener">Download QR</a>
              <button class="fcp-b" data-share="${esc(slug)}">Send to them</button>
            </div>
          </div>
        </div>
        <div class="fcp-btns" style="flex-direction:column">
          ${state.canEdit ? `<button class="fcp-b" data-edit="${esc(slug)}">Edit</button>
          <button class="fcp-b danger" data-del="${esc(slug)}">Remove</button>` : ''}
        </div>
      </div>`;
    }).join('') : '<p class="fcp-empty">No cast added yet. Add the first person below.</p>'}</div>
    ${state.canEdit ? '<button class="fcp-b primary" id="fcpAdd" style="margin-top:14px">Add cast member</button>' : ''}
    <div id="fcpEditor"></div>`;

  state.el.querySelectorAll('[data-copy]').forEach(b => b.onclick = () => {
    navigator.clipboard.writeText(b.dataset.copy);
    const w = b.textContent; b.textContent = 'Copied';
    setTimeout(() => b.textContent = w, 1500);
  });

  state.el.querySelectorAll('[data-share]').forEach(b => b.onclick = async () => {
    const c = state.cast[b.dataset.share];
    const url = linkFor(b.dataset.share);
    const text = `Here's your link for the film — anything bought through it counts as yours:\n${url}`;
    if (navigator.share) { try { await navigator.share({ text }); } catch {} }
    else { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(()=>b.textContent='Send to them',1500); }
  });

  if (state.canEdit) {
    state.el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => form(b.dataset.edit));
    state.el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm(`Remove ${state.cast[b.dataset.del].name}? Any clicks and sales already recorded stay in your stats.`)) return;
      await db().ref(`flieks_cast/${state.filmId}/${b.dataset.del}`).remove();
      await load(); render();
    });
    const add = state.el.querySelector('#fcpAdd');
    if (add) add.onclick = () => form(null);
  }
}

function form(slug) {
  const c = slug ? state.cast[slug] : {};
  const ed = state.el.querySelector('#fcpEditor');
  ed.innerHTML = `
  <div class="fcp-form">
    <h4 style="margin:0 0 14px">${slug ? 'Edit ' + esc(c.name) : 'New cast member'}</h4>
    <div class="fcp-grid two">
      <div class="fcp-f"><label>Name</label><input id="fcpName" value="${esc(c.name)}"></div>
      <div class="fcp-f"><label>Character</label><input id="fcpRole" value="${esc(c.role)}"></div>
    </div>
    <div class="fcp-grid three" style="margin-top:12px">
      <div class="fcp-f"><label>Link name</label>
        <input id="fcpSlug" value="${esc(slug||'')}" ${slug?'disabled':''}>
        <div class="note">${slug ? "Can't change — links already shared would break."
                                 : 'Fills in from their name.'}</div></div>
      <div class="fcp-f"><label>Billing order</label>
        <input id="fcpOrder" type="number" value="${c.order ?? Object.keys(state.cast).length+1}"></div>
      <div class="fcp-f"><label>Following</label>
        <input id="fcpReach" value="${esc(c.reach)}" placeholder="120k"></div>
    </div>
    <div class="fcp-f" style="margin-top:12px"><label>Photo</label>
      <input id="fcpPhoto" value="${esc(c.photoUrl)}" placeholder="Upload below, or paste a URL">
      <div class="fcp-drop" id="fcpDrop">Drop a headshot, or click to choose
        <div class="fcp-prog"><i></i></div></div></div>
    <div class="fcp-grid two" style="margin-top:12px">
      <div class="fcp-f"><label>Instagram</label><input id="fcpIg" value="${esc(c.instagram)}" placeholder="https://instagram.com/…"></div>
      <div class="fcp-f"><label>TikTok</label><input id="fcpTt" value="${esc(c.tiktok)}" placeholder="https://tiktok.com/@…"></div>
      <div class="fcp-f"><label>X</label><input id="fcpX" value="${esc(c.x)}"></div>
      <div class="fcp-f"><label>YouTube</label><input id="fcpYt" value="${esc(c.youtube)}"></div>
    </div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:16px;flex-wrap:wrap">
      <button class="fcp-b primary" id="fcpSave">${slug?'Save':'Add to cast'}</button>
      <button class="fcp-b" id="fcpCancel">Cancel</button>
      <span class="fcp-msg" id="fcpMsg"></span>
    </div>
  </div>`;
  ed.scrollIntoView({ behavior:'smooth', block:'nearest' });

  const $ = s => ed.querySelector(s);
  if (!slug) $('#fcpName').oninput = () => $('#fcpSlug').value = slugify($('#fcpName').value);
  $('#fcpCancel').onclick = () => ed.innerHTML = '';
  uploader($('#fcpDrop'), `flieks_cast/${state.filmId}/${slug || 'new-'+Date.now()}`,
           u => $('#fcpPhoto').value = u);

  $('#fcpSave').onclick = async () => {
    const key = slug || slugify($('#fcpSlug').value || $('#fcpName').value);
    const m = $('#fcpMsg'); m.className = 'fcp-msg';
    if (!$('#fcpName').value.trim()) { m.className='fcp-msg bad'; m.textContent='Name is required.'; return; }
    if (!key) { m.className='fcp-msg bad'; m.textContent='Needs a link name.'; return; }
    if (!slug && state.cast[key]) { m.className='fcp-msg bad'; m.textContent='That link name is taken.'; return; }
    m.textContent = 'Saving…';
    try {
      await db().ref(`flieks_cast/${state.filmId}/${key}`).update({
        name: $('#fcpName').value.trim(), role: $('#fcpRole').value.trim(),
        order: +$('#fcpOrder').value || 99, reach: $('#fcpReach').value.trim(),
        photoUrl: $('#fcpPhoto').value.trim(),
        instagram: $('#fcpIg').value.trim(), tiktok: $('#fcpTt').value.trim(),
        x: $('#fcpX').value.trim(), youtube: $('#fcpYt').value.trim()
      });
      ed.innerHTML = ''; await load(); render();
    } catch { m.className='fcp-msg bad'; m.textContent='Could not save. Try again.'; }
  };
}

function uploader(el, path, done) {
  if (!el) return;
  const input = document.createElement('input');
  input.type='file'; input.accept='image/*'; input.style.display='none';
  document.body.appendChild(input);
  const start = file => {
    if (!file) return;
    const ext = (file.name.split('.').pop()||'jpg').toLowerCase();
    const task = store().ref(`${path}.${ext}`).put(file);
    const p = el.querySelector('.fcp-prog'); p.style.display='block';
    task.on('state_changed',
      s => p.querySelector('i').style.width = (s.bytesTransferred/s.totalBytes*100)+'%',
      () => { p.style.display='none'; alert('Upload failed. Check your connection and try again.'); },
      async () => { p.style.display='none'; done(await task.snapshot.ref.getDownloadURL()); });
  };
  el.onclick = () => input.click();
  input.onchange = () => start(input.files[0]);
  el.ondragover = e => { e.preventDefault(); el.style.borderColor = '#D85A2C'; };
  el.ondragleave = () => el.style.borderColor = '';
  el.ondrop = e => { e.preventDefault(); el.style.borderColor=''; start(e.dataTransfer.files[0]); };
}

async function mount(target, opts) {
  state.el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!state.el) return;
  state.filmId   = opts.filmId;
  state.filmSlug = opts.filmSlug || opts.filmId;
  state.canEdit  = opts.canEdit !== false;
  styles();
  state.el.innerHTML = '<p class="fcp-empty">Loading cast…</p>';
  await load();
  render();
}

global.FlieksCastPanel = { mount, load, render, linkFor, qrFor };

})(window);
