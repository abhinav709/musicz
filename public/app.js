// Live Audio Share client.
// One page serves both roles. Host capture uses getDisplayMedia (never the microphone).
// Signaling runs over a WebSocket. Media flows peer to peer over WebRTC.

const $ = (id) => document.getElementById(id);
const els = {
  conn: $('conn'),
  listenBtn: $('listen-btn'), unlistenBtn: $('unlisten-btn'),
  listenStatus: $('listen-status'), remote: $('remote'),
  startBtn: $('start-btn'), stopBtn: $('stop-btn'),
  hostStatus: $('host-status'), hostMsg: $('host-msg'), hostCount: $('host-count'),
};

const RTC_CONFIG = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  // Add a TURN server here for listeners behind strict NATs or firewalls.
};
const MAX_AUDIO_BITRATE = 96_000; // bits per second, per listener

const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

let ws = null;
let reconnectTimer = null;
let wantListen = false;        // user asked to listen; survives reconnects
let hostStream = null;         // audio-only MediaStream while sharing
let hostLive = false;          // server confirmed we are the active host
let hostPending = false;       // claim sent, waiting for server answer
let listenerPc = null;         // RTCPeerConnection to the host (listener side)
let listenerPending = [];      // ICE candidates that arrived before the offer
const hostPeers = new Map();   // listener id -> RTCPeerConnection (host side)
let listenerId = null;

// ---------- transport ----------
function connect() {
  ws = new WebSocket(wsUrl);
  ws.onopen = () => {
    setConn('ok', 'Connected');
    if (wantListen) send({ type: 'subscribe' });
  };
  ws.onmessage = (e) => handleServerMessage(JSON.parse(e.data));
  ws.onclose = () => {
    setConn('bad', 'Disconnected, retrying…');
    if (hostLive || hostPending) stopSharing('Connection to the server was lost, so sharing stopped.');
    closeListenerPc();
    if (wantListen) setListenStatus('Connection lost. Reconnecting…');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };
  ws.onerror = () => ws.close();
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'subscribed':
      listenerId = msg.id;
      setListenStatus(msg.hostOnline ? 'Host is live. Connecting…' : 'Waiting for the host to start sharing…');
      break;
    case 'host-online':
      if (wantListen) setListenStatus('Host is live. Connecting…');
      break;
    case 'host-offline':
      closeListenerPc();
      if (wantListen) setListenStatus('The host stopped sharing. Waiting for them to return…');
      break;
    case 'signal':
      if (hostPeers.has(msg.from)) handleHostSignal(msg.from, msg.data);
      else handleListenerSignal(msg.from, msg.data);
      break;
    case 'host-ok':
      hostPending = false;
      hostLive = true;
      updateHostUi();
      break;
    case 'host-busy':
      hostPending = false;
      releaseStream();
      updateHostUi();
      showHostMessage('Someone else is already hosting. Only one host can share at a time. Try again when they stop.');
      break;
    case 'listener-joined':
      if (hostLive) createHostPeer(msg.id);
      break;
    case 'listener-left':
      closeHostPeer(msg.id);
      updateHostUi();
      break;
  }
}

// ---------- listener ----------
function startListening() {
  if (hostLive || hostPending) return;  // hosting and listening on one device would echo
  wantListen = true;
  els.listenBtn.hidden = true;
  els.unlistenBtn.hidden = false;
  els.remote.hidden = false;
  // Playing inside the click gesture unlocks autoplay on strict browsers.
  els.remote.play().catch(() => {});
  setListenStatus('Joining…');
  send({ type: 'subscribe' });
}

function stopListening() {
  wantListen = false;
  closeListenerPc();
  send({ type: 'unsubscribe' });
  els.listenBtn.hidden = false;
  els.unlistenBtn.hidden = true;
  els.remote.hidden = true;
  setListenStatus('Not listening.');
}

function setListenStatus(text) { els.listenStatus.textContent = text; }

