#!/usr/bin/env node
'use strict';
const cdk = require('aws-cdk-lib');
const { ConnectVoiceDemoStack } = require('../lib/connect-demo-stack');
const { CertStack } = require('../lib/cert-stack');

const app = new cdk.App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION || 'us-west-2';

// Custom domain (optional): pass -c domainName=voice.yagr-demo.cloud to bind a
// custom domain + force access through it. hostedZoneId/zoneName default to the
// yagr-demo.cloud Route 53 zone; override via context if needed.
const domainName = app.node.tryGetContext('domainName') || '';
const zoneName = app.node.tryGetContext('zoneName') || 'yagr-demo.cloud';
const hostedZoneId = app.node.tryGetContext('hostedZoneId') || 'Z04926573OBRKBVXJIMJJ';

let certificate;
if (domainName) {
  // CloudFront certs must be in us-east-1 — separate stack, referenced cross-region.
  const certStack = new CertStack(app, 'ConnectVoiceDemoCertStack', {
    env: { account, region: 'us-east-1' },
    crossRegionReferences: true,
    domainName,
    hostedZoneId,
    zoneName,
    description: 'us-east-1 ACM certificate for the Connect voice demo custom domain.',
  });
  certificate = certStack.certificate;
}

new ConnectVoiceDemoStack(app, 'ConnectVoiceDemoStack', {
  env: { account, region },
  crossRegionReferences: true,
  domainName,
  zoneName,
  hostedZoneId,
  certificate,
  description:
    'Browser voice-AI demo on Amazon Connect: web calling (WebRTC) -> agentic voice -> orchestrator AI agent -> MCP tools (get_current_time, get_weather). A Nova Sonic replacement.',
});
