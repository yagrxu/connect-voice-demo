// Streaming voice client for 方案 B pipelines (Transcribe+LLM+Polly / Nova Sonic).
//
// Transport is a raw WebSocket to a self-hosted backend (AgentCore Runtime / WS
// proxy — see docs/latency-optimization-plan.md). This is the browser half only;
// it is transport-symmetric with chatbot-demo's static client:
//   - mic capture -> resample to 16 kHz mono -> Int16 PCM -> WS binary frames
//   - server -> 24 kHz mono Int16 PCM binary frames -> scheduled playback
//   - text frames = JSON control/status/transcript/timing messages
//
// The Connect pipeline does NOT use this module (it uses Chime WebRTC in app.js).
// This module is inert until a backend WS URL is provided.

const MIC_RATE = 16000; // Transcribe / Nova Sonic input rate
const OUT_RATE = 24000; // Polly / Nova Sonic output rate

// Inline AudioWorklet that forwards raw Float32 mono frames to the main thread.
const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
`;

function downsampleTo16k(float32, inRate) {
  if (inRate === MIC_RATE) return float32;
  const ratio = inRate / MIC_RATE;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = float32[Math.floor(i * ratio)];
  return out;
}

function float32ToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// One streaming session over a WebSocket. Callbacks:
//   onStatus(state) · onTranscript({who,text}) · onToolEvent(obj)
//   onTiming(obj)   · onError(msg) · onLog(msg)
export class StreamingSession {
  constructor(wsUrl, { pipeline, language, ...cbs } = {}) {
    this.wsUrl = wsUrl;
    this.pipeline = pipeline || 'transcribe';
    this.language = language || 'en_US';
    this.cb = cbs;
    this.ws = null;
    this.micStream = null;
    this.micCtx = null;
    this.workletNode = null;
    this.scriptNode = null;
    this.playCtx = null;
    this.playHead = 0; // scheduling cursor for gapless playback
    this.outRate = OUT_RATE; // updated by the backend's audio_format message
    this._playingUntil = 0; // wall-clock (performance.now) end of assistant playback
    this.closed = false;
  }

  _log(m) { this.cb.onLog && this.cb.onLog(m); }

  async start() {
    // 1) WebSocket
    this.ws = new WebSocket(this.wsUrl);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => {
      this._log('WS connected');
      this._send({ type: 'start', pipeline: this.pipeline, language: this.language });
      this.cb.onStatus && this.cb.onStatus('active');
    };
    this.ws.onmessage = (ev) => this._onMessage(ev);
    this.ws.onerror = () => this.cb.onError && this.cb.onError('WebSocket error');
    this.ws.onclose = () => { this.cb.onStatus && this.cb.onStatus('idle'); };

    // 2) Mic capture -> 16 kHz Int16 PCM -> WS
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.micCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.micCtx.state === 'suspended') await this.micCtx.resume(); // avoid dropped frames
    const src = this.micCtx.createMediaStreamSource(this.micStream);
    const inRate = this.micCtx.sampleRate;
    this._log(`mic capture: ctx rate=${inRate}Hz state=${this.micCtx.state}`);

    // Batch the worklet's tiny 128-sample frames into ~32ms chunks before
    // sending. Sending ~344 tiny WS frames/sec floods the main thread and causes
    // bursty/dropped delivery (the backend then mis-reads the gaps as silence and
    // ends the turn early). Batching drops that to ~31 sends/sec — steady + cheap.
    const BATCH = 512; // samples @16k ≈ 32ms
    let pending = [];  // Int16Array chunks awaiting send
    let pendingLen = 0;
    let dbgWorklet = 0, dbgMax = 0, dbgLast = performance.now();
    const onFrame = (float32) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      // Half-duplex echo suppression on the WALL CLOCK (independent of
      // AudioContext timing): mute mic only while assistant audio is playing
      // (+120ms tail); _playingUntil=0 before any playback so turn 1 is never clipped.
      if (performance.now() < this._playingUntil + 120) return;
      const pcm16 = float32ToInt16(downsampleTo16k(float32, inRate));
      pending.push(pcm16); pendingLen += pcm16.length;
      dbgWorklet++;
      let s = 0; for (let i = 0; i < pcm16.length; i++) s += pcm16[i] * pcm16[i];
      const rms = pcm16.length ? Math.sqrt(s / pcm16.length) / 32768 : 0;
      if (rms > dbgMax) dbgMax = rms;
      const now = performance.now();
      if (now - dbgLast > 1000) {
        this._log(`[cli] ${dbgWorklet} worklet-frames/s peakRMS=${dbgMax.toFixed(4)} (speech>~0.009)`);
        dbgWorklet = 0; dbgMax = 0; dbgLast = now;
      }
      if (pendingLen >= BATCH) {
        const merged = new Int16Array(pendingLen);
        let off = 0; for (const c of pending) { merged.set(c, off); off += c.length; }
        this.ws.send(merged.buffer);
        pending = []; pendingLen = 0;
      }
    };

    try {
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await this.micCtx.audioWorklet.addModule(blobUrl);
      this.workletNode = new AudioWorkletNode(this.micCtx, 'capture-processor');
      this.workletNode.port.onmessage = (e) => onFrame(e.data);
      src.connect(this.workletNode);
      // Worklet needs a sink in some browsers; route to a muted gain.
      const sink = this.micCtx.createGain(); sink.gain.value = 0;
      this.workletNode.connect(sink); sink.connect(this.micCtx.destination);
    } catch (e) {
      // Fallback: ScriptProcessorNode (deprecated but widely supported).
      this._log('AudioWorklet unavailable, using ScriptProcessor: ' + e.message);
      this.scriptNode = this.micCtx.createScriptProcessor(4096, 1, 1);
      this.scriptNode.onaudioprocess = (ev) => onFrame(ev.inputBuffer.getChannelData(0));
      src.connect(this.scriptNode);
      this.scriptNode.connect(this.micCtx.destination);
    }

    // 3) Playback context (rate confirmed by the backend's audio_format message)
    this._ensurePlayCtx(this.outRate);
  }

  _ensurePlayCtx(rate) {
    if (this.playCtx && this.playCtx.sampleRate === rate) return;
    try { if (this.playCtx) this.playCtx.close(); } catch (_) {}
    this.playCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: rate });
    this.playHead = this.playCtx.currentTime;
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  _onMessage(ev) {
    if (typeof ev.data === 'string') {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'audio_format': this.outRate = msg.rate || OUT_RATE; this._ensurePlayCtx(this.outRate); break;
        case 'status': this.cb.onStatus && this.cb.onStatus(msg.state); break;
        case 'transcript': this.cb.onTranscript && this.cb.onTranscript(msg); break;
        case 'tool_call':
        case 'tool_result': this.cb.onToolEvent && this.cb.onToolEvent(msg); break;
        case 'timing': this.cb.onTiming && this.cb.onTiming(msg); break; // {asr,llm,tts,...}
        case 'error': this.cb.onError && this.cb.onError(msg.message || 'error'); break;
        default: break;
      }
      return;
    }
    // Binary = 24 kHz Int16 PCM audio chunk -> schedule for gapless playback.
    this._playPcm(new Int16Array(ev.data));
  }

  _playPcm(int16) {
    if (!this.playCtx || !int16.length) return;
    // Track playback end on the wall clock for half-duplex muting (independent
    // of AudioContext timing). Chunks arrive faster than realtime, so accumulate.
    const durMs = (int16.length / this.outRate) * 1000;
    this._playingUntil = Math.max(this._playingUntil, performance.now()) + durMs;
    const buf = this.playCtx.createBuffer(1, int16.length, this.outRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < int16.length; i++) ch[i] = int16[i] / 0x8000;
    const node = this.playCtx.createBufferSource();
    node.buffer = buf;
    node.connect(this.playCtx.destination);
    const now = this.playCtx.currentTime;
    if (this.playHead < now) this.playHead = now + 0.02; // small anti-underrun offset
    node.start(this.playHead);
    this.playHead += buf.duration;
  }

  stop() {
    this.closed = true;
    try { this._send({ type: 'stop' }); } catch (_) {}
    try { if (this.micStream) this.micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { if (this.workletNode) this.workletNode.disconnect(); } catch (_) {}
    try { if (this.scriptNode) this.scriptNode.disconnect(); } catch (_) {}
    try { if (this.micCtx) this.micCtx.close(); } catch (_) {}
    try { if (this.playCtx) this.playCtx.close(); } catch (_) {}
    try { if (this.ws) this.ws.close(); } catch (_) {}
    this.ws = this.micStream = this.micCtx = this.workletNode = this.scriptNode = this.playCtx = null;
  }
}