function closeListenerPc() {
  if (listenerPc) { listenerPc.close(); listenerPc = null; }
  listenerPending = [];
  els.remote.srcObject = null;
}

async function handleListenerSignal(from, data) {
  // Listener receives an offer and ICE candidates from the host.
  if (data.description?.type === 'offer') {
    closeListenerPc();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    listenerPc = pc;
    pc.ontrack = (e) => {
      els.remote.srcObject = e.streams[0] || new MediaStream([e.track]);
      els.remote.play().catch(() => setListenStatus('Live. Press play on the audio controls to start.'));
      setListenStatus('Live. Listening now.');
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) send({ type: 'signal', to: from, data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        setListenStatus('Could not connect to the host. A network restriction may be blocking audio. Try again.');
      }
    };
    await pc.setRemoteDescription(data.description);
    await flushCandidates(pc, listenerPending);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'signal', to: from, data: { description: pc.localDescription } });
    return;
  }
  if (data.candidate && listenerPc) {
    addCandidate(listenerPc, data.candidate, listenerPending);
  }
}

// ---------- host ----------
function capabilityProblem() {
  if (!window.isSecureContext) {
    return 'Sharing needs a secure connection. Open this page over HTTPS, or use http://localhost during development.';
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return 'This browser cannot share tab or screen audio. Use a desktop Chromium browser such as Chrome or Edge.';
  }
  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    return 'Phones and tablets cannot share tab or screen audio. You can still listen here. To host, use a desktop Chrome or Edge.';
  }
  return null;
}

async function startSharing() {
  const problem = capabilityProblem();
  if (problem) return showHostMessage(problem);
  if (hostLive || hostPending) return;

  let stream;
  try {
    // Must be the first await so the browser still treats this as a user gesture.
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    return showHostMessage(explainCaptureError(err));
  }

  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    return showHostMessage(noAudioMessage());
  }

  // Video was only needed to open the picker. Drop it to save CPU and bandwidth.
  stream.getVideoTracks().forEach((t) => t.stop());
  hostStream = new MediaStream(audioTracks);
  // The browser's own "Stop sharing" control ends the audio track.
  audioTracks[0].addEventListener('ended', () => stopSharing('Sharing ended from the browser controls.'));

  if (wantListen) stopListening();  // never listen and host on one device
  hostPending = true;
  hostMsgClear();
  updateHostUi();
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    stopSharing('Not connected to the server. Wait for the connection, then try again.');
    return;
  }
  send({ type: 'host-claim' });
}

function stopSharing(reason) {
  const wasActive = hostLive || hostPending;
  for (const id of [...hostPeers.keys()]) closeHostPeer(id);
  releaseStream();
  if (wasActive) send({ type: 'host-stop' });
  hostLive = false;
  hostPending = false;
  updateHostUi();
  if (reason) showHostMessage(reason);
}

function releaseStream() {
  if (hostStream) hostStream.getTracks().forEach((t) => t.stop());
  hostStream = null;
}

async function createHostPeer(listenerIdForPeer) {
  if (!hostStream) return;
  closeHostPeer(listenerIdForPeer);
  const pc = new RTCPeerConnection(RTC_CONFIG);
  hostPeers.set(listenerIdForPeer, pc);
  pc._pending = [];

  hostStream.getAudioTracks().forEach((t) => pc.addTrack(t, hostStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: 'signal', to: listenerIdForPeer, data: { candidate: e.candidate } });
  };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) closeHostPeer(listenerIdForPeer);
    updateHostUi();
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  capBitrate(pc);
  send({ type: 'signal', to: listenerIdForPeer, data: { description: pc.localDescription } });
  updateHostUi();
}

function closeHostPeer(id) {
  const pc = hostPeers.get(id);
  if (pc) { pc.close(); hostPeers.delete(id); }
}

