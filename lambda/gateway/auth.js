'use strict';
// Device-ticket auth for the voice gateway.
//
// These functions are PORTED (copied, not imported) from the sibling vgauth
// demo `cdk/lambda/api.js`, so the two demos stay independent (separate
// node_modules / deploy lifecycles) while telling the same story: "the gateway
// verifies the device's ticket with the same logic the vgauth demo showed."
//
//   Mode A  signToken / verifyToken  — IoT Core issues a short-lived, self-
//           verifiable ticket; the gateway verifies it LOCALLY (0 IoT calls).
//   Mode B  gatewayCallback          — device signs with a burned-in secret;
//           the gateway asks the backend (DynamoDB lookup) to verify (1/conn).
//
// IMPORTANT: this HMAC ticket is unrelated to the AgentCore Gateway's OIDC/JWT
// (which secures the MCP tool chain). This ticket only guards the device -> voice
// gateway WebSocket. Do not conflate the two. The signing secret here is a demo
// value ("do-not-use-in-prod"); production would use an asymmetric key or STS
// creds from the IoT Core Credentials Provider.
const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.DEVICES_TABLE;
const TOKEN_SECRET = process.env.TOKEN_SECRET || 'connect-voice-demo-token-signing-secret-do-not-use-in-prod';

// Mode A: mint a token the gateway can verify with the verify key alone.
// Format: base64url(payload).hmacSig  (two parts — NOT a standard JWT).
function signToken(deviceId) {
  const iat = Math.floor(Date.now() / 1000);
  const payload = {
    sub: deviceId,
    scope: 'voice-stream',
    iss: 'iot-core-demo',
    iat,
    exp: iat + 3600,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

// Mode A: local, offline verification (0 calls to IoT Core). Returns a `steps`
// array so the observer UI can render exactly what the gateway did.
function verifyToken(token) {
  const steps = [];
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return { ok: false, steps: ['malformed token'], iotCalls: 0 };
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  const sigOk =
    sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  steps.push(`gateway recomputes signature with VERIFY KEY only — ${sigOk ? 'match' : 'MISMATCH'}`);
  if (!sigOk) return { ok: false, steps, iotCalls: 0 };
  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch (_) {
    return { ok: false, steps: [...steps, 'payload not decodable'], iotCalls: 0 };
  }
  // Signature is valid — now enforce the claims. A well-signed but expired or
  // wrong-scope ticket must NOT grant access.
  const now = Math.floor(Date.now() / 1000);
  if (!claims.exp || now >= claims.exp) {
    return { ok: false, steps: [...steps, `ticket expired (exp=${claims.exp || 'none'})`], iotCalls: 0 };
  }
  if (claims.scope !== 'voice-stream') {
    return { ok: false, steps: [...steps, `wrong scope: ${claims.scope || 'none'} (need voice-stream)`], iotCalls: 0 };
  }
  steps.push(`token valid: sub=${claims.sub}, scope=${claims.scope}`);
  steps.push('gateway made 0 calls to IoT Core (offline verification)');
  return { ok: true, steps, iotCalls: 0, claims };
}

// Mode B: device signed with its burned-in secret; the gateway holds no secret
// and forwards to the backend, which reads the secret from the store and
// recomputes the HMAC — one round-trip PER connection.
async function gatewayCallback(deviceId, payload, signature) {
  const steps = [
    'device signed with burned-in secret (no IoT Core contact)',
    'gateway holds NO secret → forwards to backend (DynamoDB lookup)',
  ];
  if (!TABLE) return { ok: false, steps: [...steps, 'devices table not configured'], iotCalls: 1 };
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { deviceId } }));
  const device = res.Item;
  if (!device || device.status !== 'ACTIVE') {
    return { ok: false, steps: [...steps, 'device not found/inactive'], iotCalls: 1 };
  }
  const expected = crypto.createHmac('sha256', device.deviceSecret).update(payload).digest('hex');
  const ok =
    expected.length === String(signature).length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  steps.push(`backend read secret from store, recomputed signature — ${ok ? 'match' : 'MISMATCH'}`);
  steps.push('backend round-trip = 1 call PER connection');
  return { ok, steps, iotCalls: 1 };
}

module.exports = { signToken, verifyToken, gatewayCallback };
