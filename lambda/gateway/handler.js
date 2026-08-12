'use strict';
// Voice gateway — API Gateway WebSocket API backend.
//
// This is the "voice gateway" abstracted out of the direct-call demo: a real
// long-lived, serverless front door that an IoT device connects to. It does
// SIGNALING only (auth + session orchestration); the audio media stream is
// carried separately by the observer web page via the Amazon Chime SDK, direct
// to Amazon Connect. Signaling/media split — the standard WebRTC pattern.
//
// Routes:
//   $connect     — verify the device ticket (Mode A, query string). role=device
//                  with an invalid ticket is rejected (401). Register the
//                  connection in the Connections table (device / observer).
//   $disconnect  — remove the connection; if it was the device, mark offline
//                  and notify observers.
//   $default     — action router:
//                    start-call : ONLY role=device. Verify (Mode B optional),
//                                 StartWebRTCContact, then push the Chime join
//                                 info to the paired observer(s) and status to
//                                 the device.
//                    status     : echo the current session for this device.
//
// Security: StartWebRTCContact is callable only by THIS Lambda's role, and only
// after the device's ticket verified. The Chime Meeting/Attendee it returns are
// bearer join credentials — handed only to the paired observer connection(s),
// never broadcast. That is what makes the media stream authenticated: no ticket
// -> no session -> no join info -> no media.

const { ConnectClient, StartWebRTCContactCommand } = require('@aws-sdk/client-connect');
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  DeleteConnectionCommand,
} = require('@aws-sdk/client-apigatewaymanagementapi');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  GetCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');

const { verifyToken, gatewayCallback } = require('./auth');

const INSTANCE_ID = process.env.CONNECT_INSTANCE_ID || '';
const CONTACT_FLOW_ID = process.env.CONTACT_FLOW_ID || '';
const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE || '';
const DEVICE_INDEX = process.env.DEVICE_INDEX || 'deviceId-index';
// How long a connection row / cached session lives if not cleaned up (seconds).
const TTL_SECONDS = 2 * 60 * 60;
// Demo determinism: no Date.now() in some sandboxes is fine here (Lambda has a
// real clock); used only for TTL and session timestamps.
const nowSec = () => Math.floor(Date.now() / 1000);

const connect = new ConnectClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Per-language settings — kept identical to lambda/webcall/handler.js so the
// gateway line routes ASR / picks TTS voice / greets exactly like the direct
// line. langCode (hyphen) = System Language for ASR; lexLocale (underscore) =
// Lex locale; voice = Polly voice; greeting = opening line.
const LANGS = {
  en_US: { langCode: 'en-US', lexLocale: 'en_US', voice: 'Matthew', greeting: 'Hi! How can I help you today?' },
  zh_CN: { langCode: 'zh-CN', lexLocale: 'zh_CN', voice: 'Zhiyu', greeting: '你好，请问有什么可以帮您？' },
};

// A cached-session row is stored under connectionId = `SESSION#<deviceId>` so a
// late-joining observer can immediately pick up the current session.
const sessionKey = (deviceId) => `SESSION#${deviceId}`;

function mgmtClient(event) {
  const { domainName, stage } = event.requestContext;
  return new ApiGatewayManagementApiClient({ endpoint: `https://${domainName}/${stage}` });
}

async function post(client, connectionId, payload) {
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(payload)),
      }),
    );
    return true;
  } catch (err) {
    // 410 Gone — stale connection; drop its row.
    if (err.name === 'GoneException' || err.$metadata?.httpStatusCode === 410) {
      await ddb.send(new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } })).catch(() => {});
    }
    return false;
  }
}

// All live connection rows for a device (excludes the SESSION# cache row).
async function connectionsForDevice(deviceId) {
  const res = await ddb.send(
    new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: DEVICE_INDEX,
      KeyConditionExpression: 'deviceId = :d',
      ExpressionAttributeValues: { ':d': deviceId },
    }),
  );
  return (res.Items || []).filter((i) => i.role === 'device' || i.role === 'observer');
}

