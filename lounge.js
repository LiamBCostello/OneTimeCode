if (!document.getElementById('loungePanel')) {
  ;(() => {})();
} else

(() => {
  const $  = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));

  // ====== Tabs ======
  const btnTabBrowse = $('#btnTabBrowse');
  const btnTabCreate = $('#btnTabCreate');
  const btnTabJoin   = $('#btnTabJoin');
  const paneBrowse = $('#paneBrowse');
  const paneCreate = $('#paneCreate');
  const paneJoin   = $('#paneJoin');

  function setActiveTab(which){
    const map = { browse:[btnTabBrowse,paneBrowse], create:[btnTabCreate,paneCreate], join:[btnTabJoin,paneJoin] };
    for (const [key,[btn,pane]] of Object.entries(map)){
      const active = key === which;
      btn?.classList.toggle('active', active);
      btn?.setAttribute('aria-selected', String(active));
      pane?.classList.toggle('hidden', !active);
    }
    if (which === 'browse') ensureSSE();
    ensureRowGaps();
  }
  btnTabBrowse?.addEventListener('click', () => setActiveTab('browse'));
  btnTabCreate?.addEventListener('click', () => setActiveTab('create'));
  btnTabJoin  ?.addEventListener('click', () => setActiveTab('join'));

  // ====== Common chat UI ======
  const setup = $('#loungePanel');
  const chat = $('#chat');
  const messagesEl = $('#messages');
  const composer = $('#composer');
  const msgInput = $('#msgInput');
  const roomStatus = $('#roomStatus');
  const connDot = $('#connDot');
  const leaveBtn = $('#leaveBtn');
  const msgTemplate = $('#msgTemplate');

  // ---- (NEW) Lounge video UI injected dynamically ----
  let lgModeHeading = $('#lgModeHeading');
  let lgModeMsg     = $('#lgModeMsg');
  let lgModeVid     = $('#lgModeVid');
  let videoGrid     = $('#videoGrid');

  function ensureVideoUI(){
    if (lgModeHeading && lgModeMsg && lgModeVid && videoGrid) return;
    const host = messagesEl?.parentElement || chat;

    // Mode bar
    const modebar = document.createElement('div');
    modebar.className = 'modebar';
    modebar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin:8px 0 12px 0;';
    modebar.innerHTML = `
      <h2 class="mode-heading" style="margin:0;font-weight:800;"><span id="lgModeHeading">Message Chat</span></h2>
      <div class="segSwitch" role="tablist" aria-label="Lounge mode" style="display:inline-flex;gap:0;border:1px solid rgba(255,255,255,0.15);border-radius:999px;overflow:hidden;">
        <label style="padding:6px 12px;cursor:pointer;user-select:none;">
          <input type="radio" name="lgmode" id="lgModeMsg" checked style="display:none;">
          <span>Message</span>
        </label>
        <label style="padding:6px 12px;cursor:pointer;user-select:none;border-left:1px solid rgba(255,255,255,0.12);">
          <input type="radio" name="lgmode" id="lgModeVid" style="display:none;">
          <span>Video</span>
        </label>
      </div>
    `;
    host.insertBefore(modebar, messagesEl);

    // Video grid
    const grid = document.createElement('div');
    grid.id = 'videoGrid';
    grid.className = 'videoGrid';
    grid.style.cssText = `
      display:none;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap:12px; height:58vh; min-height:420px; padding:10px; aspect-ratio:auto;
    `;
    host.insertBefore(grid, messagesEl);

    // bind refs
    lgModeHeading = $('#lgModeHeading');
    lgModeMsg     = $('#lgModeMsg');
    lgModeVid     = $('#lgModeVid');
    videoGrid     = $('#videoGrid');

    // listeners (bound once)
    lgModeMsg?.addEventListener('change', () => {
      if (!lgModeMsg.checked) return;
      loungeMode = 'text';
      updateLoungeModeUI();
      stopAllMedia();
    });
    lgModeVid?.addEventListener('change', async () => {
      if (!lgModeVid.checked) return;
      loungeMode = 'video';
      updateLoungeModeUI();
      await syncMediaWithRoster();
    });
  }

  // Key chip (shown when private)
  let keyChip = null;
  function formatKey(k){ return k && k.length === 10 ? `${k.slice(0,5)}-${k.slice(5)}` : k; }
  function updateKeyChip(){
    const right = document.querySelector('.chatHeader .right');
    if (!right) return;
    if (!keyChip){
      keyChip = document.createElement('button');
      keyChip.id = 'keyChip';
      keyChip.className = 'pill';
      keyChip.type = 'button';
      keyChip.style.marginRight = '8px';
      keyChip.style.cursor = 'pointer';
      right.insertBefore(keyChip, leaveBtn);
      keyChip.addEventListener('click', async () => {
        if (!privateKey) return;
        try { await navigator.clipboard.writeText(privateKey); toast('Key copied'); } catch {}
      });
    }
    if (isPrivate && privateKey){
      keyChip.textContent = `Key: ${formatKey(privateKey)}`;
      keyChip.style.display = 'inline-flex';
      keyChip.title = 'Click to copy';
    } else if (keyChip){
      keyChip.style.display = 'none';
    }
  }

  // Participants (DM-like)
  let peoplePane = $('#peoplePane');
  let peopleList = $('#peopleList');
  function ensurePeoplePane(){
    if (peoplePane && peopleList) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'peoplePane';
    wrapper.style.cssText = `
      margin: 10px 0 8px 0; padding: 10px 12px;
      border-radius: 12px; border:1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.06); display:flex; align-items:center; gap:10px; flex-wrap:wrap;
    `;
    const title = document.createElement('div');
    title.id = 'peopleTitle';
    title.textContent = 'People (0)';
    title.style.cssText = 'font-weight:700;margin-right:8px;';
    const list = document.createElement('div');
    list.id = 'peopleList';
    list.style.cssText = 'display:flex; gap:8px; flex-wrap:wrap;';
    wrapper.appendChild(title);
    wrapper.appendChild(list);
    messagesEl.parentElement.insertBefore(wrapper, messagesEl);
    peoplePane = wrapper; peopleList = list;
  }
  function renderPeople(){
    ensurePeoplePane();
    const roster = computeRoster();
    $('#peopleTitle').textContent = `People (${roster.length})`;
    peopleList.innerHTML = '';
    for (const entry of roster){
      const chip = document.createElement('div');
      chip.className = 'personChip';
      chip.style.cssText = `
        display:flex; align-items:center; gap:8px; padding:6px 10px; border-radius:999px;
        border:1px solid rgba(255,255,255,0.18); background: rgba(255,255,255,0.06);
      `;
      const av = document.createElement('div');
      av.textContent = initials(entry.name);
      av.style.cssText = `
        width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;
        font-size:12px;font-weight:800;background:${colorFor(entry.name, .25)};
        border:1px solid ${colorFor(entry.name, .55)};
      `;
      const nm = document.createElement('span');
      nm.textContent = entry.you ? `${entry.name} (you)` : entry.name;
      nm.style.cssText = 'font-size:13px;';
      chip.appendChild(av); chip.appendChild(nm);
      peopleList.appendChild(chip);
    }
  }

  // ====== Create / Join / Sort / Search UI ======
  const startNameInput = $('#startName');
  const startBtn = $('#startBtn');

  const visPublicBtn  = $('#visPublicBtn');
  const visPrivateBtn = $('#visPrivateBtn');
  const showPrivateRow = $('#showPrivateRow');
  const showPrivatePublic = $('#showPrivatePublic');

  const privateKeyWrap  = $('#privateKeyWrap');
  const privateKeyValue = $('#privateKeyValue');
  const copyKeyBtn      = $('#copyKeyBtn');

  const joinKeyInput = $('#joinKey');
  const joinBtn = $('#joinBtn');

  const sortSelect  = $('#sortSelect');
  const searchInput = $('#searchInput'); // NEW

  const nicknameInput = $('#nickname');
  const saveNameBtn = $('#saveNameBtn');

  function ensureRowGaps(){ $$('.row').forEach(r => { if (!r.style.gap) r.style.gap = '12px'; }); }

  // ====== State ======
  let nickname = defaultNick();
  nicknameInput && (nicknameInput.value = nickname);

  let peer = null;
  let isHost = false;
  let hostId = null;
  let loungeName = null;
  let slug = null;
  let isPrivate = false;  // visibility
  let listPublic = true;  // appears in directory (public always true; private optional)
  let privateKey = '';
  let conn = null;
  const conns = new Map();
  const peersMeta = new Map();
  let heartbeatTimer = null;
  let sse = null;
  let sseSubscribed = false;
  let electionInProgress = false;

  let lastLounges = []; // latest list from server (used for client-side sorting)

  // ---- (NEW) Multi-party video state ----
  let loungeMode = 'text';             // 'text' | 'video'
  let localStream = null;
  const mediaCalls = new Map();        // peerId -> MediaConnection
  const videoTiles = new Map();        // peerId -> { el, name }
  let lastRoster = [];                 // from host

  // Use your local PeerJS signaling server (mounted at /peerjs on your Express app)
  // Build PeerJS options safely (no :undefined in URL)
  const PEER_OPTS_BASE = {
    host: location.hostname,
    secure: location.protocol === 'https:',
    path: '/peerjs',
    debug: 1,
    config: {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    }
  };
  const PEER_OPTS = location.port
    ? { ...PEER_OPTS_BASE, port: parseInt(location.port, 10) }
    : PEER_OPTS_BASE;
  const makePeer = (id) => new Peer(id, PEER_OPTS);

  let searchQuery = ''; // NEW

  // ====== Helpers ======
  function defaultNick(){
    const pool = ['Nova','Echo','Lark','Quill','Slate','Wren','Kite','Ember','Rune','Coda','Jett','Nyx','Koi','Moss','Vega','Skye','Pine','Reef','Flint','Drift'];
    return `Guest-${pool[Math.floor(Math.random()*pool.length)]}`;
  }
  const nowHHMM = () => new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  function setConnected(on){
    roomStatus.textContent = on ? (isHost ? `Hosting “${loungeName}”` : `Connected • “${loungeName}”`) : 'Not connected';
    connDot.classList.toggle('off', !on);
    updateKeyChip();
  }
  function appendMessage({ text, from, mine=false, system=false, ts }){
    const li = msgTemplate.content.firstElementChild.cloneNode(true);
    li.classList.toggle('me', mine);
    const name = system ? 'system' : (from || 'unknown');
    const fromEl = li.querySelector('.from');
    fromEl.textContent = name;
    fromEl.style.fontWeight = '700';
    fromEl.style.color = system ? 'var(--muted)' : colorFor(name, 1.0);
    li.querySelector('.time').textContent = ts ? new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}) : nowHHMM();
    li.querySelector('.text').textContent = text;
    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function showChatUI(){
    setup.classList.add('hidden');
    chat.classList.remove('hidden');
    ensurePeoplePane();
    ensureVideoUI();
    renderPeople();
    updateKeyChip();
  }
  function showSetupUI(){ chat.classList.add('hidden'); setup.classList.remove('hidden'); updateKeyChip(); }

  function slugify(name){
    return name.toLowerCase().trim()
      .replace(/[^a-z0-9 _-]+/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '');
  }
  function initials(s){
    const parts = String(s).trim().split(/\s+/);
    const first = (parts[0]||'')[0] || '';
    const last  = (parts[1]||'')[0] || '';
    return (first + last).toUpperCase() || (String(s)[0]||'?').toUpperCase();
  }
  function hashCode(str){
    let h = 0; for (let i=0;i<str.length;i++){ h = (h<<5) - h + str.charCodeAt(i); h |= 0; }
    return h >>> 0;
  }
  function colorFor(name, alpha=1){
    const hues = [210, 260, 320, 20, 140, 180, 0, 80];
    const h = hues[hashCode(name) % hues.length];
    return `hsla(${h} 70% 70% / ${alpha})`;
  }
  async function hostIdFromSlug(s){ return stableId(`onetime:${s}`); }
  async function hostIdFromSlugKey(s, key){ return stableId(`onetime:${s}:${key}`); }
  async function stableId(seed){
    try{
      const enc = new TextEncoder().encode(seed);
      const buf = await crypto.subtle.digest('SHA-256', enc);
      const hex = [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
      return `onetime-${hex.slice(0,24)}`;
    }catch{
      return `onetime-${hashCode(seed).toString(16).slice(0,8)}`;
    }
  }

  function toast(msg){
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = `
      position:fixed; left:50%; top:16px; transform:translateX(-50%);
      background: rgba(0,0,0,.7); color:#fff; padding:8px 12px; border-radius:10px; z-index:9999;
      font-size:13px; box-shadow:0 6px 14px rgba(0,0,0,0.3)
    `;
    document.body.appendChild(t);
    setTimeout(()=>t.remove(), 1400);
  }

  // Small util for search debounce
  function debounce(fn, ms){ let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args), ms); }; }

  // ====== Server API ======
  const API = {
    async upsertPublic(slug, name, isPrivate=false){
      return fetch('/lounges', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ slug, name, isPrivate })
      }).catch(()=>{});
    },
    async listPublic(){
      const r = await fetch('/lounges');
      return r.ok ? r.json() : [];
    },
    subscribeLounges(onLounges){
      try {
        sse?.close?.();
        sse = new EventSource('/events');
        sse.addEventListener('lounges', (ev) => {
          try { onLounges(JSON.parse(ev.data)); } catch {}
        });
      } catch {}
    },

    // Private registry
    async privateUpsert(slug, name, key){
      const r = await fetch('/private-lounges', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ slug, name, key })
      });
      let data=null; try{ data = await r.json(); }catch{}
      return { ok:r.ok, status:r.status, ...(data||{}) };
    },
    async privateResolveByKey(key){
      const r = await fetch('/private-lounges/resolve-by-key', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ key })
      });
      let data=null; try{ data = await r.json(); }catch{}
      return { ok:r.ok, status:r.status, ...(data||{}) };
    },

    // Presence for listed lounges (public & listed-private)
    async presenceJoin(slug, name){
      return fetch('/presence/join', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ slug, name })
      }).catch(()=>{});
    },
    async heartbeat(slug, count){
      return fetch('/presence/heartbeat', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ slug, count })
      }).catch(()=>{});
    },
    async presenceLeave(slug){
      return fetch('/presence/leave', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ slug })
      }).catch(()=>{});
    },

    // Popularity click
    async hit(slug){
      return fetch('/lounges/hit', {
        method: 'POST',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ slug })
      }).catch(()=>{});
    }
  };

  // ====== Sorting + Search (client-side) ======
  function applySort(items){
    const mode = (sortSelect?.value || 'recent');
    const byName = (a,b) => a.name.localeCompare(b.name, undefined, { sensitivity:'base' });

    if (mode === 'popular'){
      return items.sort((a,b) =>
        (Number(b.weeklyHits||0) - Number(a.weeklyHits||0)) ||
        (Number(b.count||0)      - Number(a.count||0))      ||
        (Number(b.createdAt||0)  - Number(a.createdAt||0))  ||
        byName(a,b)
      );
    } else if (mode === 'online'){
      return items.sort((a,b) =>
        (Number(b.count||0)     - Number(a.count||0))     ||
        (Number(b.weeklyHits||0)- Number(a.weeklyHits||0))||
        (Number(b.createdAt||0) - Number(a.createdAt||0)) ||
        byName(a,b)
      );
    } else if (mode === 'az'){
      return items.sort(byName);
    }
    // recent (default)
    return items.sort((a,b) =>
      (Number(b.createdAt||0) - Number(a.createdAt||0)) ||
      (Number(b.lastSeen||0)  - Number(a.lastSeen||0))  ||
      (Number(b.count||0)     - Number(a.count||0))     ||
      byName(a,b)
    );
  }

  function filterLounges(items, q){
    if (!q) return items;
    const tokens = q.split(/\s+/).filter(Boolean);
    return items.filter(l => {
      const hay = `${l.name} ${l.slug}`.toLowerCase();
      return tokens.every(t => hay.includes(t));
    });
  }

  function updateLounges(items){
    lastLounges = Array.isArray(items) ? items : [];
    const filtered = filterLounges(lastLounges, searchQuery);
    renderLounges(applySort([...filtered]));
  }

  sortSelect?.addEventListener('change', () => updateLounges(lastLounges));

  const debouncedSearch = debounce((q) => {
    searchQuery = (q || '').trim().toLowerCase();
    updateLounges(lastLounges);
  }, 120);
  searchInput?.addEventListener('input', (e) => debouncedSearch(e.target.value));
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.currentTarget.value = '';
      debouncedSearch('');
    }
  });

  // ====== Browse list ======
  const loungeList = $('#loungeList');
  const emptyState = $('#emptyState');

  function renderLounges(items){
    if (!loungeList || !emptyState) return;
    loungeList.innerHTML = '';

    const has = items && items.length > 0;
    emptyState.textContent = (lastLounges.length && !has && searchQuery)
      ? 'No results. Try a different search.'
      : 'No lounges yet. Create one or check back soon.';
    emptyState.style.display = has ? 'none' : 'block';
    if(!has) return;

    for (const l of items){
      const li = document.createElement('li');
      li.className = 'loungeRow';
      li.style.cssText = `
        display:grid; grid-template-columns: 1fr auto; align-items:center; gap:12px;
        padding:12px 14px; border-radius:12px; border:1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
      `;
      const left = document.createElement('div');
      left.style.cssText = 'display:flex; align-items:center; gap:10px;';
      const avatar = document.createElement('div');
      avatar.textContent = initials(l.name);
      avatar.style.cssText = `
        width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;
        font-weight:800; background:${colorFor(l.name,.25)}; border:1px solid ${colorFor(l.name,.55)};
      `;
      const text = document.createElement('div');
      const name = document.createElement('div');
      name.textContent = l.name;
      name.style.cssText = 'font-weight:800;';
      const sub = document.createElement('div');
      sub.className = 'muted tiny';
      sub.textContent = `${Number(l.count||0)} online • /${l.slug}`;
      text.appendChild(name);
      text.appendChild(sub);
      if (typeof l.weeklyHits === 'number') {
        const pop = document.createElement('div');
        pop.className = 'tiny muted';
        pop.textContent = `Popularity: ${l.weeklyHits}`;
        text.appendChild(pop);
      }
      left.appendChild(avatar); left.appendChild(text);

      const right = document.createElement('div');
      right.style.cssText = 'display:flex; align-items:center; gap:10px;';
      if (l.private) {
        const priv = document.createElement('span');
        priv.className = 'pill';
        priv.textContent = 'Private';
        right.appendChild(priv);
      }
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.textContent = (l.count || 0) > 0 ? 'Active' : 'Idle';
      const btn = document.createElement('button');
      btn.className = 'btn sm primary';
      btn.textContent = 'Join';
      btn.addEventListener('click', async () => {
        API.hit(l.slug); // count popularity click

        if (l.private){
          setActiveTab('join');
          joinKeyInput.value = '';
          joinKeyInput.placeholder = `Enter key for “${l.name}”`;
          joinKeyInput.focus();
        } else {
          isPrivate = false; privateKey = ''; listPublic = true;
          slug = l.slug; loungeName = l.name;
          const hId = await hostIdFromSlug(slug);
          joinOrAutoHost(hId, slug);
        }
      });
      right.appendChild(pill); right.appendChild(btn);

      li.appendChild(left); li.appendChild(right);
      loungeList.appendChild(li);
    }
    ensureRowGaps();
  }

  async function ensureSSE(){
    if (sseSubscribed) return;
    sseSubscribed = true;
    updateLounges(await API.listPublic());
    API.subscribeLounges(updateLounges);
  }

  // ====== Nickname ======
  saveNameBtn?.addEventListener('click', () => {
    nickname = nicknameInput.value.trim() || defaultNick();
    if (isHost) renderPeople();
  });

  // ====== Key generation (10-char base62) ======
  function generateKey10(){
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const arr = new Uint8Array(10);
    crypto.getRandomValues(arr);
    let out = '';
    for (let i=0;i<10;i++){ out += alphabet[arr[i] % alphabet.length]; }
    return out;
  }

  // ====== Visibility handling ======
  function setVisButtons(){
    visPublicBtn.classList.toggle('primary', !isPrivate);
    visPublicBtn.classList.toggle('ghost', isPrivate);
    visPublicBtn.setAttribute('aria-pressed', String(!isPrivate));
    visPrivateBtn.classList.toggle('primary', isPrivate);
    visPrivateBtn.classList.toggle('ghost', !isPrivate);
    visPrivateBtn.setAttribute('aria-pressed', String(isPrivate));

    privateKeyWrap.style.display = isPrivate ? 'flex' : 'none';
    showPrivateRow.style.display = isPrivate ? 'flex' : 'none';

    // listing rule
    listPublic = isPrivate ? !!showPrivatePublic.checked : true;

    if (isPrivate && !privateKey){
      privateKey = generateKey10();
      privateKeyValue.value = privateKey;
    }
  }
  visPublicBtn?.addEventListener('click', () => { isPrivate = false; setVisButtons(); });
  visPrivateBtn?.addEventListener('click', () => { isPrivate = true; setVisButtons(); });
  showPrivatePublic?.addEventListener('change', () => { if (isPrivate) listPublic = !!showPrivatePublic.checked; });

  copyKeyBtn?.addEventListener('click', async () => {
    if (!privateKeyValue?.value) return;
    try { await navigator.clipboard.writeText(privateKeyValue.value); toast('Key copied'); } catch {}
  });

  // initialize default: Public
  isPrivate = false; setVisButtons();

  // ====== Create ======
  startBtn?.addEventListener('click', async () => {
    const raw = (startNameInput.value || '').trim();
    if(!raw){ startNameInput.focus(); return; }
    slug = slugify(raw);
    if(!slug){ roomStatus.textContent = 'Choose a simpler name'; return; }
    loungeName = raw;

    if (isPrivate) {
      // allocate unique key
      let tries = 0, res;
      do {
        if (!privateKey) { privateKey = generateKey10(); privateKeyValue.value = privateKey; }
        res = await API.privateUpsert(slug, loungeName, privateKey);
        if (!res.ok && res.status === 409) { privateKey = ''; privateKeyValue.value = ''; tries++; }
        else break;
      } while (tries < 5);
      if (!res.ok && res.status === 409){
        roomStatus.textContent = 'Could not allocate a unique key — try again.';
        return;
      }
      if (listPublic) await API.upsertPublic(slug, loungeName, /*isPrivate*/ true);
      hostId = await hostIdFromSlugKey(slug, privateKey);
      toast(`Private key: ${formatKey(privateKey)} (copied)`);
      try { await navigator.clipboard.writeText(privateKey); } catch {}
    } else {
      await API.upsertPublic(slug, loungeName, /*isPrivate*/ false);
      hostId = await hostIdFromSlug(slug);
    }

    becomeHost(hostId, slug);
  });

  // ====== Join (Key-only for private) ======
  joinBtn?.addEventListener('click', async () => {
    const keyVal = (joinKeyInput?.value || '').trim().replace(/[^A-Za-z0-9]/g,'');
    if (!keyVal){
      roomStatus.textContent = 'Enter a private key.';
      return;
    }
    const res = await API.privateResolveByKey(keyVal);
    if (!res.ok){
      roomStatus.textContent = 'Invalid or unknown key.';
      return;
    }
    slug = res.slug;
    loungeName = res.name || 'Private Lounge';
    hostId = res.hostId;
    isPrivate = true; privateKey = keyVal; listPublic = false;
    joinOrAutoHost(hostId, slug);
  });

  // ====== PeerJS wiring ======
  function attachMediaAnswering(p){
    if (!p) return;
    p.on('call', async (call) => {
      if (loungeMode !== 'video') { try{ call.close(); }catch{}; return; }
      const stream = await ensureLocalMedia();
      if (!stream) { try{ call.close(); }catch{}; return; }

      mediaCalls.set(call.peer, call);
      try { call.answer(stream); } catch {}
      call.on('stream', (remote) => upsertRemoteTile(call.peer, nameForPeer(call.peer), remote));
      call.on('close',  () => teardownPeerMedia(call.peer));
      call.on('error',  () => teardownPeerMedia(call.peer));
    });
  }

  function joinOrAutoHost(hId, theSlug){
    peer = makePeer(undefined);
    attachMediaAnswering(peer);

    peer.on('open', () => {
      const c = peer.connect(hId, { reliable: true });
      let decided = false;

      const decideTimer = setTimeout(async () => {
        if(!decided){
          await becomeHost(hId, theSlug); // no host → take over
          decided = true;
        }
      }, 900);

      c.on('open', () => {
        if(decided) return;
        decided = true;
        isHost = false;
        conn = c;
        wireGuestConnEvents(conn);
        setConnected(true); showChatUI();
        appendMessage({system:true, text:`Joined “${loungeName}”.`});
        safeSend(conn, {type:'intro', name: nickname});
        clearTimeout(decideTimer);
        // if already in video mode, kick media sync
        if (loungeMode === 'video') syncMediaWithRoster();
      });

      c.on('error', () => { /* decideTimer may promote to host */ });
    });

    peer.on('error', err => {
      appendMessage({system:true, text:`Peer error: ${err?.type || err?.message || err}`});
    });
  }

  async function becomeHost(hId, theSlug){
    try{ peer && peer.destroy(); }catch{}
    isHost = true;
    slug = theSlug;
    hostId = hId;
    peer = makePeer(hId);
    attachMediaAnswering(peer);

    peer.on('open', async () => {
      setConnected(true);
      showChatUI();
      appendMessage({system:true, text:`Hosting “${loungeName}”. Waiting for others…`});

      // Directory + presence for anything listed (public OR listed-private)
      if (listPublic){
        await API.upsertPublic(slug, loungeName, !!isPrivate);
        await API.presenceJoin(slug, loungeName);
        sendHeartbeat();
        heartbeatTimer = setInterval(sendHeartbeat, 10_000);
      }

      // track own name under real peer id
      if (peer?.id) peersMeta.set(peer.id, { name: nickname });
      renderPeople();

      if (loungeMode === 'video') { await syncMediaWithRoster(); }
    });

    configureHostEventHandlers();

    peer.on('disconnected', () => setConnected(false));
    peer.on('close', async () => { setConnected(false); await cleanupPresence(); });
    peer.on('error', err => {
      appendMessage({system:true, text:`Peer error: ${err?.type || err?.message || err}`});
    });
  }

  function configureHostEventHandlers(){
    peer.on('connection', (c) => {
      conns.set(c.peer, c);
      c.on('open', () => {
        safeSend(c, {type:'intro', name: nickname});
        safeSend(c, {type:'intro-please'});
        appendMessage({system:true, text:`${c.peer} connected.`});
        sendRoster();
        sendHeartbeatSoon();
      });
      c.on('data', (raw) => handleHostData(c, raw));
      c.on('close', () => {
        const name = peersMeta.get(c.peer)?.name || c.peer;
        appendMessage({system:true, text:`${name} left.`});
        peersMeta.delete(c.peer); conns.delete(c.peer);
        teardownPeerMedia(c.peer);                 // <-- remove their video
        sendRoster();
        sendHeartbeatSoon();
      });
      c.on('error', () => {});
    });
  }

  function wireGuestConnEvents(c){
    c.on('data', (raw) => handleClientData(raw));
    c.on('close', () => {
      appendMessage({system:true, text:'Host disconnected — trying to continue…'});
      setConnected(false);
      attemptRecovery();
    });
    c.on('error', () => {});
  }

  // ====== Host failover ======
  async function attemptRecovery(){
    if (isHost || electionInProgress) return;
    electionInProgress = true;

    const delay = 100 + Math.floor(Math.random()*600);
    await new Promise(r => setTimeout(r, delay));

    try {
      const newPeer = makePeer(hostId);
      attachMediaAnswering(newPeer);
      newPeer.on('open', async () => {
        try { peer?.destroy?.(); } catch {}
        peer = newPeer; isHost = true;
        appendMessage({system:true, text:'Host changed — you are now the host.'});
        setConnected(true);

        if (peer?.id && !peersMeta.has(peer.id)) peersMeta.set(peer.id, { name: nickname });

        if (listPublic){
          await API.upsertPublic(slug, loungeName, !!isPrivate);
          await API.presenceJoin(slug, loungeName);
          sendHeartbeat();
          clearInterval(heartbeatTimer); heartbeatTimer = setInterval(sendHeartbeat, 10_000);
        }

        configureHostEventHandlers();
        sendRoster();
        if (loungeMode === 'video') { await syncMediaWithRoster(); }
        electionInProgress = false;
      });

      newPeer.on('error', async () => {
        await reconnectToHost();
        electionInProgress = false;
      });
    } catch {
      await reconnectToHost();
      electionInProgress = false;
    }
  }

  async function reconnectToHost(){
    try { peer?.destroy?.(); } catch {}
    peer = makePeer(undefined);
    attachMediaAnswering(peer);
    await new Promise(res => peer.on('open', res));
    const c = peer.connect(hostId, { reliable: true });
    c.on('open', () => {
      conn = c; isHost = false;
      setConnected(true);
      appendMessage({system:true, text:'Reconnected to the new host.'});
      wireGuestConnEvents(conn);
      safeSend(conn, {type:'intro', name: nickname});
      if (loungeMode === 'video') { syncMediaWithRoster(); }
    });
    c.on('error', () => {});
  }

  // ====== Message handling + roster ======
  function handleClientData(raw){
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === 'chat'){
      appendMessage({text: msg.text, from: msg.from, ts: msg.ts});
    } else if (msg.type === 'system'){
      appendMessage({system:true, text: msg.text});
    } else if (msg.type === 'intro-please'){
      safeSend(conn, {type:'intro', name: nickname});
    } else if (msg.type === 'roster'){
      applyRoster(msg.members);
    }
  }

  function handleHostData(c, raw){
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }
    if(msg.type === 'intro'){
      const nm = msg.name || `Guest-${c.peer.slice(0,4)}`;
      peersMeta.set(c.peer, { name: nm });
      broadcast({type:'system', text:`${nm} joined.`}, c.peer);
      sendRoster();
    } else if (msg.type === 'chat'){
      const fromName = peersMeta.get(c.peer)?.name || 'Guest';
      for(const [pid, cc] of conns){ if(pid !== c.peer) safeSend(cc, {type:'chat', text: msg.text, ts: msg.ts, from: fromName}); }
      appendMessage({text: msg.text, from: fromName, ts: msg.ts});
    }
  }

  function sendRoster(){
    const members = computeRoster();
    broadcast({ type:'roster', members });
    renderPeople();
  }

  // (UPDATED) include real peer id for self; de-dupe by id
  function computeRoster(){
    const myId = peer?.id || 'self';
    const out = [{ id: myId, name: nickname, you:true }];
    for (const [pid, meta] of peersMeta){
      if (!conns.has(pid)) continue;
      out.push({ id: pid, name: meta?.name || `Guest-${pid.slice(0,4)}` });
    }
    const seen = new Set();
    return out.filter(m => {
      const key = m.id || m.name;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  // (UPDATED) track roster + drive media
  function applyRoster(members){
    lastRoster = Array.isArray(members) ? members : [];
    peersMeta.clear();
    for (const m of lastRoster){
      peersMeta.set(m.id || m.name, { name: m.name });
    }
    renderPeople();
    if (loungeMode === 'video') { syncMediaWithRoster(); }
  }

  function broadcast(payload, exceptPeerId){
    for(const [pid, c] of conns){ if(pid === exceptPeerId) continue; safeSend(c, payload); }
  }
  function safeSend(connection, obj){
    try { connection.send(JSON.stringify(obj)); } catch {}
  }

  // ====== Heartbeats ======
  function sendHeartbeat(){
    if (isHost && slug && listPublic){
      const count = conns.size + 1;
      API.heartbeat(slug, count);
    }
  }
  let hbDebounce = null;
  function sendHeartbeatSoon(){
    if (!listPublic) return;
    clearTimeout(hbDebounce);
    hbDebounce = setTimeout(sendHeartbeat, 250);
  }
  async function cleanupPresence(){
    clearInterval(heartbeatTimer); heartbeatTimer = null;
    if (slug && listPublic) await API.presenceLeave(slug);
  }

  // ====== Multi-party media helpers ======
  async function ensureLocalMedia(){
    if (localStream) return localStream;
    try{
      localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
      upsertLocalTile();
      return localStream;
    }catch(e){
      toast('Camera/mic blocked.');
      return null;
    }
  }
  function upsertLocalTile(){
    const myId = peer?.id;
    if (!myId || !localStream) return;
    upsertTile(myId, `${nickname} (you)`, localStream, /*muted*/true);
  }
  function upsertRemoteTile(peerId, name, stream){
    upsertTile(peerId, name, stream, /*muted*/false);
  }
  function upsertTile(peerId, name, stream, muted){
    let tile = videoTiles.get(peerId)?.el;
    if (!tile){
      tile = document.createElement('div');
      tile.className = 'videoTile';
      tile.style.cssText = `
        position:relative; border-radius:12px; overflow:hidden;
        border:1px solid rgba(255,255,255,0.22); box-shadow:0 12px 28px rgba(0,0,0,0.25);
        background:rgba(255,255,255,0.06);
      `;
      tile.innerHTML = `
        <video playsinline autoplay ${muted ? 'muted' : ''} style="width:100%;height:100%;aspect-ratio:16/9;object-fit:cover;${muted?'transform:scaleX(-1);':''}"></video>
        <div class="label" style="position:absolute;left:8px;bottom:8px;background:rgba(0,0,0,.55);color:#fff;padding:2px 8px;font-size:12px;border-radius:999px;"></div>
      `;
      videoGrid.appendChild(tile);
      videoTiles.set(peerId, { el: tile, name });
    }
    const v = tile.querySelector('video');
    if (v.srcObject !== stream) v.srcObject = stream;
    tile.querySelector('.label').textContent = name || peerId;
  }
  function teardownPeerMedia(peerId){
    const call = mediaCalls.get(peerId);
    try { call?.close?.(); } catch {}
    mediaCalls.delete(peerId);
    const tile = videoTiles.get(peerId)?.el;
    if (tile){ try { tile.remove(); } catch {} }
    videoTiles.delete(peerId);
  }
  function stopAllMedia(){
    for (const [,call] of mediaCalls){ try{ call.close(); }catch{} }
    mediaCalls.clear();
    for (const [,tile] of videoTiles){ try{ tile.el.remove(); }catch{} }
    videoTiles.clear();
    if (localStream){
      for (const tr of localStream.getTracks()){ try{ tr.stop(); }catch{} }
      localStream = null;
    }
  }
  function nameForPeer(pid){
    if (pid === peer?.id) return `${nickname} (you)`;
    return peersMeta.get(pid)?.name || `Guest-${String(pid).slice(0,4)}`;
  }

  async function syncMediaWithRoster(){
    if (loungeMode !== 'video') return;
    if (!peer?.id) return;

    const stream = await ensureLocalMedia();
    if (!stream) return;

    const myId = peer.id;
    const targets = lastRoster
      .filter(m => m.id && m.id !== myId)
      .map(m => ({ id: m.id, name: m.name }));

    // establish calls to peers with greater id to avoid duplicates
    for (const t of targets){
      if (mediaCalls.has(t.id)) continue;
      if (myId < t.id){
        try {
          const call = peer.call(t.id, stream);
          if (!call) continue;
          mediaCalls.set(t.id, call);
          call.on('stream', (remote) => upsertRemoteTile(t.id, nameForPeer(t.id), remote));
          call.on('close',  () => teardownPeerMedia(t.id));
          call.on('error',  () => teardownPeerMedia(t.id));
        } catch {}
      }
    }

    const present = new Set(targets.map(t => t.id).concat([myId]));
    for (const pid of Array.from(videoTiles.keys())){
      if (!present.has(pid)) teardownPeerMedia(pid);
    }
  }

  function updateLoungeModeUI(){
    if (!lgModeHeading || !videoGrid) return;
    lgModeHeading.textContent = loungeMode === 'video' ? 'Video Chat' : 'Message Chat';
    videoGrid.style.display = (loungeMode === 'video') ? 'grid' : 'none';
    messagesEl.style.display = (loungeMode === 'video') ? 'none' : '';
    composer.style.display   = (loungeMode === 'video') ? 'none' : 'flex';
  }

  // ====== Send message ======
  composer?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if(!text) return;
    const packet = { type:'chat', text, ts: Date.now(), from: nickname };

    if(isHost){
      appendMessage({ text, from: nickname, ts: packet.ts, mine: true });
      broadcast(packet, null);
      sendHeartbeatSoon();
    } else if (conn && conn.open){
      appendMessage({ text, from: nickname, ts: packet.ts, mine: true });
      safeSend(conn, packet);
    } else {
      roomStatus.textContent = 'Not connected';
    }
    msgInput.value = '';
  });

  // ====== Leave ======
  leaveBtn?.addEventListener('click', gracefulLeave);
  function gracefulLeave(){
    try {
      if(isHost){
        broadcast({type:'system', text:'Host leaving — electing new host…'}, null);
        for(const c of conns.values()){ try{ c.close(); }catch{} }
        conns.clear();
      } else if (conn){
        try { conn.close(); } catch{}
      }
      if(peer){ try{ peer.destroy(); }catch{} }
      stopAllMedia(); // <-- also tear down video
    } finally {
      setConnected(false);
      showSetupUI();
      messagesEl.innerHTML = '';
      conn = null; peer = null; isHost = false; hostId = null; loungeName = null; slug = null;
      peersMeta.clear();
      cleanupPresence();
      ensureRowGaps();
    }
  }

  // ====== Startup ======
  ensureRowGaps();
  setActiveTab('browse');
  ensureVideoUI();
  updateLoungeModeUI();

  window.addEventListener('beforeunload', () => {
    try { gracefulLeave(); } catch {}
  });
})();
