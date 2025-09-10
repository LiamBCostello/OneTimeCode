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

    // IMPORTANT: Prompt for camera/mic immediately in Video mode (restores permission dialog + local preview)
    if (mode === 'video'){
      const ok = await ensureLocalMedia();
      if (!ok){
        // fall back to text immediately
        mode = 'text';
        updateModeUI();
      }
    }

    // Create peer
    peer = makePeer(undefined);

    await new Promise(res => {
      let done = false;
      peer.on('open', () => { if(!done){ done=true; res(); } });
      peer.on('error', () => { if(!done){ done=true; res(); } });
    });
    if (cancelled) return;

    // Prepare to answer media calls when in Video mode
    peer.on('call', async (call) => {
      if (mode !== 'video') { try{ call.close(); }catch{}; return; }
      const stream = await ensureLocalMedia();
      if (!stream) { try{ call.close(); }catch{}; return; }
      mediaCall = call;
      try { mediaCall.answer(stream); } catch {}
      wireMediaEvents(mediaCall);
    });

    // Phase 1 — try connecting to an existing host
    const order = shuffle(slotIdsForFilter(filter));
    for (const slot of order){
      if (cancelled) return;
      setStatus(`Checking slot ${slot.split('-').pop()}…`);
      const attempt = await tryConnectToHost(slot, 420);
      if (attempt === 'connected'){
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
    }

    // Phase 2 — become host
    if (cancelled) return;
    const hostSlot = order[0];
    const ok = await tryBecomeHost(hostSlot);
    if (!ok){
      const fallback = await tryConnectToHost(hostSlot, 800);
      if (fallback === 'connected'){
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
      return startMatching();
    }

    setStatus('Waiting for a partner…');
    appendMessage({system:true, text:'You are now connected once someone joins.'});
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

  function tryConnectToHost(slotId, ms){
    return new Promise(resolve => {
      if(!peer || peer.destroyed) return resolve('failed');
      let resolved = false;
      const c = peer.connect(slotId, { reliable: true });

      const done = (result) => { if(resolved) return; resolved = true; resolve(result); };
      const timer = setTimeout(() => { try{ c.close(); }catch{}; done('timeout'); }, ms);

      c.on('open', () => {
        clearTimeout(timer);
        conn = c;
        isHost = false;
        currentSlot = slotId;

        // Record how this conversation started (message vs video)
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

      c.on('error', () => { /* timer resolves */ });
    });
  }

  function tryBecomeHost(slotId){
    return new Promise(resolve => {
      try{ peer && peer.destroy(); }catch{}
      isHost = true;
      currentSlot = slotId;
      peer = makePeer(slotId);
      let resolved = false;
      const done = (ok) => { if(resolved) return; resolved = true; resolve(ok); };

      peer.on('open', () => {
        peer.on('connection', (c) => {
          if(conn && conn.open){ try{ c.close(); }catch{}; return; }
          conn = c;
          conn.on('open', () => {
            setConnected(true);
            setStatus('Matched!');
            appendMessage({system:true, text:'Partner joined.'});

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
