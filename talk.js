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

  // Matching tunables
  const MATCH_POLL_MS = 1200;   // how often to poll /match when waiting

  // ---- Dynamically add switch bars (no HTML edits needed) ----
  let videoSwitchBar, requestTextBtn;
  let textSwitchBar,  requestVideoBtn;

  function ensureSwitchUI(){
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
  let peer        = null;
  let conn        = null;
  let mediaCall   = null;
  let localStream = null;
  let remoteStream= null;

  let cancelled   = false;
  let filter      = 'all';
  let mode        = 'video'; // default to video

  // Keep track of who we're connected to (PeerJS id)
  let remotePeerId = null;

  // Consent-based switching
  let localSwitchRequest  = null;
  let remoteSwitchRequest = null;

  // For Next/Space behavior
  let conversationStartMode   = null;
  let switchedFromTextToVideo = false;

  // NEW: handshake + auto-next helpers
  let connectMode = null;
  let autoRematching = false;
  let endingVideoDueToSwitch = false;

  // PeerJS options
  const PEER_OPTS_BASE = {
    host: location.hostname,              // For packaged apps, hard-set to your domain
    secure: location.protocol === 'https:',
    path: '/peerjs',
    debug: 1,
    config: {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
      // TIP: add TURN here for mobile/cellular reliability
    }
  };
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

  function setSBS(on){
    videoArea?.classList.toggle('sbs', !!on);
  }

  function updateModeUI(){
    ensureSwitchUI();

    modeHeadingText.textContent = mode === 'video' ? 'Video Chat' : 'Message Chat';
    modeSwitch.checked = mode === 'video';

    if (videoArea)   videoArea.classList.toggle('hidden', mode !== 'video');
    if (messagesEl)  messagesEl.style.display = (mode === 'video') ? 'none' : '';
    if (composer)    composer.style.display   = (mode === 'video') ? 'none' : 'flex';

    if (videoSwitchBar) videoSwitchBar.classList.toggle('hidden', mode !== 'video');
    if (textSwitchBar)  textSwitchBar.classList.toggle('hidden', mode === 'video');

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

  function safeSend(obj){
    try { conn?.send(JSON.stringify(obj)); } catch {}
  }

  function autoNextAfterDisconnect(){
    if (autoRematching) return;
    autoRematching = true;
    setStatus('Partner left. Finding someone new…');
    rematch(/*forceText=*/false);
    setTimeout(() => { autoRematching = false; }, 1000);
  }

  // ---------- Small fetch helper ----------
  async function apiPost(path, body){
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify(body||{})
    });
    return res.json();
  }

  async function requestMatchLoop(){
    // Poll /match until we get a partnerId
    let partnerId = null;
    while (!cancelled && !partnerId){
      try{
        const resp = await apiPost('/match', { mode, filter, peerId: peer?.id });
        if (resp && resp.ok && resp.partnerId){
          partnerId = resp.partnerId;
          break;
        }
      }catch{}
      await new Promise(r => setTimeout(r, MATCH_POLL_MS));
    }
    return partnerId;
  }

  function resetAll(){
    try {
      if (mediaCall) { try { mediaCall.close(); } catch {} }
      if (conn)      { try { conn.close(); }      catch {} }
      if (peer)      { try { peer.destroy(); }    catch {} }
      stopStreams();
    } finally {
      mediaCall = null;
      conn = null; peer = null; cancelled = false;
      localSwitchRequest = null; remoteSwitchRequest = null;
      conversationStartMode = null; switchedFromTextToVideo = false;
      remotePeerId = null;
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

    if (mode === 'video'){
      const ok = await ensureLocalMedia();
      if (!ok){ mode = 'text'; updateModeUI(); }
    }

    // Create our PeerJS instance (random id)
    peer = makePeer(undefined);
    await new Promise(res => {
      let done = false;
      peer.on('open', () => { if(!done){ done=true; res(); } });
      peer.on('error', () => { if(!done){ done=true; res(); } });
    });
    if (cancelled) return;

    // Ready to answer media calls when in Video mode
    peer.on('call', async (call) => {
      if (mode !== 'video') { try{ call.close(); }catch{}; return; }
      const stream = await ensureLocalMedia();
      if (!stream) { try{ call.close(); }catch{}; return; }
      mediaCall = call;
      try { mediaCall.answer(stream); } catch {}
      wireMediaEvents(mediaCall);
    });

    // Also accept incoming data connections (race with our dial)
    peer.on('connection', (c) => {
      if (conn && conn.open) { try { c.close(); } catch {} return; }
      conn = c;
      remotePeerId = c.peer || remotePeerId;
      conn.on('open', () => {
        setConnected(true);
        setStatus('Matched!');
        connectMode = mode;
        try { conn.send(JSON.stringify({ type:'hello', mode: connectMode })); } catch {}
      });
      conn.on('data', onData);
      conn.on('close', () => {
        appendMessage({system:true, text:'Stranger disconnected.'});
        setConnected(false);
        clearVideoEls(); stopStreams();
        localSwitchRequest = null; remoteSwitchRequest = null;
        refreshConsentButtonLabels();
        autoNextAfterDisconnect();
      });
      conn.on('error', () => {});
    });

    // Ask the server to match us
    setStatus('Joining queue…');
    const partnerId = await requestMatchLoop();
    if (cancelled) return;
    if (!partnerId){
      appendMessage({system:true, text:'Could not find a partner right now.'});
      return;
    }

    // We will be the dialing side (if the other side hasn't dialed already)
    conversationStartMode = mode;
    setStatus('Matched!');
    setConnected(true);

    try {
      const c = peer.connect(partnerId, { reliable: true });
      conn = c;
      remotePeerId = partnerId;
      c.on('open', () => {
        connectMode = mode;
        safeSend({ type:'hello', mode: connectMode });
      });
      c.on('data', onData);
      c.on('close', () => {
        appendMessage({system:true, text:'Stranger disconnected.'});
        setConnected(false);
        clearVideoEls(); stopStreams();
        localSwitchRequest = null; remoteSwitchRequest = null;
        refreshConsentButtonLabels();
        autoNextAfterDisconnect();
      });
      c.on('error', () => {});
    } catch {}

    // Start video call if currently in video mode
    if (mode === 'video'){
      const stream = await ensureLocalMedia();
      if (stream && !mediaCall && remotePeerId){
        try { mediaCall = peer.call(remotePeerId, stream); wireMediaEvents(mediaCall); } catch {}
      }
    }
  }

  function wireMediaEvents(call){
    call.on('stream', (remote) => {
      remoteStream = remote;
      if (remoteVideo) remoteVideo.srcObject = remoteStream;
    });
    call.on('close', () => {
      remoteStream = null;
      if (remoteVideo) remoteVideo.srcObject = null;

      if (endingVideoDueToSwitch){
        endingVideoDueToSwitch = false;
        return;
      }
      appendMessage({system:true, text:'Video call ended.'});
      try { conn?.close(); } catch {}
      autoNextAfterDisconnect();
    });
    call.on('error', () => {
      appendMessage({system:true, text:'Video call error.'});
    });
  }

  // ---------- Data handling ----------
  function onData(raw){
    let msg; try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.type === 'hello'){
      // no mode enforcement needed; both sides can still switch via consent protocol
      return;
    }

    if (msg.type === 'mismatch'){
      appendMessage({system:true, text:'They are in a different mode. Continuing search…'});
      try { conn?.close(); } catch {}
      autoNextAfterDisconnect();
      return;
    }

    if (msg.type === 'chat'){
      appendMessage({text: msg.text, from: 'Stranger', ts: msg.ts});
      return;
    }
    if (msg.type === 'system'){
      appendMessage({system:true, text: msg.text});
      return;
    }

    // Consent switching
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
    // Preflight: get media to trigger permission now
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
      endingVideoDueToSwitch = !!mediaCall;
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

    if (peer && remotePeerId && !mediaCall){
      try {
        mediaCall = peer.call(remotePeerId, stream);
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
    // best-effort tell server we're leaving the queue
    try { apiPost('/leave', { mode, filter, peerId: peer?.id }).catch(()=>{}); } catch {}
    resetAll();
    startMatching();
  }

  nextBtn.addEventListener('click', rematchRespectingStart);
  leaveBtn.addEventListener('click', () => {
    cancelled = true;
    try { apiPost('/leave', { mode, filter, peerId: peer?.id }).catch(()=>{}); } catch {}
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

  // Location filter (optional)
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
    mode = 'video';            // start in video
    updateModeUI();
    setConnected(false);
    startMatching();
  });

  // Cleanup on unload
  window.addEventListener('beforeunload', () => {
    try {
      try { apiPost('/leave', { mode, filter, peerId: peer?.id }).catch(()=>{}); } catch {}
      if (mediaCall) { try{ mediaCall.close(); }catch{} }
      if (conn)      { try { conn.close(); }      catch{} }
      if (peer)      { try { peer.destroy(); }    catch{} }
      stopStreams();
    } catch {}
  });
})();
