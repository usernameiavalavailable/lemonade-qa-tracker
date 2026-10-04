/* Lemonade Prompt Timer — time + credits per prompt, quick copy, map toggle, guideline-based feedback form */
(() => {
  'use strict';
  if (window.__lqa) return;
  window.__lqa = true;

  const NOW = () => Date.now();
  const IDLE_MS = 15000; // no new activity this long => prompt considered finished
  const r2 = (n) => Math.round(n * 100) / 100;

  /* ── prefs + last prompt (persisted) ── */
  let prefs = { mapHidden: false, x: 16, y: null };
  let last = null; // last prompt record
  let saveT;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { chrome.storage.local.set({ lqa_prefs: prefs, lqa_last: last }); } catch (e) {} }, 400);
  };
  async function load() {
    try {
      const r = await chrome.storage.local.get(['lqa_prefs', 'lqa_last']);
      prefs = { ...prefs, ...(r.lqa_prefs || {}) };
      last = r.lqa_last || null;
      if (last && last.status === 'running') { last.status = 'done'; last.endTs = last.lastAct || last.startTs; }
    } catch (e) {}
  }

  /* ── page readers ── */
  const chatEl = () => document.querySelector('[role="complementary"][aria-label="Chat"]');
  const wsEl = () => document.querySelector('[data-chat-workspace="true"]');
  function readCredits() {
    const b = document.querySelector('button[aria-label^="Credits:"]');
    const m = b && b.getAttribute('aria-label').match(/Credits:\s*(-?[\d.,]+)/);
    return m ? parseFloat(m[1].replace(/,/g, '')) : null;
  }
  const getModel = () => {
    const b = document.querySelector('[data-slot="prompt-composer-surface"] button[role="combobox"]');
    return b ? b.textContent.trim() : '';
  };
  const rowText = (el) => {
    const t = el.querySelector('[title]');
    return ((t && t.getAttribute('title')) || el.textContent || '').replace(/\s+/g, ' ').trim();
  };
  // a row = one turn/tool call; "Investigating (N tools)" groups count as N
  const rowTurns = (t) => {
    if (/^Task completed/i.test(t)) return 0;
    const m = /^Investigating.*\((\d+)\s+tools?\)/i.exec(t);
    return m ? +m[1] : 1;
  };

  /* ── map toggle ── */
  function applyMap() { const ws = wsEl(); if (ws) ws.classList.toggle('lqa-map-hidden', !!prefs.mapHidden); }
  function setMap(h) { prefs.mapHidden = h; applyMap(); save(); paint(); }

  /* ── tracking ── */
  let ready = false, firstFound = 0, lastMut = 0, lastBlockCount = -1, seen = new WeakSet(), path = '';
  let lastCredits = null, preSend = null, rt = null;

  function startPrompt(block, u, now) {
    if (rt && last && last.status === 'running') finish(now, 'next');
    const fresh = preSend && now - preSend.t < 8000 ? preSend : null;
    last = {
      text: (fresh && fresh.text) || (u.querySelector('.whitespace-pre-wrap') || u).textContent.trim(),
      model: (fresh && fresh.model) || getModel(),
      startTs: fresh ? fresh.t : now,
      startCredits: fresh ? fresh.credits : lastCredits,
      endCredits: lastCredits,
      turns: 0, status: 'running', lastAct: now,
    };
    rt = { ub: block, sig: '' };
    preSend = null;
    save();
  }
  function finish(endTs, by) {
    last.status = 'done'; last.endTs = endTs; last.doneBy = by;
    last.endCredits = lastCredits ?? last.endCredits;
    save();
  }
  function track(blocks, now) {
    const start = blocks.indexOf(rt.ub);
    if (start < 0) return;
    let end = blocks.length;
    for (let i = start + 1; i < blocks.length; i++) if (blocks[i].querySelector('.bg-map-user')) { end = i; break; }
    const texts = [];
    let signal = false, reply = '';
    for (const b of blocks.slice(start + 1, end)) {
      b.querySelectorAll(':scope > .space-y-2 > .text-left.relative').forEach((el) => {
        const t = rowText(el);
        if (t && !/^Rolled back/i.test(t)) texts.push(t);
      });
      if ([...b.querySelectorAll('button')].some((x) => /Rate this generation/i.test(x.textContent))) signal = true;
      if (b.querySelector('[data-primary-suggestion]')) { signal = true; continue; }
      if (!b.querySelector('.text-wordmark') && b.querySelector('.relative.group p')) reply += (b.innerText || '').replace(/Rate this generation/gi, '').trim();
    }
    const sig = texts.join('|') + '#' + reply;
    if (sig !== rt.sig) {
      rt.sig = sig; last.lastAct = now;
      last.turns = texts.reduce((s, t) => s + rowTurns(t), 0);
      if (last.status === 'done' && last.doneBy !== 'next') { last.status = 'running'; delete last.endTs; }
      save();
    }
    if (last.status === 'running') {
      const any = texts.length || reply;
      if (signal && any) finish(now, 'signal');
      else if (any && now - last.lastAct > IDLE_MS) finish(last.lastAct, 'idle');
      else if (!any && now - last.startTs > 120000) finish(now, 'no-response');
    }
  }
  function scan() {
    const now = NOW();
    if (location.pathname !== path) { path = location.pathname; rt = null; ready = false; firstFound = 0; lastBlockCount = -1; seen = new WeakSet(); }
    const bal = readCredits();
    if (bal !== null && bal !== lastCredits) {
      const prev = lastCredits; lastCredits = bal;
      if (prev != null && rt && last && (last.status === 'running' || now - (last.endTs || 0) < 20000)) { last.endCredits = bal; save(); }
    }
    const chat = chatEl();
    if (!chat) return;
    const blocks = [...chat.querySelectorAll('.conversation-block')];
    if (!ready) { // ignore messages that were already on screen at load
      if (!firstFound) { firstFound = now; lastMut = now; }
      if (blocks.length !== lastBlockCount) { lastBlockCount = blocks.length; lastMut = now; }
      if (now - lastMut > 1200 || now - firstFound > 8000) { blocks.forEach((b) => seen.add(b)); ready = true; }
      return;
    }
    for (const b of blocks) {
      if (seen.has(b)) continue;
      const u = b.querySelector('.bg-map-user');
      if (u) { seen.add(b); startPrompt(b, u, now); }
    }
    if (rt && last) track(blocks, now);
  }
  function capturePre() {
    const ta = document.querySelector('textarea[name="chat-input"]');
    preSend = { t: NOW(), credits: readCredits() ?? lastCredits, model: getModel(), text: ta ? ta.value.trim() : '' };
  }
  document.addEventListener('keydown', (e) => {
    if (e.target && e.target.matches && e.target.matches('textarea[name="chat-input"]') && e.key === 'Enter' && !e.shiftKey && !e.isComposing) capturePre();
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyM') { e.preventDefault(); setMap(!prefs.mapHidden); }
  }, true);
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('[data-send-button="true"]')) capturePre(); }, true);

  /* ── formatting / copy ── */
  const clock = (ms) => {
    const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
  };
  function stats(p) {
    const end = p.status === 'running' ? NOW() : (p.endTs || NOW());
    const endC = p.status === 'running' ? (lastCredits ?? p.endCredits) : p.endCredits;
    return { dur: end - p.startTs, used: p.startCredits != null && endC != null ? r2(p.startCredits - endC) : null };
  }
  const cost = (v) => (v == null ? '?' : String(+v.toFixed(2)));
  function details(p) {
    const s = stats(p);
    return `"${p.text.replace(/\s+/g, ' ').trim()}"\n\n${p.model || 'Unknown model'}\nCost: ${cost(s.used)}\nTurns: ${p.turns}\nTime: ~ ${clock(s.dur)}`;
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  }

  /* ── tiny pill UI + feedback form ── */
  let shadow;
  const $ = (s) => shadow.querySelector(s);
  const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const DRAFT = { detail: '', exp: '', act: '', verdict: '', thoughts: '', url: '', urlEdited: false, incTest: true, media: false };
  const VERDICTS = [['love', '👍 Love it'], ['tweaks', '🙂 Small tweaks'], ['more', '🔧 Needs more work'], ['broken', '❌ Broken']];
  const VTEXT = { love: 'Love it', tweaks: 'Good, needs small tweaks', more: 'Needs more work', broken: 'Not working / broken' };

  // Discord-ready message following the team's feedback guidelines
  function buildMessage() {
    const d = prefs.draft, L = [];
    if (d.detail.trim()) L.push('**Feedback**\n' + d.detail.trim());
    const ea = [];
    if (d.exp.trim()) ea.push('**Expected:** ' + d.exp.trim());
    if (d.act.trim()) ea.push('**Actual:** ' + d.act.trim());
    if (ea.length) L.push(ea.join('\n'));
    const th = [VTEXT[d.verdict], d.thoughts.trim()].filter(Boolean).join(' — ');
    if (th) L.push('**Thoughts:** ' + th);
    const meta = [];
    if (d.url.trim()) meta.push('**Project:** ' + d.url.trim());
    if (d.incTest && last) {
      const s = stats(last);
      meta.push(`**Test:** "${clip(last.text, 160)}" · ${last.model || '?'} · Cost: ${cost(s.used)} · Turns: ${last.turns} · Time: ~ ${clock(s.dur)}`);
    }
    if (d.media) meta.push('📎 Screenshot/video attached');
    if (meta.length) L.push(meta.join('\n'));
    return L.join('\n\n');
  }

  function build() {
    prefs.draft = { ...DRAFT, ...(prefs.draft || {}) };
    const host = document.createElement('div');
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      *{box-sizing:border-box}
      .pill{position:fixed;z-index:2147483000;display:flex;align-items:center;gap:8px;padding:6px 8px;background:#15161a;color:#e8e8ea;
        border:1px solid #2c2e34;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:12px/1.3 -apple-system,Segoe UI,Roboto,sans-serif;cursor:move;user-select:none}
      button{font:inherit;color:inherit;background:#262a31;border:1px solid #343841;border-radius:8px;padding:5px 9px;cursor:pointer}
      button:hover{background:#30353d} button.on{background:#0e4a66;border-color:#38bdf8} button:disabled{opacity:.4;cursor:default}
      button.pri{background:#facc15;color:#15161a;border-color:#facc15;font-weight:600}button.pri:hover{background:#fde047}
      .st{font-variant-numeric:tabular-nums;white-space:nowrap}
      .dot{width:8px;height:8px;border-radius:50%;background:#4b5058}
      .dot.run{background:#fbbf24;animation:p 1s infinite}@keyframes p{50%{opacity:.3}}
      .fb{position:absolute;left:0;width:372px;max-height:72vh;overflow:auto;padding:10px;background:#15161a;border:1px solid #2c2e34;border-radius:12px;
        box-shadow:0 14px 40px rgba(0,0,0,.6);cursor:default;user-select:text}
      .fb.up{bottom:calc(100% + 8px)}.fb.down{top:calc(100% + 8px)}.fb.r{left:auto;right:0}
      .fb[hidden]{display:none}
      .fb label{display:block;margin:9px 0 3px;color:#9aa0a8;font-size:11px}
      .fb textarea,.fb input[type=text]{width:100%;background:#0e0f12;color:#e8e8ea;border:1px solid #343841;border-radius:8px;padding:6px 8px;font:inherit;resize:vertical;margin-bottom:4px}
      .fb textarea:focus,.fb input:focus{outline:none;border-color:#38bdf8}
      .ck{display:flex;gap:4px;flex-wrap:wrap}
      .ck span{padding:2px 7px;border-radius:999px;background:#23262c;color:#8b9199;font-size:10px}
      .ck span.ok{background:#12391f;color:#86efac}
      .chips{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:5px}
      .chips button{padding:3px 8px}
      .inl{display:flex!important;align-items:center;gap:6px;color:#cfd3d9!important;font-size:12px!important;margin:6px 0 0!important}
      .inl input{margin:0}
      .row{display:flex;gap:6px;margin-top:10px}.row .pri{flex:1}
      .hd{display:flex;justify-content:space-between;align-items:center;color:#e8e8ea;font-weight:600;margin-bottom:6px}
    </style>
    <div class="pill" id="pill">
      <button id="map" title="Hide/show game map (Alt+M)"></button>
      <span class="dot" id="dot"></span><span class="st" id="st">no prompt yet</span>
      <button id="cp" title="Copy prompt details" disabled>Copy</button>
      <button id="fbBtn" title="Write feedback following the team guidelines">Feedback</button>
      <div class="fb up" id="fb" hidden>
        <div class="hd"><span>Feedback message</span><button id="fbX" title="Close">✕</button></div>
        <div class="ck" id="ck"></div>
        <label>1 · Detailed feedback</label>
        <textarea data-f="detail" rows="3" placeholder="What you tried, what stood out, specifics…"></textarea>
        <label>2 · What you expected vs. what is actually happening</label>
        <textarea data-f="exp" rows="2" placeholder="Expected…"></textarea>
        <textarea data-f="act" rows="2" placeholder="Actually happening…"></textarea>
        <label>3 · Your thoughts on the update</label>
        <div class="chips" id="chips"></div>
        <textarea data-f="thoughts" rows="2" placeholder="Do you like it? Does it still need more work? Why?"></textarea>
        <label>4 · Project URL</label>
        <input type="text" data-f="url" placeholder="https://…">
        <label class="inl"><input type="checkbox" data-c="incTest"> Include last prompt test (model · cost · turns · time)</label>
        <label class="inl"><input type="checkbox" data-c="media"> 5 · I'm attaching a screenshot / video</label>
        <div class="row"><button class="pri" id="send">Copy feedback</button><button id="clr">Clear</button></div>
      </div>
    </div>`;
    const pill = $('#pill'), fb = $('#fb');
    pill.style.left = Math.min(prefs.x, innerWidth - 120) + 'px';
    pill.style.top = Math.min(prefs.y ?? innerHeight - 110, innerHeight - 50) + 'px';
    pill.addEventListener('mousedown', (e) => {
      if (e.target.closest('button,.fb')) return;
      const sx = e.clientX - pill.offsetLeft, sy = e.clientY - pill.offsetTop;
      const mv = (ev) => { pill.style.left = Math.max(0, Math.min(innerWidth - 60, ev.clientX - sx)) + 'px'; pill.style.top = Math.max(0, Math.min(innerHeight - 30, ev.clientY - sy)) + 'px'; };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); prefs.x = pill.offsetLeft; prefs.y = pill.offsetTop; save(); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up);
      e.preventDefault();
    });
    $('#map').addEventListener('click', () => setMap(!prefs.mapHidden));
    $('#cp').addEventListener('click', async () => {
      if (!last) return;
      await copy(details(last));
      const b = $('#cp'); b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = 'Copy'), 1200);
    });

    /* feedback form */
    ['keydown', 'keyup', 'keypress'].forEach((t) => fb.addEventListener(t, (e) => e.stopPropagation()));
    const chips = $('#chips');
    chips.innerHTML = VERDICTS.map(([k, l]) => `<button data-v="${k}">${l}</button>`).join('');
    const fields = () => fb.querySelectorAll('[data-f]');
    function syncForm() {
      const d = prefs.draft;
      fields().forEach((el) => { if (shadow.activeElement !== el) el.value = d[el.dataset.f] || ''; });
      fb.querySelectorAll('[data-c]').forEach((el) => (el.checked = !!d[el.dataset.c]));
      chips.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === d.verdict));
      const ok = [
        ['1 Detail', d.detail.trim().length >= 30],
        ['2 Expected/Actual', !!(d.exp.trim() && d.act.trim())],
        ['3 Thoughts', !!d.verdict],
        ['4 URL', !!d.url.trim()],
        ['5 Media', !!d.media],
      ];
      $('#ck').innerHTML = ok.map(([l, v]) => `<span class="${v ? 'ok' : ''}">${v ? '✓' : '○'} ${l}</span>`).join('');
    }
    function placeForm() {
      const top = pill.offsetTop > innerHeight / 2;
      fb.classList.toggle('up', top); fb.classList.toggle('down', !top);
      fb.classList.toggle('r', pill.offsetLeft + 380 > innerWidth);
    }
    function openForm(show) {
      if (show) {
        if (!prefs.draft.urlEdited || !prefs.draft.url) prefs.draft.url = location.href;
        placeForm(); syncForm();
      }
      fb.hidden = !show; $('#fbBtn').classList.toggle('on', show); save();
    }
    $('#fbBtn').addEventListener('click', () => openForm(fb.hidden));
    $('#fbX').addEventListener('click', () => openForm(false));
    fb.addEventListener('input', (e) => {
      const f = e.target.dataset.f; if (!f) return;
      prefs.draft[f] = e.target.value; if (f === 'url') prefs.draft.urlEdited = true;
      save(); syncForm();
    });
    fb.addEventListener('change', (e) => {
      const c = e.target.dataset.c; if (!c) return;
      prefs.draft[c] = e.target.checked; save(); syncForm();
    });
    chips.addEventListener('click', (e) => {
      const v = e.target.dataset.v; if (!v) return;
      prefs.draft.verdict = prefs.draft.verdict === v ? '' : v; save(); syncForm();
    });
    $('#send').addEventListener('click', async () => {
      const msg = buildMessage();
      if (!msg.trim()) return;
      await copy(msg);
      const b = $('#send'); b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = 'Copy feedback'), 1400);
    });
    $('#clr').addEventListener('click', () => {
      const keepUrl = location.href;
      prefs.draft = { ...DRAFT, url: keepUrl, incTest: prefs.draft.incTest };
      save(); syncForm();
    });
  }
  function paint() {
    if (!shadow) return;
    const m = $('#map'); m.textContent = prefs.mapHidden ? 'Show map' : 'Hide map'; m.classList.toggle('on', !!prefs.mapHidden);
    $('#cp').disabled = !last;
    $('#dot').classList.toggle('run', !!last && last.status === 'running');
    if (last) {
      const s = stats(last);
      $('#st').textContent = `⏱ ${clock(s.dur)} · ${cost(s.used)} cr · ${last.turns} turns`;
    }
  }

  /* ── boot ── */
  (async () => {
    await load();
    build(); applyMap(); paint();
    let mt;
    new MutationObserver(() => { clearTimeout(mt); mt = setTimeout(() => { try { scan(); } catch (e) {} }, 120); })
      .observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label', 'title'] });
    setInterval(() => { try { scan(); applyMap(); paint(); } catch (e) { console.error('[LQA]', e); } }, 500);
  })();
})();
