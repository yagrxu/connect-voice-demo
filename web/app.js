// Amazon Chime SDK for JavaScript — imported as an ES module (esm.sh bundles
// the npm package for the browser; there is no official UMD/global build).
import {
  DefaultDeviceController,
  DefaultMeetingSession,
  MeetingSessionConfiguration,
  ConsoleLogger,
  LogLevel,
} from 'https://esm.sh/amazon-chime-sdk-js@3';

// Browser client for the Connect voice demo.
//
// Media path: click Start -> POST /webcall (backend calls StartWebRTCContact)
// -> join the returned meeting with the Amazon Chime SDK -> mic up, agentic
// voice down. Connect only gives us a "dumb" audio stream — it does NOT push
// "user finished / AI thinking / AI speaking" events. So we INFER conversation
// state from audio levels (mic vs speaker) and render it as Listening /
// Thinking / Speaking. We also speak a local greeting the instant the call
// connects, to cover the ~3-4s Connect/Lex/agentic-voice cold start.

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const dot = document.getElementById('dot');
const stateText = document.getElementById('stateText');
const phase = document.getElementById('phase');
const transcriptEl = document.getElementById('transcript');
const logEl = document.getElementById('log');

let meetingSession = null;
let audioEl = null;
let micLevel = 0; // local attendee volume (user), 0..1 from Chime
let spkLevel = 0; // remote attendee volume (agent/Matthew), 0..1 from Chime
let transcriptTimer = null; // polls /transcript (both sides, from Connect logs)
let callStartMs = 0;
const seenTurns = new Set(); // de-dupe turns across polls
let rafId = null;

function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setState(state) {
  dot.className = 'dot' + (state === 'idle' ? '' : ' ' + state);
  stateText.textContent = state;
}

// Conversation phase shown to the user (inferred from audio levels).
function setPhase(p) {
  if (!phase) return;
  const labels = {
    idle: '',
    connecting: '⏳ Connecting… please wait',
    listening: '🎙️ Listening…',
    thinking: '💭 Thinking…',
    speaking: '🔊 Answering…',
  };
  phase.textContent = labels[p] || '';
  phase.className = 'phase ' + p;
}

// --- Transcript (both sides pulled from Connect's AI-agent logs) -----------
// We do NOT do local browser speech recognition: to judge answer accuracy the
// transcript must reflect what Connect actually heard (CUSTOMER) and said
// (BOT), so both come from the same log source via /transcript. CloudWatch
// ingestion lags a few seconds, so this trails the live audio slightly.

function appendTurn(who, text) {
  const row = document.createElement('div');
  const cls = who === 'CUSTOMER' ? 'you' : 'bot';
  row.className = 'turn ' + cls;
  const label = who === 'CUSTOMER' ? 'You' : 'Assistant';
  row.innerHTML = `<span class="who">${label}</span><span class="txt"></span>`;
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
  } catch (_) {
    /* transient; next poll retries */
  }
}

function startTranscriptPolling() {
  callStartMs = Date.now() - 5000; // small backdate to catch the first turn
  seenTurns.clear();
  transcriptEl.innerHTML = '';
  pollTranscript();
  transcriptTimer = setInterval(pollTranscript, 1500);
}

