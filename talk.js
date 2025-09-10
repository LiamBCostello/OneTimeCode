(() => {
  // DOM helpers
  const $ = s => document.querySelector(s);

  // Core nodes
  const messagesEl      = $('#messages');
  const composer        = $('#composer');
  const msgInput        = $('#msgInput');
  const roomStatus      = $('#roomStatus');
  const connDot         = $('#connDot');
  const nextBtn         = $('#nextBtn');
  const leaveBtn        = $('#leaveBtn');
  const statusEl        = $('#matchStatus');
  const locFilter       = $('#locFilter');
  const modeSwitch      = $('#modeSwitch');
  const modeHeadingText = $('#modeHeadingText');

  const videoArea  = $('#videoArea');
  const localVideo = $('#localVideo');
  const remoteVideo= $('#remoteVideo');

  const msgTemplate = $('#msgTemplate');

// Fast matching tunables
  const CONNECT_TIMEOUT_MS = 160;  // very short per-slot timeout
  const BATCH_SIZE = 6;            // probe this many slots at once


  // ---- Dynamically add switch bars (no HTML edits needed) ----
  let videoSwitchBar, requestTextBtn;   // visible in VIDEO mode
  let textSwitchBar,  requestVideoBtn;  // visible in MESSAGE mode

  function ensureSwitchUI(){
    // Bar shown IN VIDEO mode (replaces composer)
    if (!videoSwitchBar) {
      videoSwitchBar = document.createElement('div');
      videoSwitchBar.id = 'videoSwitchBar';
      videoSwitchBar.className = 'inputBar hidden';
      videoSwitchBar.innerHTML = `
        <button id="requestTextBtn" class="btn primary sendBtn" type="button">Move to Message Chat</button>
      `;
      composer.parentElement.insertBefore(videoSwitchBar, composer);
      requestTextBtn = $('#requestTextBtn');
    }
    // Bar shown IN MESSAGE mode (under composer)
    if (!textSwitchBar) {
      textSwitchBar = document.createElement('div');
      textSwitchBar.id = 'textSwitchBar';
      textSwitchBar.className = 'row';
      textSwitchBar.style.marginTop = '8px';
      textSwitchBar.style.justifyContent = 'flex-end';
      textSwitchBar.innerHTML = `
        <button id="requestVideoBtn" class="btn" type="button">Move to Video Chat</button>
      `;
      composer.parentElement.insertBefore(textSwitchBar, composer.nextSibling);
      requestVideoBtn = $('#requestVideoBtn');
    }
    if (requestTextBtn && !requestTextBtn.__wired) {
      requestTextBtn.__wired = true;
      requestTextBtn.addEventListener('click', onRequestText);
    }
    if (requestVideoBtn && !requestVideoBtn.__wired) {
      requestVideoBtn.__wired = true;
      requestVideoBtn.addEventListener('click', onRequestVideo);
    }
  }

  // ---- State ----
  let peer        = null;   // PeerJS instance
  let conn        = null;   // DataConnection to stranger
  let mediaCall   = null;   // PeerJS MediaConnection (video)
  let localStream = null;
  let remoteStream= null;

  let isHost      = false;  // matchmaking role (not shown in UI)
  let currentSlot = null;
  let cancelled   = false;
  let filter      = 'all';
  let mode        = 'text'; // 'text' | 'video'

  // Consent-based switching
  let localSwitchRequest  = null; // 'text' | 'video' | null
  let remoteSwitchRequest = null; // 'text' | 'video' | null

  // For Next/Space behavior
  let conversationStartMode   = null; // 'text' | 'video'
  let switchedFromTextToVideo = false;

  const SLOT_COUNT = 28; // pool size per (mode, region)

// Build PeerJS options safely (no :undefined in URL)
const PEER_OPTS_BASE = {
  host: location.hostname,
  secure: location.protocol === 'https:',
  path: '/peerjs',
  debug: 1,
  // STUN is fine to keep
  config: {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  }
};

// Only add a port if the browser location actually has one (e.g., localhost:3000)
const PEER_OPTS = location.port
  ? { ...PEER_OPTS_BASE, port: parseInt(location.port, 10) }
  : PEER_OPTS_BASE;

const makePeer = (id) => new Peer(id, PEER_OPTS);

  // ---------- UI helpers ----------
  function setConnected(on){
    roomStatus.textContent = on ? 'Connected' : 'Connecting…';
    connDot.classList.toggle('off', !on);
    setSwitchButtonsEnabled(on);
  }
  function setSwitchButtonsEnabled(on){
    ensureSwitchUI();
    if (requestTextBtn)  requestTextBtn.disabled  = !on;
    if (requestVideoBtn) requestVideoBtn.disabled = !on;
  }
  const nowHHMM = () => new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
  function appendMessage({ text, from, mine=false, system=false, ts }){
    const li = msgTemplate.content.firstElementChild.cloneNode(true);
    li.classList.toggle('me', mine);
    li.querySelector('.from').textContent = system ? 'system' : (from || 'Stranger');
    li.querySelector('.time').textContent = ts
      ? new Date(ts).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'})
      : nowHHMM();
    li.querySelector('.text').textContent = text;
    messagesEl.appendChild(li);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
  function setStatus(t){ statusEl.textContent = t || ''; }

  // CSS-driven layout toggle (matches your style.css `.videoArea.sbs`)
  function setSBS(on){
    videoArea?.classList.toggle('sbs', !!on);
  }

  function updateModeUI(){
    ensureSwitchUI();

    modeHeadingText.textContent = mode === 'video' ? 'Video Chat' : 'Message Chat';
    modeSwitch.checked = mode === 'video';

    // Show/Hide sections (hide transcript entirely in video mode)
    if (videoArea)   videoArea.classList.toggle('hidden', mode !== 'video');
    if (messagesEl)  messagesEl.style.display = (mode === 'video') ? 'none' : '';
    if (composer)    composer.style.display   = (mode === 'video') ? 'none' : 'flex';

    if (videoSwitchBar) videoSwitchBar.classList.toggle('hidden', mode !== 'video');
    if (textSwitchBar)  textSwitchBar.classList.toggle('hidden', mode === 'video');

    // Default to side-by-side whenever Video is active
    if (mode === 'video') setSBS(true);

    refreshConsentButtonLabels();
  }

  function refreshConsentButtonLabels(){
    ensureSwitchUI();
    if (requestTextBtn) {
      const local  = localSwitchRequest  === 'text';
      const remote = remoteSwitchRequest === 'text';
      requestTextBtn.textContent = local
        ? (remote ? 'Switching…' : 'Requested — waiting for other user')
        : 'Move to Message Chat';
    }
    if (requestVideoBtn) {
      const local  = localSwitchRequest  === 'video';
      const remote = remoteSwitchRequest === 'video';
      requestVideoBtn.textContent = local
        ? (remote ? 'Switching…' : 'Requested — waiting for other user')
        : 'Move to Video Chat';
    }
  }

  // ---------- Slot logic (serverless matchmaking) ----------
  function slotIdsForFilter(f){
    const base = mode === 'video' ? 'onetime-talk-video' : 'onetime-talk-text';
    const prefix = f === 'all' ? base : `${base}-${f}`;
    return Array.from({length: SLOT_COUNT}, (_,i) => `${prefix}-${i}`);
  }
  function shuffle(arr){
    for(let i=arr.length-1;i>0;i--){
      const j = Math.floor(Math.random()*(i+1));
      [arr[i],arr[j]] = [arr[j],arr[i]];
    }
    return arr;
  }

  function resetAll(){
    try {
      if (mediaCall) { try { mediaCall.close(); } catch {} }
      if (conn)      { try { conn.close(); }      catch {} }
      if (peer)      { try { peer.destroy(); }    catch {} }
      stopStreams();
    } finally {
      mediaCall = null;
      conn = null; peer = null; isHost = false; currentSlot = null; cancelled = false;
      localSwitchRequest = null; remoteSwitchRequest = null;
      conversationStartMode = null; switchedFromTextToVideo = false;
      setConnected(false);
      messagesEl.innerHTML = '';
      setStatus('');
      clearVideoEls();
      refreshConsentButtonLabels();
    }
  }

  function stopStreams(){
    if (localStream){
      for (const t of localStream.getTracks()) { try { t.stop(); } catch {} }
      localStream = null;
    }
    if (remoteStream){
      for (const t of remoteStream.getTracks()) { try { t.stop(); } catch {} }
      remoteStream = null;
    }
  }
  function clearVideoEls(){
    if (localVideo)  localVideo.srcObject  = null;
    if (remoteVideo) remoteVideo.srcObject = null;
  }

  async function ensureLocalMedia(){
    if (localStream) return localStream;
    try{
      localStream = await navigator.mediaDevices.getUserMedia({ video:true, audio:true });
      if (localVideo) localVideo.srcObject = localStream;
      return localStream;
    }catch(err){
      setStatus('Camera/mic blocked. Staying in Message mode.');
      try { conn?.send(JSON.stringify({ type:'switch-cannot-video' })); } catch {}
      return null;
    }
  }

  async function startMatching(){
  cancelled = false;
  setConnected(false);
  setStatus('Looking for a partner…');

  // If user chose Video, ask for media up-front (permission + local preview)
  if (mode === 'video'){
    const ok = await ensureLocalMedia();
    if (!ok){ mode = 'text'; updateModeUI(); }
  }

  // Create our PeerJS instance
  peer = makePeer(undefined);
  await new Promise(res => {
    let done = false;
    peer.on('open', () => { if(!done){ done=true; res(); } });
    peer.on('error', () => { if(!done){ done=true; res(); } });
  });
  if (cancelled) return;

  // Always be ready to answer media calls when in Video mode
  peer.on('call', async (call) => {
    if (mode !== 'video') { try{ call.close(); }catch{}; return; }
    const stream = await ensureLocalMedia();
    if (!stream) { try{ call.close(); }catch{}; return; }
    mediaCall = call;
    try { mediaCall.answer(stream); } catch {}
    wireMediaEvents(mediaCall);
  });

  // Shuffle candidate slots for this (mode, filter)
  const order = shuffle(slotIdsForFilter(filter));

  // Flip a coin: half of users will *host immediately*, the other half will *scan fast*.
  const preferHost = Math.random() < 0.5;

  // Fast client scan (parallel batches). If we find someone, we're done.
  if (!preferHost){
    for (let i = 0; i < order.length && !cancelled; i += BATCH_SIZE){
      const batch = order.slice(i, i + BATCH_SIZE);
      setStatus(`Scanning slots ${batch.map(s=>s.split('-').pop()).join(', ')}…`);
      const result = await tryConnectBatch(batch, CONNECT_TIMEOUT_MS);
      if (result === 'connected'){
        setStatus('Matched!');
        setConnected(true);
        if (mode === 'video'){
          const stream = await ensureLocalMedia();
          if (stream && !mediaCall){
            try { mediaCall = peer.call(currentSlot, stream); wireMediaEvents(mediaCall); } catch {}
          }
        }
        return;
      }
    }
  }
}

  // ---- Phase B: DETERMINISTIC FALLBACK (everyone converges here) ----
  const fixedSlot = fixedSlotIdForCurrent();

  // Try to become the host of the fixed slot…
  const hosted = await tryBecomeHost(fixedSlot);
  if (hosted){
    // We are now the well-known host for this mode/region.
    setStatus('Waiting for a partner…');
    appendMessage({system:true, text:'You are now connected once someone joins.'});
    return;
  }

  // If hosting failed, it means someone else won the race.
  // Immediately connect to that same fixed slot.
  const joined = await tryConnectToHost(fixedSlot, 1200);
  if (joined === 'connected'){
    setStatus('Matched!');
    setConnected(true);
    if (mode === 'video'){
      const stream = await ensureLocalMedia();
      if (stream && !mediaCall){
        try {
          mediaCall = peer.call(currentSlot, stream);
          wireMediaEvents(mediaCall);
        } catch {}
      }
    }
    return;
  }

  // If we get here, something transient happened — try again from the top.
  startMatching();
}

  // If we’re here, either we preferred hosting or scanning found nobody quickly → host now.
  const hostSlot = order[0];
  const ok = await tryBecomeHost(hostSlot);
  if (!ok){
    // Rare: race to claim the same slot. Do one more quick batch scan, then recurse.
    const result = await tryConnectBatch(order.slice(0, BATCH_SIZE), CONNECT_TIMEOUT_MS);
    if (result === 'connected'){
      setStatus('Matched!');
      setConnected(true);
      if (mode === 'video'){
        const stream = await ensureLocalMedia();
        if (stream && !mediaCall){
          try { mediaCall = peer.call(currentSlot, stream); wireMediaEvents(mediaCall); } catch {}
        }
      }
      return;
    }
    return startMatching(); // try again with a fresh shuffle
  }

  setStatus('Waiting for a partner…');
  appendMessage({system:true, text:'You are now connected when someone joins.'});
}

  function wireMediaEvents(call){
    call.on('stream', (remote) => {
      remoteStream = remote;
      if (remoteVideo) remoteVideo.srcObject = remoteStream;
    });
    call.on('close', () => {
      appendMessage({system:true, text:'Video call ended.'});
      remoteStream = null;
      if (remoteVideo) remoteVideo.srcObject = null;
    });
    call.on('error', () => {
      appendMessage({system:true, text:'Video call error.'});
    });
  }

  function tryConnectBatch(slots, ms){
  return new Promise(resolve => {
    if (!peer || peer.destroyed || !slots.length) return resolve('failed');

    let resolved = false;
    const conns = [];
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      // Close all still-pending connections
      for (const c of conns){ try { if (!c.open) c.close(); } catch {} }
      resolve(result);
    };

    // Start a watchdog to finish the batch quickly
    const timer = setTimeout(() => done('none'), ms);

    for (const slotId of slots){
      try {
        const c = peer.connect(slotId, { reliable: true });
        conns.push(c);

        c.on('open', () => {
          if (resolved) return;
          clearTimeout(timer);
          conn = c;
          isHost = false;
          currentSlot = slotId;

          // record how the conversation started
          conversationStartMode = mode;

          conn.on('data', onData);
          conn.on('close', () => {
            appendMessage({system:true, text:'Stranger disconnected.'});
            setConnected(false);
            setStatus('Partner left. Press Space or click Next.');
            if (mediaCall) { try { mediaCall.close(); } catch {} mediaCall = null; }
            clearVideoEls(); stopStreams();
            localSwitchRequest = null; remoteSwitchRequest = null;
            refreshConsentButtonLabels();
          });
          conn.on('error', () => {});
          done('connected');
        });

        c.on('error', () => {
          // if all fail, the timer will fire; no need to do anything here
        });
      } catch {
        // ignore and let timer resolve
      }
    }
  });
}