function capBitrate(pc) {
  const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = MAX_AUDIO_BITRATE;
    sender.setParameters(params).catch(() => {});
  } catch { /* optional tuning, safe to skip */ }
}

async function handleHostSignal(from, data) {
  const pc = hostPeers.get(from);
  if (!pc) return;
  if (data.description?.type === 'answer') {
    await pc.setRemoteDescription(data.description);
    await flushCandidates(pc, pc._pending);
  } else if (data.candidate) {
    addCandidate(pc, data.candidate, pc._pending);
  }
}

// ---------- ICE helpers ----------
function addCandidate(pc, candidate, queue) {
  if (pc.remoteDescription) {
    pc.addIceCandidate(candidate).catch(() => {});
  } else {
    queue.push(candidate);
  }
}

async function flushCandidates(pc, queue) {
  while (queue.length) {
    const c = queue.shift();
    await pc.addIceCandidate(c).catch(() => {});
  }
}

// ---------- UI ----------
function setConn(kind, text) {
  els.conn.className = `pill pill-${kind === 'ok' ? 'ok' : kind === 'bad' ? 'bad' : 'muted'}`;
  els.conn.textContent = text;
}

function updateHostUi() {
  const live = hostLive;
  const starting = hostPending;
  const busy = live || starting;
  els.startBtn.hidden = busy;
  els.stopBtn.hidden = !busy;
  els.listenBtn.disabled = busy;
  if (live) {
    const n = hostPeers.size;
    els.hostStatus.textContent = `Live. Sharing audio with ${n} listener${n === 1 ? '' : 's'}.`;
    els.hostCount.textContent = 'Keep this tab open while sharing. Closing the tab or stopping in the browser ends the share.';
  } else if (starting) {
    els.hostStatus.textContent = 'Starting…';
    els.hostCount.textContent = '';
  } else {
    els.hostStatus.textContent = 'Not sharing.';
    els.hostCount.textContent = '';
  }
}

function showHostMessage(text) {
  els.hostMsg.textContent = text;
  els.hostMsg.hidden = false;
}
function hostMsgClear() {
  els.hostMsg.textContent = '';
  els.hostMsg.hidden = true;
}

function explainCaptureError(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Screen or tab sharing was blocked or cancelled. Click Start sharing again and pick a tab, window, or screen.';
    case 'NotFoundError':
      return 'No shareable tab, window, or screen was found.';
    case 'NotSupportedError':
      return 'This browser or page does not allow screen capture. Check that the page uses HTTPS.';
    case 'AbortError':
      return 'Sharing was cancelled before it started.';
    default:
      return `Could not start sharing (${err?.message || err?.name || 'unknown error'}).`;
  }
}

function noAudioMessage() {
  const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
  const isFirefox = /Firefox/i.test(navigator.userAgent);
  const isSafari = /Safari/i.test(navigator.userAgent) && !/Chrome|Chromium|Edg/i.test(navigator.userAgent);
  const lines = ['No audio was shared. In the browser picker, tick the audio option before you confirm:'];
  if (isFirefox || isSafari) {
    lines.push('This browser has limited support for capturing audio from a tab or screen. Use Chrome or Edge on desktop.');
  } else {
    lines.push('• Chrome or Edge, Chrome tab: pick the tab and tick "Share tab audio".');
    lines.push('• Windows: pick "Entire screen" and tick "Share system audio".');
    if (isMac) lines.push('• macOS: tab audio is the reliable option. System-wide audio capture is limited and depends on your Chrome version.');
  }
  return lines.join('\n');
}

updateHostUi();
connect();
els.listenBtn.addEventListener('click', startListening);
els.unlistenBtn.addEventListener('click', stopListening);
els.startBtn.addEventListener('click', startSharing);
els.stopBtn.addEventListener('click', () => stopSharing('Sharing stopped.'));
window.addEventListener('pagehide', () => { if (hostLive || hostPending) send({ type: 'host-stop' }); });
