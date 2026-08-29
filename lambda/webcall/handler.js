'use strict';
// Web-calling backend for the Connect voice demo (API Gateway proxy).
//
//   POST /webcall  -> StartWebRTCContact on the Connect instance, return the
//                     Amazon Chime SDK join info to the browser.
//
// Static assets (index.html, app.js) are served separately from S3 via
// CloudFront — this Lambda only starts the web call. The browser then joins
// the WebRTC voice call with the Amazon Chime SDK for JavaScript. No phone
// number is involved — this replaces the Nova Sonic browser mic experience.

const crypto = require('crypto');
const { ConnectClient, StartWebRTCContactCommand } = require('@aws-sdk/client-connect');
const { CloudWatchLogsClient, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');

const INSTANCE_ID = process.env.CONNECT_INSTANCE_ID || '';
const CONTACT_FLOW_ID = process.env.CONTACT_FLOW_ID || '';
const AI_LOG_GROUP = process.env.AI_LOG_GROUP || '';
const WS_URL = process.env.WS_URL || ''; // voice-gateway WebSocket URL (observer page needs it)
const TOKEN_SECRET = process.env.TOKEN_SECRET || ''; // set only when the gateway line is enabled

// Mint the Mode-A device ticket ("device gets a ticket from IoT Core"). Kept
// byte-identical to lambda/gateway/auth.js::signToken so the gateway verifies
// it. Inlined here (not require()'d) because this Lambda's asset packages only
// lambda/webcall/. See lambda/gateway/auth.js for the canonical copy + rationale.
function signToken(deviceId) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = { sub: deviceId, scope: 'voice-stream', iss: 'iot-core-demo', iat, exp: iat + 3600 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

const connectClient = new ConnectClient({});
const logsClient = new CloudWatchLogsClient({});

// Pull the recent conversation turns (you + the AI) from the AI agent's
// EVENT_LOGS. TRANSCRIPT_ORCHESTRATION_MESSAGE records carry participant
// (CUSTOMER/BOT) and a `values` array; we keep the plain-text parts. CloudWatch
// ingestion lags a few seconds, so the browser polls this endpoint.
async function getTranscript(sinceMs) {
  if (!AI_LOG_GROUP) return json(200, { turns: [] });
  const startTime = sinceMs ? Number(sinceMs) : Date.now() - 10 * 60 * 1000;
  let events = [];
  try {
    const res = await logsClient.send(
      new FilterLogEventsCommand({
        logGroupName: AI_LOG_GROUP,
        startTime,
        filterPattern: '{ $.event_type = "TRANSCRIPT_ORCHESTRATION_MESSAGE" }',
        limit: 200,
      }),
    );
    events = res.events || [];
  } catch (err) {
    return json(200, { turns: [], warning: `${err.name}: ${String(err.message).slice(0, 200)}` });
  }

  const turns = [];
  for (const e of events) {
    let rec;
    try {
      rec = JSON.parse(e.message);
    } catch (_) {
      continue;
    }
    const participant = rec.participant; // CUSTOMER | BOT
    if (!participant) continue;
    let vals;
    try {
      vals = JSON.parse(rec.values || '[]');
    } catch (_) {
      continue;
    }
    const text = vals
      .filter((v) => v && v.type === 'text' && v.value)
      .map((v) => v.value)
      .join(' ')
      .trim();
    if (!text) continue; // skip tool_use / tool_result / reasoning-only entries
    turns.push({ t: rec.event_timestamp || e.timestamp, who: participant, text });
  }
  turns.sort((a, b) => a.t - b.t);
  return json(200, { turns });
}

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  };
}

