/* ============================================================================
   flieks-gift.js
   Gifting for every film on 4flieks.

   Buy a film for someone else, get a code, send it however you like.
   No email infrastructure needed — the code survives a screenshot.

   USE:
     <script src="/flieks-gift.js"></script>

     FlieksGift.mountBuy('#giftButton', { filmId, title, price });
     FlieksGift.mountRedeem('#redeemBox');

   Needs three serverless functions — see GIFTING.md.
   ============================================================================ */
(function (global) {
'use strict';

const esc = s => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };
const rands = n => 'R' + (Math.round(n) === Number(n) ? n : Number(n).toFixed(2));

function styles() {
  if (document.getElementById('fg-css')) return;
  const s = document.createElement('style');
  s.id = 'fg-css';
  s.textContent = `
  .fg-scrim{position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.72);backdrop-filter:blur(6px);
    display:flex;align-items:center;justify-content:center;padding:20px;opacity:0;pointer-events:none;
    transition:opacity .22s}
  .fg-scrim.on{opacity:1;pointer-events:auto}
  .fg-modal{background:#1C1512;color:#F2EADA;border:1px solid rgba(242,234,218,.16);border-radius:8px;
    width:100%;max-width:430px;max-height:88dvh;overflow:auto;overscroll-behavior:contain;
    padding:26px 24px;position:relative;font-family:inherit}
  .fg-x{position:absolute;top:10px;right:10px;width:42px;height:42px;border-radius:50%;cursor:pointer;
    background:rgba(242,234,218,.08);border:1px solid rgba(242,234,218,.2);color:inherit;font-size:19px;line-height:1}
  .fg-modal h3{margin:0 0 5px;font-size:20px}
  .fg-sub{font-size:13.5px;opacity:.65;margin-bottom:16px;line-height:1.5}
  .fg-f{margin-bottom:13px}
  .fg-f label{display:block;font-size:11px;letter-spacing:.11em;text-transform:uppercase;opacity:.6;margin-bottom:6px}
  .fg-f input,.fg-f textarea{width:100%;font:inherit;font-size:16px;padding:12px;border-radius:5px;
    background:rgba(0,0,0,.3);border:1px solid rgba(242,234,218,.18);color:inherit;resize:vertical}
  .fg-f input:focus,.fg-f textarea:focus{border-color:#D85A2C;outline:none}
  .fg-btn{width:100%;font:inherit;font-weight:700;font-size:13px;letter-spacing:.1em;text-transform:uppercase;
    padding:15px;min-height:50px;border-radius:5px;border:0;background:#D85A2C;color:#fff;cursor:pointer}
  .fg-btn:hover{background:#c14e24}
  .fg-btn:disabled{opacity:.45;cursor:not-allowed}
  .fg-err{color:#FF8A7A;font-size:13.5px;margin-top:10px;min-height:1.2em}
  .fg-err.ok{color:#6FD9A4}
  .fg-note{font-size:11.5px;opacity:.55;margin-top:12px;line-height:1.5}
  .fg-code{font-size:27px;font-weight:700;letter-spacing:.22em;text-align:center;color:#D49A2C;
    background:rgba(212,154,44,.1);border:2px dashed rgba(212,154,44,.5);border-radius:6px;
    padding:18px;margin:14px 0;font-family:ui-monospace,monospace}
  .fg-redeem{border:1px solid rgba(128,128,128,.28);border-radius:6px;padding:18px}
  .fg-redeem h4{margin:0 0 4px;font-size:16px}`;
  document.head.appendChild(s);
}

function modal(html) {
  styles();
  const w = document.createElement('div');
  w.className = 'fg-scrim';
  w.innerHTML = `<div class="fg-modal"><button class="fg-x" aria-label="Close">×</button>${html}</div>`;
  document.body.appendChild(w);
  requestAnimationFrame(() => w.classList.add('on'));
  const close = () => { w.classList.remove('on'); setTimeout(() => w.remove(), 250); };
  w.querySelector('.fg-x').onclick = close;
  w.addEventListener('click', e => { if (e.target === w) close(); });
  const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);
  return { el: w, close, $: s => w.querySelector(s) };
}

/* --------------------------------------------------------------------------
   Buying a gift
   -------------------------------------------------------------------------- */
