// Observer console for the IoT-device → voice-gateway line.
//
// This page is NOT the device and NOT the gateway. It is an observer that:
//   1. connects to the voice gateway's WebSocket as role=observer (no ticket),
//      keyed by the same pairing code (deviceId) the device uses;
//   2. renders each signaling step the gateway reports (device online, ticket
//      verified, session started);
//   3. when the gateway pushes the Chime join info (only to this observer),
//      enables "join audio" — clicking it carries the real media (the device's
//      microphone/speaker) straight to Amazon Connect.
//
// Signaling comes over the WebSocket; the transcript reuses the same /transcript
// polling as the direct-call page (both sides from Connect's AI logs).

import { joinMeeting, startPhaseLoop } from './chime.js';

const $ = (id) => document.getElementById(id);
const connectBtn = $('connectBtn');
const joinBtn = $('joinBtn');
const stopBtn = $('stopBtn');
const wsStateEl = $('wsState');
const devStateEl = $('devState');
const phaseEl = $('phase');
const transcriptEl = $('transcript');
const logEl = $('log');
const pairIdEl = $('pairId');
const langSel = $('lang');

const DEVICE_ID = 'speaker-001'; // pairing code, matches the device + vgauth
pairIdEl.textContent = DEVICE_ID;

let ws = null;
let media = null; // { session, stop }
let stopPhase = null;
let micLevel = 0, spkLevel = 0;
let pendingConnectionData = null; // join info received before user clicked "join"
let transcriptTimer = null;
let callStartMs = 0;
const seenTurns = new Set();

function log(msg) {
  logEl.textContent += `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}
function setDot(el, cls) { el.className = 'dot' + (cls ? ' ' + cls : ''); }
function setPhase(p) {
  const labels = { idle: '', connecting: '⏳ 连接中…', listening: '🎙️ 正在听…', thinking: '💭 思考中…', speaking: '🔊 回答中…' };
  phaseEl.textContent = labels[p] || '';
  phaseEl.className = 'phase ' + p;
}
function markStep(step, done = true) {
  const li = document.querySelector(`#steps li[data-step="${step}"]`);
  if (li) li.classList.toggle('done', done);
}
function appendTurn(who, text) {
  const row = document.createElement('div');
  row.className = 'turn ' + (who === 'CUSTOMER' ? 'you' : 'bot');
  row.innerHTML = `<span class="who">${who === 'CUSTOMER' ? '设备' : 'AI'}</span><span class="txt"></span>`;
  row.querySelector('.txt').textContent = text;
  transcriptEl.appendChild(row);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

async function pollTranscript() {
  try {
    const res = await fetch('transcript?since=' + callStartMs);
    const data = await res.json();
    for (const turn of data.turns || []) {
      const key = turn.who + '|' + turn.t + '|' + turn.text;
      if (seenTurns.has(key)) continue;
      seenTurns.add(key);
      appendTurn(turn.who, turn.text);
    }
  } catch (_) { /* retry next tick */ }
}
function startTranscriptPolling() {
  callStartMs = Date.now() - 5000;
  seenTurns.clear();
  transcriptEl.innerHTML = '';
  pollTranscript();
  transcriptTimer = setInterval(pollTranscript, 1500);
}

async function getWsUrl() {
  const res = await fetch('gw-config');
  if (!res.ok) throw new Error(`gw-config HTTP ${res.status}`);
  const cfg = await res.json();
  if (!cfg.wsUrl) throw new Error('gateway not enabled (no wsUrl) — deploy with -c enableGateway=true');
  return cfg.wsUrl;
}

async function connectObserver() {
  connectBtn.disabled = true;
  setDot(wsStateEl, 'wait');
  log('fetching gateway endpoint…');
  let wsUrl;
  try {
    wsUrl = await getWsUrl();
  } catch (err) {
    log('ERROR: ' + err.message);
    setDot(wsStateEl, 'off');
    connectBtn.disabled = false;
    return;
  }

  const url = `${wsUrl}?deviceId=${encodeURIComponent(DEVICE_ID)}&role=observer`;
  log('connecting to voice gateway as observer…');
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setDot(wsStateEl, 'on');
    markStep('observer', true);
    log('observer connected. Asking gateway for device status…');
    stopBtn.disabled = false;
    // Can't be pushed from $connect, so we pull: ask for device presence + any
    // cached session now that the socket is ready.
    ws.send(JSON.stringify({ action: 'hello' }));
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch (_) { return; }
    handleGatewayMessage(msg);
  });

  ws.addEventListener('close', () => {
    setDot(wsStateEl, 'off');
    log('observer disconnected from gateway.');
  });
  ws.addEventListener('error', () => log('gateway WebSocket error.'));
}