// Infer conversation phase from Chime volume levels (micLevel/spkLevel, 0..1,
// updated by the volume-indicator callbacks). Chime only fires callbacks on
// change, so we decay the levels each tick to avoid a stale value sticking.
function startPhaseLoop() {
  const SPEAK_TH = 0.03; // agent (remote) volume => AI talking
  const MIC_ON = 0.06; // local volume to count as the user speaking
  const MIC_OFF = 0.03; // ...and to count as stopped (hysteresis)
  const THINK_WINDOW = 8000; // ms after user stops before we stop showing "thinking"

  let micActive = false;
  let userHasSpoken = false;
  let lastMicActive = 0;
  let firstAudioHeard = false; // Matthew's greeting = connection is truly ready

  const tick = () => {
    const now = performance.now();
    const mic = micLevel;
    const spk = spkLevel;
    // Decay so a level that stopped updating falls back to ~0 quickly.
    micLevel *= 0.8;
    spkLevel *= 0.8;

    if (!micActive && mic > MIC_ON) micActive = true;
    else if (micActive && mic < MIC_OFF) micActive = false;
    if (micActive) {
      userHasSpoken = true;
      lastMicActive = now;
    }

    if (spk > SPEAK_TH) firstAudioHeard = true;

    // Until we first hear the agent (Matthew's greeting), the Connect session
    // is still spinning up (~3-4s cold start) -> show a Connecting/loading state.
    if (!firstAudioHeard) {
      setPhase('connecting');
    } else if (spk > SPEAK_TH) {
      setPhase('speaking'); // AI is talking
    } else if (micActive) {
      setPhase('listening'); // user is talking
    } else if (userHasSpoken && now - lastMicActive < THINK_WINDOW) {
      setPhase('thinking'); // user just stopped, AI hasn't started -> thinking
    } else {
      setPhase('listening'); // waiting for the user
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

async function start() {
  startBtn.disabled = true;
  setState('connecting');
  setPhase('connecting');
  log('Requesting web call from backend...');

  let data;
  try {
    const langSel = document.getElementById('lang');
    const language = langSel ? langSel.value : 'en_US';
    if (langSel) langSel.disabled = true;
    const res = await fetch('webcall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language }),
    });
    data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  } catch (err) {
    log('ERROR: ' + err.message);
    setState('error');
    startBtn.disabled = false;
    return;
  }

  log('Contact created: ' + data.contactId);

  const connectionData =
    typeof data.connectionData === 'string'
      ? JSON.parse(data.connectionData)
      : data.connectionData;
  const meeting = connectionData.Meeting || connectionData.meeting;
  const attendee = connectionData.Attendee || connectionData.attendee;

  try {
    const logger = new ConsoleLogger('ChimeSDK', LogLevel.WARN);
    const deviceController = new DefaultDeviceController(logger);
    const configuration = new MeetingSessionConfiguration(meeting, attendee);
    meetingSession = new DefaultMeetingSession(configuration, logger, deviceController);

    const mics = await meetingSession.audioVideo.listAudioInputDevices();
    if (!mics.length) throw new Error('No microphone found');
    await meetingSession.audioVideo.startAudioInput(mics[0].deviceId);

    audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    document.body.appendChild(audioEl);
    await meetingSession.audioVideo.bindAudioElement(audioEl);

    meetingSession.audioVideo.start();
    setState('active');
    stopBtn.disabled = false;
    log('Connected. Waiting for the assistant to greet you…');
    setPhase('connecting'); // held until Matthew's greeting is first heard

    // Phase indicator via Chime's realtime volume indicator (reliable — reading
    // the Chime-owned <audio> element with Web Audio does NOT work). The local
    // attendee's volume = user talking; any remote attendee's volume = the
    // agent (Matthew) talking.
    try {
      const localAttendeeId = configuration.credentials.attendeeId;
      const av = meetingSession.audioVideo;
      av.realtimeSubscribeToAttendeeIdPresence((attendeeId, present) => {
        if (attendeeId === localAttendeeId) return;
        if (present) {
          av.realtimeSubscribeToVolumeIndicator(attendeeId, (id, volume) => {
            spkLevel = volume || 0; // agent (remote) volume
          });
        }
      });
      av.realtimeSubscribeToVolumeIndicator(localAttendeeId, (id, volume) => {
        micLevel = volume || 0; // user (local) volume
      });
      startPhaseLoop();
    } catch (e) {
      log('Phase indicator unavailable: ' + e.message);
    }

    // Start pulling the live transcript (both sides) from the AI-agent logs.
    startTranscriptPolling();
  } catch (err) {
    log('ERROR joining call: ' + err.message);
    setState('error');
    startBtn.disabled = false;
  }
}

async function stop() {
  stopBtn.disabled = true;
  log('Stopping...');
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  if (transcriptTimer) clearInterval(transcriptTimer);
  transcriptTimer = null;
  try {
    if (meetingSession) {
      await meetingSession.audioVideo.stopAudioInput();
      meetingSession.audioVideo.stop();
      meetingSession = null;
    }
    if (audioEl) {
      audioEl.remove();
      audioEl = null;
    }
  } catch (err) {
    log('Cleanup warning: ' + err.message);
  }
  setState('idle');
  setPhase('idle');
  startBtn.disabled = false;
  const langSel = document.getElementById('lang');
  if (langSel) langSel.disabled = false;
  log('Call ended.');
}

startBtn.addEventListener('click', start);
stopBtn.addEventListener('click', stop);