async function broadcast(client, deviceId, payload, roleFilter) {
  const rows = await connectionsForDevice(deviceId);
  await Promise.all(
    rows
      .filter((r) => !roleFilter || r.role === roleFilter)
      .map((r) => post(client, r.connectionId, payload)),
  );
}

// ---- $connect ----
async function onConnect(event) {
  const qs = event.queryStringParameters || {};
  const role = qs.role === 'observer' ? 'observer' : 'device';
  const deviceId = qs.deviceId || 'speaker-001';
  const connectionId = event.requestContext.connectionId;

  let steps = [];
  if (role === 'device') {
    // Devices MUST present a valid ticket. Observers connect without one (they
    // are a trusted local peripheral — the mic/screen — not the authed party).
    const v = verifyToken(qs.ticket);
    steps = v.steps;
    if (!v.ok) {
      return { statusCode: 401, body: 'invalid device ticket' };
    }
  } else {
    steps = ['observer connected (no device ticket required)'];
  }

  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId,
        deviceId,
        role,
        online: true,
        connectedAt: nowSec(),
        ttl: nowSec() + TTL_SECONDS,
        authSteps: steps,
      },
    }),
  );

  // NOTE: we cannot postToConnection to THIS connection from $connect — the
  // socket isn't ready to receive yet. The observer sends a `hello` action right
  // after opening (handled in $default) to learn device presence + any cached
  // session. Here we only notify OTHER already-established observers.
  if (role === 'device') {
    const client = mgmtClient(event);
    await broadcast(client, deviceId, { type: 'device-online', deviceId, authSteps: steps }, 'observer');
  }

  return { statusCode: 200, body: 'connected' };
}

// ---- $disconnect ----
async function onDisconnect(event) {
  const connectionId = event.requestContext.connectionId;
  const existing = await ddb
    .send(new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } }))
    .catch(() => ({}));
  const row = existing.Item;
  await ddb.send(new DeleteCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } })).catch(() => {});
  if (row && row.role === 'device') {
    const client = mgmtClient(event);
    await broadcast(client, row.deviceId, { type: 'device-offline', deviceId: row.deviceId }, 'observer');
  }
  return { statusCode: 200, body: 'disconnected' };
}

// ---- start-call (device only) ----
async function startCall(event, connectionId, row, body) {
  const client = mgmtClient(event);
  if (!row || row.role !== 'device') {
    await post(client, connectionId, { type: 'error', error: 'only a device connection may start a call' });
    return { statusCode: 403, body: 'forbidden' };
  }
  if (!INSTANCE_ID || !CONTACT_FLOW_ID) {
    await post(client, connectionId, { type: 'error', error: 'gateway not fully configured (instance/flow)' });
    return { statusCode: 503, body: 'not configured' };
  }

  const deviceId = row.deviceId;
  const lang = LANGS[body.language] ? body.language : 'en_US';
  const cfg = LANGS[lang];

  // Mode B (optional): device supplied a burned-in-secret signature — verify via
  // backend (1 DynamoDB round-trip) before starting. Otherwise the device was
  // already ticket-verified at $connect (Mode A).
  let modeSteps = ['device already ticket-verified at connect (Mode A, 0 IoT calls)'];
  if (body.payload && body.signature) {
    const cb = await gatewayCallback(deviceId, body.payload, body.signature);
    modeSteps = cb.steps;
    if (!cb.ok) {
      await post(client, connectionId, { type: 'error', error: 'signature verification failed', steps: cb.steps });
      return { statusCode: 401, body: 'bad signature' };
    }
  }
  await broadcast(client, deviceId, { type: 'auth-steps', steps: modeSteps }, 'observer');

  // Only the gateway role can call this — this is the choke point that used to
  // be the open /webcall endpoint.
  const res = await connect.send(
    new StartWebRTCContactCommand({
      InstanceId: INSTANCE_ID,
      ContactFlowId: CONTACT_FLOW_ID,
      ParticipantDetails: { DisplayName: `Device ${deviceId}` },
      Attributes: {
        langCode: cfg.langCode,
        lexLocale: cfg.lexLocale,
        voice: cfg.voice,
        greeting: cfg.greeting,
        deviceId,
      },
    }),
  );

  const connectionData =
    typeof res.ConnectionData === 'string' ? res.ConnectionData : JSON.stringify(res.ConnectionData);

  // Cache the session so a late observer can pick it up (short TTL).
  await ddb.send(
    new PutCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId: sessionKey(deviceId),
        deviceId,
        role: 'session',
        contactId: res.ContactId,
        connectionData,
        ttl: nowSec() + 15 * 60,
      },
    }),
  );

  // Push join info to observer(s) ONLY; device gets a status ack (no media).
  await broadcast(
    client,
    deviceId,
    { type: 'session-started', contactId: res.ContactId, connectionData },
    'observer',
  );
  await post(client, connectionId, { type: 'call-started', contactId: res.ContactId, language: lang });

  return { statusCode: 200, body: 'call started' };
}