// Per-language settings passed to the flow as contact attributes.
// language -> Lex locale (UpdateContactData); voice -> agentic voice TTS
// (Polly Zhiyu is the only Mandarin voice; Matthew for English); greeting ->
// the opening line the flow plays before listening.
// Two locale formats matter and differ:
//   - langCode (hyphen, e.g. zh-CN): the System "Language" attribute that
//     routes the agentic voice ASR to the right speech model. WRONG format
//     here = your Chinese is transcribed by the English ASR into gibberish.
//   - lexLocale (underscore, e.g. zh_CN): the Lex bot locale id.
// voice: Polly Zhiyu is the only Mandarin voice; Matthew for English.
const LANGS = {
  en_US: { langCode: 'en-US', lexLocale: 'en_US', voice: 'Matthew', greeting: 'Hi! How can I help you today?' },
  zh_CN: { langCode: 'zh-CN', lexLocale: 'zh_CN', voice: 'Zhiyu', greeting: '你好，请问有什么可以帮您？' },
};

async function startWebCall(lang) {
  if (!INSTANCE_ID) {
    return json(500, { error: 'CONNECT_INSTANCE_ID not configured' });
  }
  if (!CONTACT_FLOW_ID) {
    return json(503, {
      error:
        'CONTACT_FLOW_ID not set yet. Publish the agentic-voice contact flow, ' +
        'then redeploy with -c contactFlowId=<id>. See docs/console-setup.md.',
    });
  }

  const cfg = LANGS[lang] || LANGS.en_US;

  // Audio-only web call. AllowedCapabilities is omitted — its values are SEND
  // enums (not DISABLED), and leaving it out defaults to no video/screenshare,
  // which is exactly what this voice demo wants. Verified against the live
  // StartWebRTCContact API. Attributes drive per-language flow behavior.
  const res = await connectClient.send(
    new StartWebRTCContactCommand({
      InstanceId: INSTANCE_ID,
      ContactFlowId: CONTACT_FLOW_ID,
      ParticipantDetails: { DisplayName: 'Web Caller' },
      Attributes: {
        langCode: cfg.langCode,   // hyphen — System Language for ASR routing
        lexLocale: cfg.lexLocale, // underscore — Lex locale (reserved for future use)
        voice: cfg.voice,
        greeting: cfg.greeting,
      },
    }),
  );

  return json(200, {
    connectionData: res.ConnectionData,
    contactId: res.ContactId,
    participantId: res.ParticipantId,
    participantToken: res.ParticipantToken,
  });
}

exports.handler = async (event) => {
  // API Gateway proxy event shape.
  const method = event?.httpMethod || event?.requestContext?.http?.method || 'GET';
  const resourcePath = event?.path || event?.rawPath || '/';

  try {
    const p = resourcePath.replace(/^\/demo/, '');
    if (method === 'POST' && p.endsWith('/webcall')) {
      let lang = 'en_US';
      try {
        const body = event.body ? JSON.parse(event.body) : {};
        if (body.language) lang = body.language;
      } catch (_) { /* default en_US */ }
      return await startWebCall(lang);
    }
    if (method === 'GET' && p.endsWith('/transcript')) {
      const since = event?.queryStringParameters?.since;
      return await getTranscript(since);
    }
    // Voice-gateway line (only meaningful when enableGateway deployed the WS API):
    //   POST /issue-ticket  -> device "gets a ticket from IoT Core" (Mode A).
    //   GET  /gw-config      -> observer page learns the WebSocket URL.
    if (method === 'POST' && p.endsWith('/issue-ticket')) {
      if (!TOKEN_SECRET) return json(503, { error: 'gateway line not enabled (no TOKEN_SECRET)' });
      let deviceId = 'speaker-001';
      try {
        const body = event.body ? JSON.parse(event.body) : {};
        if (body.deviceId) deviceId = body.deviceId;
      } catch (_) { /* default */ }
      return json(200, {
        token: signToken(deviceId),
        steps: [
          'device authenticates to IoT Core with cert (mTLS)',
          'IoT Core issues short-lived, self-verifiable ticket (scope=voice-stream)',
        ],
      });
    }
    if (method === 'GET' && p.endsWith('/gw-config')) {
      return json(200, { wsUrl: WS_URL, deviceId: 'speaker-001' });
    }
    return json(404, { error: 'Not found', path: resourcePath, method });
  } catch (err) {
    return json(500, { error: `${err.name}: ${String(err.message).slice(0, 300)}` });
  }
};