async function openBuy(opts) {
  const user = firebase.auth().currentUser;
  if (!user) {
    if (typeof opts.onNeedAuth === 'function') return opts.onNeedAuth();
    alert('Sign in first, then you can gift this film.');
    return;
  }

  const m = modal(`
    <h3>Gift ${esc(opts.title)}</h3>
    <p class="fg-sub">${rands(opts.price)} — you'll get a code to send them. They get a
      permanent copy.</p>
    <div class="fg-f"><label for="fgTo">Who's it for</label>
      <input id="fgTo" placeholder="Their name" autocomplete="off"></div>
    <div class="fg-f"><label for="fgMsg">Message (optional)</label>
      <textarea id="fgMsg" rows="3" maxlength="300" placeholder="Watch this, then call me."></textarea></div>
    <button class="fg-btn" id="fgPay">Pay with PayFast</button>
    <div class="fg-err" id="fgErr"></div>
    <p class="fg-note">Card, Instant EFT, SnapScan and more. You'll get the code straight
      after payment — send it by WhatsApp, DM, or read it out.</p>`);

  m.$('#fgPay').onclick = async () => {
    const to = m.$('#fgTo').value.trim();
    const err = m.$('#fgErr'); err.className = 'fg-err';
    if (!to) { err.textContent = 'Who is this for? Their name is enough.'; return; }
    if (/\S+@\S+\.\S+/.test(to)) {
      err.textContent = "Their name, not an email — you'll get a code to send them yourself.";
      return;
    }
    m.$('#fgPay').disabled = true; err.textContent = '';
    try {
      const r = await fetch('/.netlify/functions/flieks-checkout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: await user.getIdToken(true),
          filmId: opts.filmId, tier: 'gift',
          ref: global.FlieksSocial ? FlieksSocial.getRef(opts.filmId) : null,
          giftTo: to, giftMsg: m.$('#fgMsg').value.trim().slice(0, 300),
          returnUrl: location.origin + location.pathname
        })
      });
      if (!r.ok) {
        let msg = await r.text();
        try { msg = JSON.parse(msg).message || msg; } catch {}
        throw new Error(msg);
      }
      const { action, fields } = await r.json();
      const f = document.createElement('form');
      f.method = 'POST'; f.action = action;
      Object.entries(fields).forEach(([k, v]) => {
        const i = document.createElement('input');
        i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i);
      });
      document.body.appendChild(f); f.submit();
    } catch (e) {
      err.textContent = 'Could not start checkout — ' + (e.message || 'try again in a moment');
      m.$('#fgPay').disabled = false;
    }
  };
}

function mountBuy(target, opts) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;
  el.addEventListener('click', e => { e.preventDefault(); openBuy(opts); });
}

/* --------------------------------------------------------------------------
   Showing the code after a gift purchase returns from PayFast
   -------------------------------------------------------------------------- */
function showCode(code, filmTitle) {
  const m = modal(`
    <h3>Your gift code</h3>
    <p class="fg-sub">Send this to them. It unlocks one permanent copy of
      ${esc(filmTitle || 'the film')}.</p>
    <div class="fg-code">${esc(code)}</div>
    <button class="fg-btn" id="fgShare">Share it</button>
    <p class="fg-note">They enter it under "Got a gift code?" on the film's page.
      It works once.</p>`);
  m.$('#fgShare').onclick = async () => {
    const text = `I bought you ${filmTitle || 'a film'} on 4flieks. Unlock it at ` +
                 `${location.origin}${location.pathname} with code ${code}`;
    if (navigator.share) { try { await navigator.share({ text }); } catch {} }
    else { await navigator.clipboard.writeText(text); m.$('#fgShare').textContent = 'Copied'; }
  };
}

/** Call once on page load. Detects ?paid=1 and shows the code if there is one. */
function checkReturn(filmTitle) {
  const p = new URLSearchParams(location.search);
  if (p.get('paid') !== '1') return;
  history.replaceState({}, '', location.pathname);
  const off = firebase.auth().onAuthStateChanged(async u => {
    off();
    if (!u) return;
    await new Promise(r => setTimeout(r, 2500));   // let the ITN land
    const snap = await firebase.database().ref(`flieks_my_gifts/${u.uid}`).get().catch(() => null);
    const v = snap && snap.val();
    if (!v) return;
    const code = Object.entries(v).sort((a, b) => b[1] - a[1])[0][0];
    showCode(code, filmTitle);
  });
}

/* --------------------------------------------------------------------------
   Redeeming
   -------------------------------------------------------------------------- */
function mountRedeem(target, opts) {
  styles();
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return;
  opts = opts || {};
  el.innerHTML = `
    <div class="fg-redeem">
      <h4>Got a gift code?</h4>
      <p class="fg-sub">Someone bought this for you. Type it in.</p>
      <div class="fg-f"><label for="fgCode">Gift code</label>
        <input id="fgCode" placeholder="FL-XXXXXX" autocomplete="off"
               style="text-transform:uppercase;letter-spacing:.12em"></div>
      <button class="fg-btn" id="fgRedeem">Unlock the film</button>
      <div class="fg-err" id="fgRedeemErr"></div>
    </div>`;

  el.querySelector('#fgRedeem').onclick = async () => {
    const code = el.querySelector('#fgCode').value.trim().toUpperCase();
    const err = el.querySelector('#fgRedeemErr');
    err.className = 'fg-err'; err.textContent = '';
    if (!code) { err.textContent = 'Enter the code you were sent.'; return; }
    const user = firebase.auth().currentUser;
    if (!user) {
      err.textContent = 'Sign in first, then redeem.';
      if (typeof opts.onNeedAuth === 'function') opts.onNeedAuth();
      return;
    }
    const btn = el.querySelector('#fgRedeem');
    btn.disabled = true;
    try {
      const r = await fetch('/.netlify/functions/flieks-redeem', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: await user.getIdToken(true), code })
      });
      const d = await r.json();
      if (!r.ok) { err.textContent = d.message || 'That code did not work.'; return; }
      err.className = 'fg-err ok';
      err.textContent = 'Unlocked. It is yours.';
      if (typeof opts.onSuccess === 'function') opts.onSuccess(d.filmId);
    } catch {
      err.textContent = 'Could not reach the server. Try again.';
    } finally { btn.disabled = false; }
  };
}

global.FlieksGift = { mountBuy, openBuy, mountRedeem, checkReturn, showCode };

})(window);
