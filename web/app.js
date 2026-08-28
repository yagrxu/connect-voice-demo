// Amazon Chime SDK for JavaScript — imported as an ES module (esm.sh bundles
// the npm package for the browser; there is no official UMD/global build).
import {
  DefaultDeviceController,
  DefaultMeetingSession,
  MeetingSessionConfiguration,
  ConsoleLogger,
  LogLevel,
} from 'https://esm.sh/amazon-chime-sdk-js@3';
import { StreamingSession } from './stream.js';

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
const latencyEl = document.getElementById('latency'); // per-turn stage-latency panel

let meetingSession = null;
let audioEl = null;
let spkLevel = 0; // remote attendee volume (agent/Matthew), 0..1 from Chime
let transcriptTimer = null; // polls /transcript (both sides, from Connect logs)
let callStartMs = 0;
const seenTurns = new Set(); // de-dupe turns across polls
let rafId = null;

// Web Audio mic VAD — Chime's LOCAL volume indicator does not fire reliably, so
// we analyse the mic stream ourselves to detect when the user speaks/stops.
let micAudioCtx = null, micAnalyser = null, micVadStream = null;

function log(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setState(state) {
  dot.className = 'dot' + (state === 'idle' ? '' : ' ' + state);
  stateText.textContent = state;
}

// --- Per-turn stage latency: ASR (≈) / LLM (precise) / TTS (≈) --------------
// In Connect agentic voice, ASR/LLM/TTS run in a managed black box (docs/
// latency.md). We reconstruct an approximate split, ignoring transmission:
//   ASR ≈ CUSTOMER log timestamp (server)  −  user-stopped-speaking (client)
//   LLM  =  BOT log timestamp  −  CUSTOMER log timestamp        (both server → precise)
//   TTS ≈ first AI audio (client)  −  BOT log timestamp (server)
// Client (Date.now) and server (log event_timestamp) clocks are assumed NTP-
// aligned; ASR/TTS therefore carry ±100–200 ms clock skew and are marked "≈".
const LAT_DEBUG = false; // set true to print audio levels + turn boundaries to the on-screen log
const stageTurns = []; // {asr, llm, tts} per matched turn (ms; asr/tts may be null)
const clientTurns = []; // {stopMs, audioMs, used} captured from mic/agent audio edges
let pendingCustomerMs = null; // ts of the last CUSTOMER turn awaiting a BOT reply

// Normalize a log timestamp to epoch-ms (Connect may emit seconds or ms).
function toMs(t) {
  const n = Number(t);
  if (!isFinite(n) || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

// Match a server turn (by CUSTOMER timestamp) to the client-detected turn whose
// user-stop moment is closest. Proximity match tolerates a missed detection
// better than index alignment. Returns the client turn or null.
function matchClientTurn(customerTs) {
  let best = null, bestDiff = Infinity;
  for (const c of clientTurns) {
    if (c.used) continue;
    const d = Math.abs(c.stopMs - customerTs);
    if (d < bestDiff) { bestDiff = d; best = c; }
  }
  if (best && bestDiff < 8000) { best.used = true; return best; }
  return null;
}

function median(key) {
  const xs = stageTurns.map((s) => s[key]).filter((v) => v != null).sort((a, b) => a - b);
  return xs.length ? xs[Math.floor(xs.length / 2)] + ' ms' : '—';
}

// A "turn" carries either a 3-stage split (Connect / Transcribe) or an
// end-to-end-only number (Nova Sonic, which can't be sliced). `e2e` is the
// headline TOTAL — the backend measures it from END OF SPEECH (not speech
// onset) so a long utterance doesn't inflate it.
function recordStage(asr, llm, tts, e2e) {
  asr = asr != null && asr >= 0 ? Math.round(asr) : null;
  tts = tts != null && tts >= 0 ? Math.round(tts) : null;
  llm = llm != null && llm >= 0 ? Math.round(llm) : null;
  e2e = e2e != null && e2e >= 0 ? Math.round(e2e) : null;
  stageTurns.push({ asr, llm, tts, e2e });
  renderStages();
  if (asr == null && llm == null && tts == null) log(`[lat] turn: 端到端总延迟 ${e2e ?? '?'}ms`);
  else log(`[lat] turn: ASR ${asr ?? '?'}ms  LLM ${llm ?? '?'}ms  TTS ${tts ?? '?'}ms  总 ${e2e ?? '?'}ms`);
}

function renderStages() {
  const last = stageTurns[stageTurns.length - 1];
  if (!last || !latencyEl) return;
  latencyEl.style.display = 'flex';
  const { asr, llm, tts, e2e } = last;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const hasStages = asr != null || llm != null || tts != null;
  // Prefer the backend's end-to-end total; fall back to summing the stages.
  const total = e2e != null ? e2e : (asr || 0) + (llm || 0) + (tts || 0);
  document.getElementById('sgTotal').innerHTML = total + '<span class="lat-unit">ms</span>';

  const bar = document.getElementById('stageBar');
  if (bar) bar.innerHTML = '';
  if (hasStages) {
    set('sgAsr', asr != null ? asr + 'ms' : '?');
    set('sgLlm', llm != null ? llm + 'ms' : '?');
    set('sgTts', tts != null ? tts + 'ms' : '?');
    const barTotal = (asr || 0) + (llm || 0) + (tts || 0) || 1;
    if (bar) {
      for (const [cls, v] of [['asr', asr], ['llm', llm], ['tts', tts]]) {
        if (!v) continue;
        const d = document.createElement('div');
        d.className = 'seg ' + cls;
        d.style.width = (v / barTotal) * 100 + '%';
        d.title = cls.toUpperCase() + ' ' + v + 'ms';
        if (v / barTotal > 0.14) d.textContent = v + 'ms';
        bar.appendChild(d);
      }
    }
    set('sgAsrP', median('asr'));
    set('sgLlmP', median('llm'));
    set('sgTtsP', median('tts'));
  } else {
    // Nova Sonic — one indivisible end-to-end segment.
    set('sgLlm', total + 'ms');
    if (bar) {
      const d = document.createElement('div');
      d.className = 'seg llm';
      d.style.width = '100%';
      d.textContent = '端到端 ' + total + 'ms';
      bar.appendChild(d);
    }
    set('sgLlmP', median('e2e'));
  }
  set('sgN', String(stageTurns.length));
}

// Reshape the panel's legend + median row for the active pipeline. Nova Sonic
// is end-to-end (no ASR/LLM/TTS split), so it shows a single total instead.
function setLatencyMode(pipeline) {
  const nova = pipeline === 'nova-sonic';
  const title = document.getElementById('latTitle');
  const sub = document.getElementById('latSub');
  const legend = document.getElementById('stageLegend');
  const stats = document.getElementById('latStats');
  if (title) title.textContent = nova ? '端到端延迟' : '回合分段延迟';
  if (sub) {
    sub.textContent = nova
      ? '端到端语音 · 无法切分单段，仅显示总延迟（从"说完话"到首个回复音频）'
      : (pipeline === 'transcribe'
          ? 'ASR / LLM / TTS · 后端精确计时，从"说完话"开始（不含说话时长）'
          : 'ASR / LLM / TTS · LLM 精确，ASR·TTS 为≈估算(音频边界−日志时间戳)，滞后数秒');
  }
  if (legend) {
    legend.innerHTML = nova
      ? '<span class="lg llm">端到端总延迟 <b id="sgLlm">—</b></span>'
      : '<span class="lg asr">ASR <b id="sgAsr">—</b></span>'
        + '<span class="lg llm">LLM <b id="sgLlm">—</b></span>'
        + '<span class="lg tts">TTS <b id="sgTts">—</b></span>';
  }
  if (stats) {
    stats.innerHTML = (nova
      ? '<span>中位总延迟 <b id="sgLlmP">—</b></span>'
      : '<span>中位 ASR <b id="sgAsrP">—</b></span>'
        + '<span>LLM <b id="sgLlmP">—</b></span>'
        + '<span>TTS <b id="sgTtsP">—</b></span>')
      + '<span>回合 <b id="sgN">0</b></span>';
  }
}

function resetStages() {
  stageTurns.length = 0;
  clientTurns.length = 0;
  if (latencyEl) latencyEl.style.display = 'flex';
  const bar = document.getElementById('stageBar');
  if (bar) bar.innerHTML = '';
  const total = document.getElementById('sgTotal');
  if (total) total.innerHTML = '—<span class="lat-unit">ms</span>';
  for (const id of ['sgAsr', 'sgLlm', 'sgTts', 'sgAsrP', 'sgLlmP', 'sgTtsP']) {
    const el = document.getElementById(id); if (el) el.textContent = '—';
  }
  const n = document.getElementById('sgN'); if (n) n.textContent = '0';
}

// --- Mic VAD via Web Audio (reliable local speech detection) ---------------
async function startMicVad() {
  try {
    micVadStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (micAudioCtx.state === 'suspended') await micAudioCtx.resume();
    const src = micAudioCtx.createMediaStreamSource(micVadStream);
    micAnalyser = micAudioCtx.createAnalyser();
    micAnalyser.fftSize = 512;
    src.connect(micAnalyser);
    log('Mic VAD (Web Audio) started');
  } catch (e) {
    log('Mic VAD unavailable: ' + e.message);
  }
}

function micRms() {
  if (!micAnalyser) return 0;
  const buf = new Uint8Array(micAnalyser.fftSize);
  micAnalyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / buf.length); // ~0 (silence) .. ~0.3+ (speaking)
}

function stopMicVad() {
  try { if (micVadStream) micVadStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { if (micAudioCtx) micAudioCtx.close(); } catch (_) {}
  micVadStream = null; micAudioCtx = null; micAnalyser = null;
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

      // Stage split. CUSTOMER/BOT log timestamps give LLM precisely; the matched
      // client turn gives ASR (before CUSTOMER) and TTS (after BOT) approximately.
      const tMs = toMs(turn.t);
      if (turn.who === 'CUSTOMER') {
        pendingCustomerMs = tMs;
      } else if (turn.who === 'BOT' && pendingCustomerMs != null && tMs != null) {
        const customerTs = pendingCustomerMs, botTs = tMs;
        const llm = botTs - customerTs;
        if (llm >= 0 && llm < 120000) {
          const ct = matchClientTurn(customerTs);
          const asr = ct ? customerTs - ct.stopMs : null;
          const tts = ct ? ct.audioMs - botTs : null;
          recordStage(asr, llm, tts);
        }
        pendingCustomerMs = null; // only the first BOT reply counts
      }
    }
  } catch (_) {
    /* transient; next poll retries */
  }
}

function startTranscriptPolling() {
  callStartMs = Date.now() - 5000; // small backdate to catch the first turn
  seenTurns.clear();
  pendingCustomerMs = null;
  resetStages();
  transcriptEl.innerHTML = '';
  pollTranscript();
  transcriptTimer = setInterval(pollTranscript, 1500);
}

// Infer conversation phase and capture per-turn boundaries. User speech comes
// from the Web Audio mic analyser (micRms); the agent's audio comes from Chime's
// remote volume indicator (spkLevel, decayed each tick since it fires on change).
function startPhaseLoop() {
  const SPEAK_TH = 0.03; // agent (remote, Chime) volume => AI talking
  const MIC_ON = 0.04; // mic RMS (Web Audio) to count as the user speaking
  const MIC_OFF = 0.02; // ...and to count as stopped (hysteresis)
  const THINK_WINDOW = 8000; // ms after user stops before we stop showing "thinking"

  let micActive = false;
  let userHasSpoken = false;
  let lastMicActive = 0; // performance.now() of last mic activity (for phase display)
  let lastMicStopMs = 0; // Date.now() when the user last stopped speaking (for ASR≈)
  let firstAudioHeard = false; // Matthew's greeting = connection is truly ready
  let agentSpeaking = false; // tracks speaking onset (edge, not level)
  let turnOpen = false; // user has spoken and is awaiting the AI's reply
  let dbgMicPeak = 0, dbgSpkPeak = 0, dbgLastLog = 0;

  const tick = () => {
    const now = performance.now();
    const mic = micRms(); // live from Web Audio analyser (not Chime)
    const spk = spkLevel;
    spkLevel *= 0.8; // decay Chime's remote level (fires only on change)

    if (mic > dbgMicPeak) dbgMicPeak = mic;
    if (spk > dbgSpkPeak) dbgSpkPeak = spk;

    const wasMicActive = micActive;
    if (!micActive && mic > MIC_ON) micActive = true;
    else if (micActive && mic < MIC_OFF) micActive = false;
    if (wasMicActive && !micActive) lastMicStopMs = Date.now(); // user just stopped
    if (micActive) {
      userHasSpoken = true;
      lastMicActive = now;
      turnOpen = true; // user is talking -> a reply is owed
    }

    // Agent speaking onset (rising edge). If the user had an open turn, capture
    // the client-side boundaries of this turn: when the user stopped, and when
    // the AI's audio began. These bracket the server-side transcript timestamps
    // so we can back out ASR (before CUSTOMER ts) and TTS (after BOT ts). Skip
    // the opening greeting: turnOpen is false until the user has spoken.
    const spkOn = spk > SPEAK_TH;
    if (spkOn && !agentSpeaking && turnOpen && firstAudioHeard) {
      const stopMs = lastMicStopMs || Date.now();
      const audioMs = Date.now();
      clientTurns.push({ stopMs, audioMs, used: false });
      if (LAT_DEBUG) log(`[lat] client turn: userStop→agentAudio = ${((audioMs - stopMs) / 1000).toFixed(2)}s`);
      turnOpen = false;
    }
    agentSpeaking = spkOn;
    if (spkOn) firstAudioHeard = true;

    if (LAT_DEBUG && now - dbgLastLog > 2000) {
      log(`[lat] micPeak=${dbgMicPeak.toFixed(3)} spkPeak=${dbgSpkPeak.toFixed(3)} ` +
          `turnOpen=${turnOpen} firstAudio=${firstAudioHeard} (mic>${MIC_ON} spk>${SPEAK_TH})`);
      dbgMicPeak = 0; dbgSpkPeak = 0; dbgLastLog = now;
    }

    // Until we first hear the agent (Matthew's greeting), the Connect session
    // is still spinning up (~3-4s cold start) -> show a Connecting/loading state.
    if (!firstAudioHeard) {
      setPhase('connecting');
    } else if (spkOn) {
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

// --- Pipeline dispatch (方案 selector) -------------------------------------
// Connect = existing Chime/agentic-voice path. Transcribe / Nova Sonic = the
// self-hosted streaming pipelines from docs/latency-optimization-plan.md (方案 B).
// Their backends are not deployed yet, so those options degrade gracefully.
const PIPELINES = {
  connect: { label: 'Connect（现有 · agentic voice）' },
  transcribe: { label: 'Transcribe + LLM + Polly（方案 B · 自控三段）' },
  'nova-sonic': { label: 'Nova Sonic（方案 B · 端到端语音）' },
};

function currentPipeline() {
  const sel = document.getElementById('pipeline');
  return sel && PIPELINES[sel.value] ? sel.value : 'connect';
}

async function start() {
  const pipeline = currentPipeline();
  setLatencyMode(pipeline);
  if (pipeline === 'connect') return startConnect();
  return startStreaming(pipeline);
}

// 方案 B streaming pipelines — each on its own WS endpoint (same ALB, path-routed):
//   transcribe -> Transcribe+LLM+Polly service (/ws/session)
//   nova-sonic -> Nova Sonic S2S service       (/ws/nova)
const STREAM_WS = {
  transcribe: 'wss://stream.yagr-demo.cloud/ws/session',
  'nova-sonic': 'wss://stream.yagr-demo.cloud/ws/nova',
};
let streamSession = null;

async function startStreaming(pipeline) {
  startBtn.disabled = true;
  resetStages();
  setState('connecting');
  setPhase('connecting');
  log(`方案 = ${PIPELINES[pipeline].label}`);

  const url = STREAM_WS[pipeline];
  if (!url) {
    log('🚧 该方案的后端尚未部署（方案 B，见 docs/latency-optimization-plan.md）。');
    setState('idle');
    setPhase('idle');
    startBtn.disabled = false;
    return;
  }

  const langSel = document.getElementById('lang');
  const language = langSel ? langSel.value : 'en_US';
  try {
    streamSession = new StreamingSession(url, {
      pipeline,
      language,
      onLog: (m) => log(m),
      onStatus: (s) => {
        if (s === 'active') { setState('active'); stopBtn.disabled = false; setPhase('listening'); }
        else setPhase(s); // thinking | speaking | listening — keep the dot 'active'
      },
      onTranscript: (m) => appendTurn(m.who === 'BOT' ? 'BOT' : 'CUSTOMER', m.text),
      onToolEvent: (m) => log(`tool ${m.type}: ${m.name || ''}`),
      // Precise per-turn timings from the backend (it owns each stage).
      onTiming: (m) => {
        if (m.asr != null || m.llm != null || m.tts != null || m.e2e != null) {
          recordStage(m.asr, m.llm, m.tts, m.e2e);
        }
      },
      onError: (m) => { log('ERROR: ' + m); setState('error'); },
    });
    await streamSession.start();
  } catch (err) {
    log('ERROR starting streaming pipeline: ' + err.message);
    setState('error');
    setPhase('idle');
    startBtn.disabled = false;
  }
}

async function startConnect() {
  startBtn.disabled = true;
  setState('connecting');
  setPhase('connecting');
  resetStages();
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

    // Agent (remote) audio via Chime's volume indicator — this one fires
    // reliably. The user's mic is detected separately via Web Audio (startMicVad),
    // because Chime's LOCAL volume indicator does not fire dependably.
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
      // Start the phase loop FIRST so "Connecting" always clears when the agent
      // audio arrives — it must not depend on the mic VAD. VAD is best-effort and
      // started in the background; if its getUserMedia stalls, only ASR/TTS
      // estimation is affected, not the call or the phase display.
      startPhaseLoop();
      startMicVad().catch((e) => log('Mic VAD unavailable: ' + e.message));
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
  stopMicVad();
  if (streamSession) { try { streamSession.stop(); } catch (_) {} streamSession = null; }
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
