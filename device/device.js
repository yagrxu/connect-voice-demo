'use strict';
// Simulated IoT device ("speaker-001") — runs as a long-lived process on EC2,
// standing in for a real smart-speaker's firmware. It is NOT a web page: the
// browser observer console is separate and only mirrors what happens here.
//
// What it does (the customer's real device→gateway flow):
//   1. Ask "IoT Core" for a short-lived ticket   (GET  <API>/issue-ticket, Mode A)
//   2. Open a long-lived WebSocket to the voice gateway, presenting the ticket
//   3. Ask the gateway to start a voice session   ({action:'start-call'})
//   4. Print status the gateway pushes back (session-started, transcript, ...)
//
// Audio is deliberately NOT handled here (a headless EC2 box has no mic): the
// gateway hands the Chime join info to the paired web observer, which carries
// the media. This is the signaling/media split.
//
// Node 22 has global fetch + WebSocket — zero npm dependencies.

const API_URL = (process.env.API_URL || '').replace(/\/$/, ''); // e.g. https://xxx.execute-api…/demo
const WS_URL = process.env.WS_URL || ''; // e.g. wss://yyy.execute-api…/demo
const DEVICE_ID = process.env.DEVICE_ID || 'speaker-001';
const LANGUAGE = process.env.LANGUAGE || 'en_US';
// Seconds between automatic start-call attempts (0 = only once on connect).
const CALL_INTERVAL = Number(process.env.CALL_INTERVAL || 0);

function log(...args) {
  const t = new Date().toISOString();
  console.log(`[device ${DEVICE_ID} ${t}]`, ...args);
}

async function getTicket() {
  log('① requesting ticket from IoT Core (GET /issue-ticket)…');
  const res = await fetch(`${API_URL}/issue-ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: DEVICE_ID }),
  });
  if (!res.ok) throw new Error(`issue-ticket failed: HTTP ${res.status}`);
  const data = await res.json();
  (data.steps || []).forEach((s) => log('   ·', s));
  log('   ticket acquired (scope=voice-stream)');
  return data.token;
}

function connect(ticket) {
  const url = `${WS_URL}?ticket=${encodeURIComponent(ticket)}&deviceId=${encodeURIComponent(DEVICE_ID)}&role=device`;
  log('② opening WebSocket to voice gateway…');
  const ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    log('   gateway accepted the connection (ticket verified server-side)');
    log('   idle — waiting to be woken by an observer (real devices start a');
    log('   session on a trigger/wake-word, not on boot).');
    if (CALL_INTERVAL > 0) {
      setInterval(() => startCall(ws), CALL_INTERVAL * 1000);
    }
  });

  ws.addEventListener('message', (evt) => {
    let msg;
    try {
      msg = JSON.parse(evt.data);
    } catch (_) {
      return;
    }
    switch (msg.type) {
      case 'wake':
        log(`   ← wake received (language=${msg.language || LANGUAGE}) — starting a session`);
        startCall(ws, msg.language);
        break;
      case 'call-started':
        log(`   ✓ session started (contactId=${msg.contactId}, lang=${msg.language})`);
        log('   audio is carried by the paired web observer — device stays signaling-only');
        break;
      case 'status':
        log(`   status: contactId=${msg.contactId || '(none)'}`);
        break;
      case 'error':
        log('   ✗ gateway error:', msg.error);
        break;
      default:
        log('   gateway →', JSON.stringify(msg));
    }
  });

  ws.addEventListener('close', (evt) => {
    log(`   WebSocket closed (code=${evt.code}). Reconnecting in 5s…`);
    setTimeout(main, 5000);
  });

  ws.addEventListener('error', (evt) => {
    log('   WebSocket error:', evt.message || evt.type || 'unknown');
  });

  return ws;
}

function startCall(ws, language) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const lang = language || LANGUAGE;
  log(`③ asking gateway to start a voice session (language=${lang})…`);
  ws.send(JSON.stringify({ action: 'start-call', language: lang }));
}

async function main() {
  if (!API_URL || !WS_URL) {
    log('FATAL: API_URL and WS_URL env vars are required.');
    process.exit(1);
  }
  try {
    const ticket = await getTicket();
    connect(ticket);
  } catch (err) {
    log('startup failed:', err.message, '— retrying in 5s');
    setTimeout(main, 5000);
  }
}

main();
