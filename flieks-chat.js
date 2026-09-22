/* ============================================================================
   flieks-chat.js
   Filmmaker support assistant — a floating chat bubble backed by
   flieks-filmmaker-chat.js (Anthropic Messages API).

   Answers routine questions (uploads, review turnaround, the 70/30 split,
   payouts, cast links) instantly. Anything it isn't confident about gets an
   "Ask a human" button that opens a real support ticket via
   flieks-support.js — the transcript rides along so nothing has to be
   re-typed.

   USE:
     <script src="/flieks-chat.js"></script>
     FlieksChat.mount({ getToken: () => auth.currentUser?.getIdToken(), getEmail: () => auth.currentUser?.email });
   ============================================================================ */
(function (global) {
'use strict';

const esc = s => { const d = document.createElement('div'); d.textContent = s ?? ''; return d.innerHTML; };

function styles() {
  if (document.getElementById('fc-css')) return;
  const s = document.createElement('style');
  s.id = 'fc-css';
  s.textContent = `
  .fc-bubble{position:fixed;right:18px;bottom:88px;z-index:8900;width:56px;height:56px;border-radius:50%;
    background:#D85A2C;color:#fff;border:0;cursor:pointer;box-shadow:0 6px 18px rgba(0,0,0,.35);
    display:flex;align-items:center;justify-content:center;font-size:24px}
  .fc-bubble svg{width:26px;height:26px}
  @media (min-width:481px){.fc-bubble,.fc-panel{right:calc(50% - 240px + 18px)}}
  .fc-panel{position:fixed;right:18px;bottom:88px;z-index:8901;width:min(360px,calc(100vw - 36px));
    max-height:min(560px,calc(100dvh - 140px));background:#1C1512;color:#F2EADA;
    border:1px solid rgba(242,234,218,.16);border-radius:12px;display:none;flex-direction:column;
    overflow:hidden;font-family:inherit;box-shadow:0 12px 40px rgba(0,0,0,.45)}
  .fc-panel.on{display:flex}
  .fc-head{padding:14px 16px;border-bottom:1px solid rgba(242,234,218,.12);display:flex;
    justify-content:space-between;align-items:center;flex-shrink:0}
  .fc-head h4{font-size:14.5px;margin:0}
  .fc-head p{font-size:11.5px;opacity:.6;margin-top:2px}
  .fc-x{width:32px;height:32px;border-radius:50%;background:rgba(242,234,218,.08);
    border:1px solid rgba(242,234,218,.2);color:inherit;cursor:pointer;font-size:16px;line-height:1}
  .fc-body{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:14px 16px;display:flex;
    flex-direction:column;gap:10px}
  .fc-msg{font-size:13.5px;line-height:1.5;max-width:88%;padding:9px 12px;border-radius:10px}
  .fc-msg.me{align-self:flex-end;background:#D85A2C;color:#fff;border-bottom-right-radius:3px}
  .fc-msg.bot{align-self:flex-start;background:rgba(242,234,218,.08);border-bottom-left-radius:3px}
  .fc-msg.sys{align-self:center;font-size:12px;opacity:.6;text-align:center;max-width:100%}
  .fc-esc{align-self:flex-start;font:inherit;font-size:12.5px;font-weight:700;letter-spacing:.03em;
    padding:9px 13px;border-radius:8px;border:1px solid rgba(242,234,218,.3);background:transparent;
    color:inherit;cursor:pointer;margin-top:2px}
  .fc-typing{align-self:flex-start;font-size:13px;opacity:.55}
  .fc-inputrow{border-top:1px solid rgba(242,234,218,.12);padding:10px;display:flex;gap:8px;flex-shrink:0}
  .fc-inputrow input{flex:1;font:inherit;font-size:16px;padding:11px 12px;border-radius:8px;
    background:rgba(0,0,0,.3);border:1px solid rgba(242,234,218,.18);color:inherit}
  .fc-inputrow input:focus{outline:none;border-color:#D85A2C}
  .fc-send{font:inherit;font-weight:700;font-size:13px;padding:0 16px;border-radius:8px;border:0;
    background:#D85A2C;color:#fff;cursor:pointer}
  .fc-send:disabled{opacity:.4;cursor:not-allowed}
  .fc-ticket{padding:14px 16px;border-top:1px solid rgba(242,234,218,.12);display:flex;flex-direction:column;gap:8px}
  .fc-ticket input,.fc-ticket textarea{width:100%;font:inherit;font-size:14px;padding:10px;border-radius:7px;
    background:rgba(0,0,0,.3);border:1px solid rgba(242,234,218,.18);color:inherit;resize:vertical}
  `;
  document.head.appendChild(s);
}

function bubbleIcon() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
}

function mount(opts) {
  opts = opts || {};
  const endpoint = opts.endpoint || '/.netlify/functions/flieks-filmmaker-chat';
  const supportEndpoint = opts.supportEndpoint || '/.netlify/functions/flieks-support';
  const greeting = opts.greeting || "Hi — ask me anything about uploading, review, payouts or cast links.";

  styles();

  const bubble = document.createElement('button');
  bubble.className = 'fc-bubble';
  bubble.setAttribute('aria-label', 'Get help');
  bubble.innerHTML = bubbleIcon();
  document.body.appendChild(bubble);

  const panel = document.createElement('div');
  panel.className = 'fc-panel';
  panel.innerHTML = `
    <div class="fc-head">
      <div><h4>Filmmaker help</h4><p>Usually answers in a few seconds</p></div>
      <button class="fc-x" aria-label="Close">×</button>
    </div>
    <div class="fc-body" id="fcBody"></div>
    <div class="fc-inputrow">
      <input id="fcInput" placeholder="Type a question…" autocomplete="off">
      <button class="fc-send" id="fcSend">Send</button>
    </div>`;
  document.body.appendChild(panel);

  const body = panel.querySelector('#fcBody');
  const input = panel.querySelector('#fcInput');
  const sendBtn = panel.querySelector('#fcSend');

  const history = [];
  let opened = false;

  function addMsg(role, text) {
    const d = document.createElement('div');
    d.className = 'fc-msg ' + (role === 'user' ? 'me' : role === 'sys' ? 'sys' : 'bot');
    d.textContent = text;
    body.appendChild(d);
    body.scrollTop = body.scrollHeight;
    return d;
  }

  function addEscalate() {
    const btn = document.createElement('button');
    btn.className = 'fc-esc';
    btn.textContent = 'Ask a human instead →';
    btn.onclick = () => openTicket();
    body.appendChild(btn);
    body.scrollTop = body.scrollHeight;
  }

  function openTicket() {
    if (panel.querySelector('.fc-ticket')) return;
    const box = document.createElement('div');
    box.className = 'fc-ticket';
    box.innerHTML = `
      <input id="fcEmail" type="email" placeholder="Your email" autocomplete="email"
        value="${esc((opts.getEmail && opts.getEmail()) || '')}">
      <textarea id="fcDetail" rows="3" placeholder="Anything to add? (optional)"></textarea>
      <button class="fc-send" id="fcTicketSend">Send to the team</button>`;
    panel.insertBefore(box, panel.querySelector('.fc-inputrow'));
    box.querySelector('#fcTicketSend').onclick = async () => {
      const email = box.querySelector('#fcEmail').value.trim();
      const extra = box.querySelector('#fcDetail').value.trim();
      if (!/\S+@\S+\.\S+/.test(email)) { addMsg('sys', 'Need a valid email so we can reply.'); return; }
      box.querySelector('#fcTicketSend').disabled = true;
      const transcript = history.map(h => `${h.role === 'user' ? 'Filmmaker' : 'Assistant'}: ${h.content}`).join('\n');
      try {
        const token = opts.getToken ? await opts.getToken().catch(() => null) : null;
        const r = await fetch(supportEndpoint, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email, topic: 'Filmmaker chat escalation',
            body: (extra ? extra + '\n\n' : '') + '— Chat transcript —\n' + transcript,
            token
          })
        });
        const d = await r.json();
        box.remove();
        addMsg('sys', r.ok ? `Sent — reference ${d.ref}. We reply within two working days.` : (d.message || 'Could not send that.'));
      } catch {
        addMsg('sys', 'Could not reach the server — try again in a moment.');
      }
    };
  }

  async function ask(text) {
    addMsg('user', text);
    history.push({ role: 'user', content: text });
    input.value = ''; input.disabled = true; sendBtn.disabled = true;
    const typing = document.createElement('div');
    typing.className = 'fc-typing';
    typing.textContent = 'Typing…';
    body.appendChild(typing);
    body.scrollTop = body.scrollHeight;
    try {
      const token = opts.getToken ? await opts.getToken().catch(() => null) : null;
      const r = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history, token })
      });
      const d = await r.json();
      typing.remove();
      addMsg('bot', d.reply || "Couldn't get an answer just then — try again.");
      history.push({ role: 'assistant', content: d.reply || '' });
      if (d.escalate) addEscalate();
    } catch {
      typing.remove();
      addMsg('sys', 'Could not reach the assistant.');
      addEscalate();
    } finally {
      input.disabled = false; sendBtn.disabled = false; input.focus();
    }
  }

  sendBtn.onclick = () => { const t = input.value.trim(); if (t) ask(t); };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') sendBtn.onclick(); });

  bubble.onclick = () => {
    panel.classList.add('on');
    bubble.style.display = 'none';
    if (!opened) { opened = true; addMsg('bot', greeting); }
    input.focus();
  };
  panel.querySelector('.fc-x').onclick = () => {
    panel.classList.remove('on');
    bubble.style.display = 'flex';
  };
}

global.FlieksChat = { mount };

})(window);