function wake() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const language = langSel ? langSel.value : 'en_US';
    ws.send(JSON.stringify({ action: 'wake', language }));
    markStep('device-online', true);
  }
}

function handleGatewayMessage(msg) {
  switch (msg.type) {
    case 'hello':
      if (msg.deviceOnline) {
        setDot(devStateEl, 'on');
        markStep('device-online', true);
        // Device is online. Wake it to start a fresh session (unless a cached
        // session replay arrives right after this — handled in session-started).
        log('device online — waking it to start a session…');
        wake();
      } else {
        setDot(devStateEl, 'off');
        log('device is offline. Start the EC2 device (it should be running).');
      }
      break;
    case 'device-online':
      setDot(devStateEl, 'on');
      markStep('device-online', true);
      log('device came online.');
      if (msg.authSteps) msg.authSteps.forEach((s) => log('  · ' + s));
      markStep('auth', true);
      break;
    case 'device-offline':
      setDot(devStateEl, 'off');
      log('device went offline.');
      break;
    case 'auth-steps':
      (msg.steps || []).forEach((s) => log('  · ' + s));
      markStep('auth', true);
      break;
    case 'session-started':
      markStep('session', true);
      markStep('join', true);
      log(`gateway pushed Chime join info (contactId=${msg.contactId})${msg.replay ? ' [replay]' : ''}.`);
      pendingConnectionData = msg.connectionData;
      joinBtn.disabled = false;
      setPhase('connecting');
      break;
    case 'error':
      log('gateway error: ' + msg.error);
      break;
    default:
      log('gateway → ' + JSON.stringify(msg));
  }
}

async function joinAudio() {
  if (!pendingConnectionData) { log('no active session to join yet.'); return; }
  joinBtn.disabled = true;
  setPhase('connecting');
  log('joining Chime meeting (this browser is the device microphone)…');
  try {
    media = await joinMeeting(pendingConnectionData, {
      onMic: (v) => { micLevel = v; },
      onSpk: (v) => { spkLevel = v; },
      onLog: (m) => log(m),
    });
    markStep('media', true);
    stopPhase = startPhaseLoop(
      () => ({ mic: micLevel, spk: spkLevel, decay: () => { micLevel *= 0.8; spkLevel *= 0.8; } }),
      setPhase,
    );
    startTranscriptPolling();
    stopBtn.disabled = false;
  } catch (err) {
    log('ERROR joining audio: ' + err.message);
    setPhase('idle');
    joinBtn.disabled = false;
  }
}

function stopAll() {
  stopBtn.disabled = true;
  if (stopPhase) { stopPhase(); stopPhase = null; }
  if (transcriptTimer) { clearInterval(transcriptTimer); transcriptTimer = null; }
  if (media) { media.stop(); media = null; }
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  setPhase('idle');
  setDot(wsStateEl, '');
  setDot(devStateEl, '');
  joinBtn.disabled = true;
  connectBtn.disabled = false;
  pendingConnectionData = null;
  log('stopped.');
}

connectBtn.addEventListener('click', connectObserver);
joinBtn.addEventListener('click', joinAudio);
stopBtn.addEventListener('click', stopAll);