// ---- $default (action router) ----
async function onDefault(event) {
  const connectionId = event.requestContext.connectionId;
  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (_) {
    /* ignore */
  }
  const row = (await ddb.send(new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId } }))).Item;

  const client = mgmtClient(event);
  switch (body.action) {
    case 'start-call':
      return startCall(event, connectionId, row, body);
    // Observer just connected and asks for current state. (Can't push this from
    // $connect — the connection isn't ready to receive there.) Reply with device
    // presence and replay a cached session so a late observer can still join.
    case 'hello': {
      if (!row) return { statusCode: 200, body: 'ok' };
      const devices = (await connectionsForDevice(row.deviceId)).filter((r) => r.role === 'device');
      const deviceOnline = devices.length > 0;
      await post(client, connectionId, { type: 'hello', deviceId: row.deviceId, deviceOnline });
      // Only replay a cached session when the device is OFFLINE (can't be woken).
      // If it's online the observer will wake it for a FRESH session, so a stale
      // cached meeting (possibly dead) must not be offered as joinable.
      if (!deviceOnline) {
        const cached = (await ddb.send(
          new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId: sessionKey(row.deviceId) } }),
        )).Item;
        if (cached && cached.connectionData) {
          await post(client, connectionId, {
            type: 'session-started',
            contactId: cached.contactId,
            connectionData: cached.connectionData,
            replay: true,
          });
        }
      }
      return { statusCode: 200, body: 'ok' };
    }
    // Observer wakes the device: forward a wake to the device connection(s), which
    // then start a fresh call. Mirrors a real device being triggered on demand.
    case 'wake': {
      const deviceId = row?.deviceId;
      if (!deviceId) return { statusCode: 200, body: 'ok' };
      const devices = (await connectionsForDevice(deviceId)).filter((r) => r.role === 'device');
      if (!devices.length) {
        await post(client, connectionId, { type: 'error', error: 'device is offline' });
        return { statusCode: 200, body: 'ok' };
      }
      await Promise.all(devices.map((d) => post(client, d.connectionId, { type: 'wake', language: body.language })));
      return { statusCode: 200, body: 'ok' };
    }
    case 'status': {
      const cached = row
        ? (await ddb.send(new GetCommand({ TableName: CONNECTIONS_TABLE, Key: { connectionId: sessionKey(row.deviceId) } }))).Item
        : null;
      await post(client, connectionId, {
        type: 'status',
        deviceId: row?.deviceId,
        contactId: cached?.contactId || null,
      });
      return { statusCode: 200, body: 'ok' };
    }
    default: {
      await post(client, connectionId, { type: 'error', error: `unknown action: ${body.action}` });
      return { statusCode: 400, body: 'unknown action' };
    }
  }
}

exports.handler = async (event) => {
  const routeKey = event.requestContext?.routeKey;
  try {
    if (routeKey === '$connect') return await onConnect(event);
    if (routeKey === '$disconnect') return await onDisconnect(event);
    return await onDefault(event);
  } catch (err) {
    console.error('gateway error', routeKey, err);
    return { statusCode: 500, body: `${err.name}: ${err.message}` };
  }
};
