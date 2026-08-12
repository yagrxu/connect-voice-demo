// Shared Amazon Chime SDK join helper.
//
// Both the direct-call page (app.js) and the IoT-gateway observer page
// (gateway.js) need to join a Chime meeting from a Connect ConnectionData blob
// and infer conversation phase from audio levels. app.js keeps its own inline
// copy (it predates this module and is tightly coupled to its own DOM); this
// module is the factored-out version used by gateway.js.
//
// The Meeting/Attendee inside ConnectionData are bearer join credentials handed
// to us by the voice gateway (only after it verified the device's ticket). We
// are the media peer (the device's "microphone/speaker"); we never authenticate
// to the gateway ourselves.

import {
  DefaultDeviceController,
  DefaultMeetingSession,
  MeetingSessionConfiguration,
  ConsoleLogger,
  LogLevel,
} from 'https://esm.sh/amazon-chime-sdk-js@3';

// Join a meeting. `connectionData` may be a JSON string or object.
// Returns { session, stop() }. Callbacks: onMic(level), onSpk(level), onLog(msg).
export async function joinMeeting(connectionData, { onMic, onSpk, onLog } = {}) {
  const log = (m) => onLog && onLog(m);
  const cd = typeof connectionData === 'string' ? JSON.parse(connectionData) : connectionData;
  const meeting = cd.Meeting || cd.meeting;
  const attendee = cd.Attendee || cd.attendee;
  if (!meeting || !attendee) throw new Error('ConnectionData missing Meeting/Attendee');

  const logger = new ConsoleLogger('ChimeSDK', LogLevel.WARN);
  const deviceController = new DefaultDeviceController(logger);
  const configuration = new MeetingSessionConfiguration(meeting, attendee);
  const session = new DefaultMeetingSession(configuration, logger, deviceController);

  const mics = await session.audioVideo.listAudioInputDevices();
  if (!mics.length) throw new Error('No microphone found');
  await session.audioVideo.startAudioInput(mics[0].deviceId);

  const audioEl = document.createElement('audio');
  audioEl.autoplay = true;
  document.body.appendChild(audioEl);
  await session.audioVideo.bindAudioElement(audioEl);
  session.audioVideo.start();
  log('joined Chime meeting — mic up, agentic voice down');

  // Volume indicators: local attendee = user (device mic); any remote = agent.
  const localAttendeeId = configuration.credentials.attendeeId;
  const av = session.audioVideo;
  av.realtimeSubscribeToAttendeeIdPresence((attendeeId, present) => {
    if (attendeeId === localAttendeeId) return;
    if (present) {
      av.realtimeSubscribeToVolumeIndicator(attendeeId, (id, volume) => onSpk && onSpk(volume || 0));
    }
  });
  av.realtimeSubscribeToVolumeIndicator(localAttendeeId, (id, volume) => onMic && onMic(volume || 0));

  return {
    session,
    stop() {
      try {
        session.audioVideo.stopAudioInput();
        session.audioVideo.stop();
      } catch (_) { /* ignore */ }
      audioEl.remove();
    },
  };
}

// Phase inference loop (same thresholds/decay as app.js). Calls setPhase with
// one of: connecting | listening | thinking | speaking. Returns a stop fn.
export function startPhaseLoop(getLevels, setPhase) {
  const SPEAK_TH = 0.03, MIC_ON = 0.06, MIC_OFF = 0.03, THINK_WINDOW = 8000;
  let micActive = false, userHasSpoken = false, lastMicActive = 0, firstAudioHeard = false;
  let raf = null;
  const tick = () => {
    const { mic, spk, decay } = getLevels();
    decay();
    if (!micActive && mic > MIC_ON) micActive = true;
    else if (micActive && mic < MIC_OFF) micActive = false;
    if (micActive) { userHasSpoken = true; lastMicActive = performance.now(); }
    if (spk > SPEAK_TH) firstAudioHeard = true;

    if (!firstAudioHeard) setPhase('connecting');
    else if (spk > SPEAK_TH) setPhase('speaking');
    else if (micActive) setPhase('listening');
    else if (userHasSpoken && performance.now() - lastMicActive < THINK_WINDOW) setPhase('thinking');
    else setPhase('listening');
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => raf && cancelAnimationFrame(raf);
}