function tryConnectToHost(slotId, ms) {
  return new Promise(resolve => {
    if (!peer || peer.destroyed) return resolve('failed');
    let resolved = false;
    const done = (result) => { if (resolved) return; resolved = true; resolve(result); };

    const c = peer.connect(slotId, { reliable: true });

    // If the server says the peer doesn't exist or connection fails early, move on quickly
    c.on('error', () => { done('error'); });

    // Only give up after a proper ICE window
    const timer = setTimeout(() => { try { c.close(); } catch {} done('timeout'); }, ms);

    c.on('open', () => {
      clearTimeout(timer);
      conn = c;
      isHost = false;
      currentSlot = slotId;

      // record how this conversation began (used by your Next/Space logic)
      conversationStartMode = mode;

      conn.on('data', onData);
      conn.on('close', () => {
        appendMessage({system:true, text:'Stranger disconnected.'});
        setConnected(false);
        setStatus('Partner left. Press Space or click Next.');
        if (mediaCall) { try { mediaCall.close(); } catch {} mediaCall = null; }
        clearVideoEls(); stopStreams();
        localSwitchRequest = null; remoteSwitchRequest = null;
        refreshConsentButtonLabels();
      });
      conn.on('error', () => {});
      done('connected');
    });
  });
}

function tryBecomeHost(slotId){
  return new Promise(resolve => {
    try { if (peer) peer.destroy(); } catch {}
    isHost = true;
    currentSlot = slotId;
    peer = makePeer(slotId);

    // IMPORTANT: when we create a new Peer, we must re-attach the media call handler
    peer.on('call', async (call) => {
      if (mode !== 'video') { try { call.close(); } catch {} return; }
      const stream = await ensureLocalMedia();
      if (!stream) { try { call.close(); } catch {} return; }
      mediaCall = call;
      try { mediaCall.answer(stream); } catch {}
      wireMediaEvents(mediaCall);   // <-- use the function you already have
    });

    let resolved = false;
    const done = (ok) => { if (resolved) return; resolved = true; resolve(ok); };

    peer.on('open', () => {
      // Accept first data connection as the host
      peer.on('connection', (c) => {
        if (conn && conn.open) { try { c.close(); } catch {} return; }
        conn = c;
        conn.on('open', () => {
          setConnected(true);
          setStatus('Matched!');
          appendMessage({ system:true, text:'Partner joined.' });

          conversationStartMode = mode;

          conn.on('data', onData);
          conn.on('close', () => {
            appendMessage({system:true, text:'Stranger disconnected.'});
            setConnected(false);
            setStatus('Partner left. Press Space or click Next.');
            if (mediaCall) { try { mediaCall.close(); } catch {} mediaCall = null; }
            clearVideoEls(); stopStreams();
            localSwitchRequest = null; remoteSwitchRequest = null;
            refreshConsentButtonLabels();
          });
          conn.on('error', () => {});
        });
      });

      done(true);
    });

    peer.on('error', () => { done(false); });
  });
}

  // ---------- Data handling ----------
  function onData(raw){
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.type === 'chat'){
      appendMessage({text: msg.text, from: 'Stranger', ts: msg.ts});
      return;
    }
    if (msg.type === 'system'){
      appendMessage({system:true, text: msg.text});
      return;
    }

    // Consent switching protocol
    if (msg.type === 'switch-request'){
      const to = msg.to === 'video' ? 'video' : 'text';
      remoteSwitchRequest = to;
      if (to === 'text'){
        appendMessage({system:true, text:'They want to move to Message Chat. Click “Move to Message Chat” to accept.'});
      } else {
        appendMessage({system:true, text:'They want to move to Video Chat. Click “Move to Video Chat” to accept.'});
      }
      refreshConsentButtonLabels();
      considerCommit();
      return;
    }
    if (msg.type === 'switch-commit'){
      const to = msg.to === 'video' ? 'video' : 'text';
      performSwitch(to, /*fromRemote*/true);
      return;
    }
    if (msg.type === 'switch-cannot-video'){
      appendMessage({system:true, text:'The other user cannot start video (camera/mic blocked).'});
      if (remoteSwitchRequest === 'video') remoteSwitchRequest = null;
      if (localSwitchRequest  === 'video') localSwitchRequest  = null;
      refreshConsentButtonLabels();
      return;
    }
  }

  // ---------- Consent buttons ----------
  async function onRequestText(){
    if (!conn || !conn.open) return;
    localSwitchRequest = 'text';
    refreshConsentButtonLabels();
    appendMessage({system:true, text:'You requested to move to Message Chat. Waiting for the other user…'});
    try { conn.send(JSON.stringify({ type:'switch-request', to:'text' })); } catch {}
    considerCommit();
  }

  async function onRequestVideo(){
    if (!conn || !conn.open) return;
    // Preflight: get media to trigger permission now (and fail early if blocked)
    const stream = await ensureLocalMedia();
    if (!stream) {
      localSwitchRequest = null;
      refreshConsentButtonLabels();
      return;
    }
    localSwitchRequest = 'video';
    refreshConsentButtonLabels();
    appendMessage({system:true, text:'You requested to move to Video Chat. Waiting for the other user…'});
    try { conn.send(JSON.stringify({ type:'switch-request', to:'video' })); } catch {}
    considerCommit();
  }

  function considerCommit(){
    if (!localSwitchRequest || !remoteSwitchRequest) return;
    if (localSwitchRequest !== remoteSwitchRequest) return;
    const to = localSwitchRequest;
    try { conn?.send(JSON.stringify({ type:'switch-commit', to })); } catch {}
    performSwitch(to, /*fromRemote*/false);
  }

  // Actually perform the mode switch
  async function performSwitch(to, fromRemote){
    localSwitchRequest  = null;
    remoteSwitchRequest = null;

    if (to === 'text'){
      if (mediaCall) { try{ mediaCall.close(); }catch{}; mediaCall = null; }
      stopStreams(); clearVideoEls();
      mode = 'text';
      switchedFromTextToVideo = false;
      updateModeUI();
      appendMessage({system:true, text:'Switched to Message Chat.'});
      setStatus('Chatting via messages.');
      return;
    }

    // to === 'video'
    const stream = await ensureLocalMedia();
    if (!stream){
      if (!fromRemote) {
        try { conn?.send(JSON.stringify({ type:'switch-cannot-video' })); } catch {}
      }
      return;
    }

    switchedFromTextToVideo = (conversationStartMode === 'text');
    mode = 'video';
    updateModeUI();           // shows video + applies .sbs
    appendMessage({system:true, text:'Switched to Video Chat.'});
    setStatus('Chatting via video.');

    if (!isHost && currentSlot && peer && !mediaCall){
      try {
        mediaCall = peer.call(currentSlot, stream);
        wireMediaEvents(mediaCall);
      } catch {}
    }
  }

  // ---------- Send & Controls ----------
  composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = msgInput.value.trim();
    if(!text || !conn || !conn.open) return;
    const pkt = { type:'chat', text, ts: Date.now() };
    appendMessage({ text, from: 'you', ts: pkt.ts, mine: true });
    try { conn.send(JSON.stringify(pkt)); } catch {}
    msgInput.value = '';
  });

  // Next/Space rule: only force Message if this convo started as Message and later switched to Video
  function rematchRespectingStart(){
    const forceText = (mode === 'video' && switchedFromTextToVideo === true);
    rematch(forceText);
  }

  function rematch(forceText = false){
    cancelled = true;
    if (forceText){
      mode = 'text';
      localSwitchRequest = null;
      remoteSwitchRequest = null;
      switchedFromTextToVideo = false;
      updateModeUI();
    }
    resetAll();
    startMatching();
  }

  nextBtn.addEventListener('click', rematchRespectingStart);
  leaveBtn.addEventListener('click', () => {
    cancelled = true;
    resetAll();
    setStatus('You left the chat.');
  });

  document.addEventListener('keydown', (e) => {
    const isSpace = e.code === 'Space' || e.key === ' ';
    const typing = (e.target === msgInput) ||
                   (e.target instanceof HTMLTextAreaElement) ||
                   (e.target instanceof HTMLInputElement && (e.target.type === 'text' || e.target.type === 'search'));
    if (isSpace && !typing){
      e.preventDefault();
      rematchRespectingStart();
    }
  });

  // Location filter (keep optional)
  locFilter?.addEventListener('change', () => {
    filter = locFilter.value || 'all';
    rematch();
  });

  // Top toggle (Message ↔ Video)
  modeSwitch.addEventListener('change', () => {
    mode = modeSwitch.checked ? 'video' : 'text';
    updateModeUI();
    rematch();
  });

  // Clicking your own video toggles side-by-side ↔ PiP (CSS handles visuals)
  localVideo?.addEventListener('click', () => {
    if (mode !== 'video') return;
    setSBS(!videoArea.classList.contains('sbs'));
  });

  // ---------- Startup ----------
  document.addEventListener('DOMContentLoaded', () => {
    ensureSwitchUI();
    mode = 'text';               // default landing mode
    updateModeUI();
    setConnected(false);
    startMatching();
  });

  // Cleanup on unload
  window.addEventListener('beforeunload', () => {
    try {
      if (mediaCall) { try{ mediaCall.close(); }catch{} }
      if (conn)      { try { conn.close(); }      catch{} }
      if (peer)      { try { peer.destroy(); }    catch{} }
      stopStreams();
    } catch {}
  });
})();
