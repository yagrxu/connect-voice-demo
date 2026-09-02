'use strict';
const { Stack, Duration, CfnOutput, RemovalPolicy, Token } = require('aws-cdk-lib');
const lambda = require('aws-cdk-lib/aws-lambda');
const iam = require('aws-cdk-lib/aws-iam');
const connect = require('aws-cdk-lib/aws-connect');
const cloudfront = require('aws-cdk-lib/aws-cloudfront');
const origins = require('aws-cdk-lib/aws-cloudfront-origins');
const apigw = require('aws-cdk-lib/aws-apigateway');
const apigwv2 = require('aws-cdk-lib/aws-apigatewayv2');
const apigwv2int = require('aws-cdk-lib/aws-apigatewayv2-integrations');
const ec2 = require('aws-cdk-lib/aws-ec2');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const s3assets = require('aws-cdk-lib/aws-s3-assets');
const s3 = require('aws-cdk-lib/aws-s3');
const s3deploy = require('aws-cdk-lib/aws-s3-deployment');
const appintegrations = require('aws-cdk-lib/aws-appintegrations');
const lex = require('aws-cdk-lib/aws-lex');
const logs = require('aws-cdk-lib/aws-logs');
const route53 = require('aws-cdk-lib/aws-route53');
const route53targets = require('aws-cdk-lib/aws-route53-targets');
const cr = require('aws-cdk-lib/custom-resources');
const cdk = require('aws-cdk-lib');
const fs = require('fs');
const path = require('path');

// Everything is prefixed ConnectVoiceDemo and lives in one stack so
// `cdk destroy` cleans it all up in a sandbox account.
const PREFIX = 'ConnectVoiceDemo';

// Public access is only ever through CloudFront: the static site is served
// from S3 (OAC) and the StartWebRTCContact API from API Gateway, both as
// origins on one distribution. No Lambda Function URL is exposed.
class ConnectVoiceDemoStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);

    // Custom domain (optional): when props.domainName + certificate are passed
    // (see bin/app.js), CloudFront is bound to the domain, a Route 53 alias
    // points at it, and a CloudFront Function rejects any request whose Host is
    // not the domain (so the raw *.cloudfront.net URL returns 403).
    const domainName = props && props.domainName ? props.domainName : '';
    const certificate = props ? props.certificate : undefined;
    const zoneName = props ? props.zoneName : undefined;
    const hostedZoneId = props ? props.hostedZoneId : undefined;

    // Optional context: an existing Connect instance id (avoids the
    // per-account instance quota) and the published contact flow id that the
    // browser web call should land on. The flow + AI agent wiring is a console
    // step (see docs/console-setup.md), so contactFlowId is set AFTER the first
    // deploy and re-deployed, or passed via `-c contactFlowId=...`.
    const existingInstanceId = this.node.tryGetContext('instanceId') || '';
    const contactFlowId = this.node.tryGetContext('contactFlowId') || '';
    // Once the Conversational AI / Lex V2 bot is created (a console step, since
    // the bot itself has no CFN resource), pass its alias ARN via
    // `-c botAliasArn=<arn>` and CDK associates it with the instance below.
    const botAliasArn = this.node.tryGetContext('botAliasArn') || '';

    // Gateway inbound JWT authorization (so Connect's JWT is accepted by the
    // Gateway). Both values are only known after the first deploy, so this is
    // opt-in on a second deploy:
    //   -c jwtDiscoveryUrl=https://<instance-domain>/.well-known/openid-configuration
    //   -c jwtAudience=<gateway id>            (the JWT `aud` claim = Gateway ID)
    // When jwtDiscoveryUrl is set, the Gateway uses CUSTOM_JWT instead of NONE.
    const jwtDiscoveryUrl = this.node.tryGetContext('jwtDiscoveryUrl') || '';
    const jwtAudience = this.node.tryGetContext('jwtAudience') || '';

    // Opt-in: build the orchestrator AI agent + security profile in CDK
    // (Amazon Q in Connect / Wisdom + Connect SecurityProfile). These are newer
    // / preview resources, so they are gated behind `-c enableAiAgent=true` to
    // keep the default deploy stable.
    const enableAiAgent = this.node.tryGetContext('enableAiAgent') === 'true';

    // Opt-in: build the "voice gateway" line — an IoT device (EC2) authenticates
    // to a WebSocket gateway (API Gateway WebSocket + Lambda) which then starts
    // the Connect session; the observer web page carries the media. Gated behind
    // `-c enableGateway=true` so the default deploy is unchanged.
    const enableGateway = this.node.tryGetContext('enableGateway') === 'true';
    // Demo ticket-signing secret (Mode A). Shared by the gateway verifier and
    // the /issue-ticket minter. Demo value; production would use asymmetric keys.
    const TOKEN_SECRET = 'connect-voice-demo-token-signing-secret-do-not-use-in-prod';
    const DEMO_DEVICE_ID = 'speaker-001';
    const DEMO_DEVICE_SECRET = 's3cr3t-001'; // Mode B burned-in secret (demo)

    // ---------------------------------------------------------------------
    // 1. Tool Lambda (Python) — the two demo tools, invoked via MCP.
    // ---------------------------------------------------------------------
    const toolFn = new lambda.Function(this, `${PREFIX}ToolFn`, {
      functionName: `${PREFIX}-tools`,
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'handler.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'tools')),
      timeout: Duration.seconds(10), // MCP tool calls have a 30s ceiling upstream
      memorySize: 128,
    });

    // ---------------------------------------------------------------------
    // 2. AgentCore Gateway (MCP) — exposes the tool Lambda as MCP tools that a
    //    Connect orchestrator AI agent can call. Pattern mirrors
    //    chatbot-demo/ref-cdk/lib/gateway-stack.ts.
    // ---------------------------------------------------------------------
    const gatewayRole = new iam.Role(this, `${PREFIX}GatewayRole`, {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
      description: 'Allows AgentCore Gateway to invoke the demo tool Lambda',
    });
    gatewayRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [toolFn.functionArn],
    }));

    // First deploy: AuthorizerType NONE (Gateway id / instance domain unknown).
    // Second deploy with -c jwtDiscoveryUrl=... (+ optional -c jwtAudience=...):
    // switch to CUSTOM_JWT so Connect's JWT is validated. AllowedAudience is the
    // Gateway id (the JWT `aud` claim); when jwtAudience is omitted we fall back
    // to the fixed Gateway name — but the Gateway id (name + random suffix) is
    // what Connect actually sends, so pass jwtAudience explicitly.
    const gatewayProps = {
      Name: 'connect-voice-demo-gateway',
      ProtocolType: 'MCP',
      RoleArn: gatewayRole.roleArn,
      AuthorizerType: 'NONE',
    };
    if (jwtDiscoveryUrl) {
      gatewayProps.AuthorizerType = 'CUSTOM_JWT';
      gatewayProps.AuthorizerConfiguration = {
        CustomJWTAuthorizer: {
          DiscoveryUrl: jwtDiscoveryUrl,
          AllowedAudience: [jwtAudience || 'connect-voice-demo-gateway'],
        },
      };
    }
    // AgentCore Gateway does NOT allow AuthorizerType to be updated in place
    // (service returns "Authorizer type cannot be updated for an existing
    // gateway" even though CFN marks it No-interruption). Suffix the logical id
    // when JWT is on, so switching modes replaces the Gateway instead of trying
    // to update it. The Gateway Name property also changes so the two Gateways
    // can co-exist during the replacement.
    const gatewayLogicalId = jwtDiscoveryUrl ? `${PREFIX}GatewayJwt` : `${PREFIX}Gateway`;
    if (jwtDiscoveryUrl) {
      gatewayProps.Name = 'connect-voice-demo-gateway-jwt';
    }
    const gateway = new cdk.CfnResource(this, gatewayLogicalId, {
      type: 'AWS::BedrockAgentCore::Gateway',
      properties: gatewayProps,
    });

    // One target holding both tools. Schemas match the original demo's
    // registry.py (GET_CURRENT_TIME_SCHEMA / GET_WEATHER_SCHEMA).
    const target = new cdk.CfnResource(this, `${PREFIX}GatewayTarget`, {
      type: 'AWS::BedrockAgentCore::GatewayTarget',
      properties: {
        GatewayIdentifier: gateway.getAtt('GatewayIdentifier'),
        Name: 'demo-tools',
        CredentialProviderConfigurations: [{ CredentialProviderType: 'GATEWAY_IAM_ROLE' }],
        TargetConfiguration: {
          Mcp: {
            Lambda: {
              LambdaArn: toolFn.functionArn,
              ToolSchema: {
                InlinePayload: [
                  {
                    Name: 'get_current_time',
                    Description: 'Return the current ISO 8601 timestamp in the requested timezone.',
                    InputSchema: {
                      Type: 'object',
                      Properties: {
                        timezone: { Type: 'string', Description: 'IANA timezone name, e.g. Asia/Tokyo. Defaults to UTC.' },
                      },
                      Required: [],
                    },
                  },
                  {
                    Name: 'get_weather',
                    Description: 'Return a mocked current weather report for the given city.',
                    InputSchema: {
                      Type: 'object',
                      Properties: {
                        city: { Type: 'string', Description: 'City name to get weather for.' },
                      },
                      Required: ['city'],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });
    target.addDependency(gateway);

    // Register the Gateway as an MCP server application (AppIntegrations).
    // This is the CDK equivalent of the "Add integration -> MCP server" console
    // step. ApplicationType MCP_SERVER points at the Gateway's MCP endpoint and
    // declares the tool identifiers it exposes.
    // NOTE: AppIntegrations MCP_SERVER + the Connect MCP wiring are in preview
    // and subject to change; if a deploy rejects these, fall back to the console
    // steps in docs/console-setup.md. The Gateway must also have JWT inbound
    // auth whose allowed audience is the Connect instance (see that doc).
    const gatewayMcpUrl = Token.asString(gateway.getAtt('GatewayUrl'));
    // MCP_SERVER applications require the Namespace to be the AgentCore Gateway
    // ID (validated server-side), not an arbitrary string.
    const gatewayId = Token.asString(gateway.getAtt('GatewayIdentifier'));
    // AppIntegrations MCP_SERVER locks the access URL to its origin Gateway;
    // switching to a new Gateway (e.g. to enable JWT) requires replacing the
    // application. Suffix the logical id and Name when JWT mode is on, so CFN
    // creates a fresh application bound to the new Gateway.
    const suffix = jwtDiscoveryUrl ? 'Jwt' : '';
    const mcpApp = new appintegrations.CfnApplication(this, `${PREFIX}McpApp${suffix}`, {
      name: `${PREFIX}-mcp${jwtDiscoveryUrl ? '-jwt' : ''}`,
      namespace: gatewayId,
      applicationType: 'MCP_SERVER',
      description: 'MCP server exposing get_current_time and get_weather via AgentCore Gateway.',
      applicationSourceConfig: {
        externalUrlConfig: {
          accessUrl: gatewayMcpUrl,
          approvedOrigins: [],
        },
      },
      // NOTE: MCP_SERVER applications reject the `Permissions` field — the tool
      // identifiers a given AI agent may call are granted on the SECURITY
      // PROFILE's Application entry instead (Type MCP, ApplicationPermissions =
      // tool ids), not on the application resource itself.
    });
    mcpApp.node.addDependency(target);

    // ---------------------------------------------------------------------
    // 3. Connect instance — the contact center that runs the flow. No phone
    //    number: the entry point is browser web calling (WebRTC).
    // ---------------------------------------------------------------------
    let instanceIdValue = existingInstanceId;
    if (!existingInstanceId) {
      const instance = new connect.CfnInstance(this, `${PREFIX}Instance`, {
        identityManagementType: 'CONNECT_MANAGED',
        instanceAlias: `connect-voice-demo-${this.account}`,
        attributes: {
          inboundCalls: true, // web calls are inbound contacts
          outboundCalls: false,
          contactflowLogs: true,
          autoResolveBestVoices: true,
        },
      });
      instance.applyRemovalPolicy(RemovalPolicy.DESTROY);
      instanceIdValue = instance.attrId;
    }

    // Instance ARN (IntegrationAssociation.InstanceId expects an ARN, not a bare id).
    const instanceArn = `arn:aws:connect:${this.region}:${this.account}:instance/${instanceIdValue}`;

    // ---------------------------------------------------------------------
    // Lex V2 bot (CDK-managed) — Bot + Version + Alias. The contact flow's
    // "Get customer input" block hands the caller to this bot's alias. A
    // minimal en_US locale with the required AMAZON.FallbackIntent is enough
    // for the demo; the orchestrator AI agent (a later, preview step) is what
    // adds the reasoning. Pass -c botAliasArn=<arn> to use an externally built
    // bot instead of this one.
    let effectiveBotAliasArn = botAliasArn;
    if (!botAliasArn) {
      const botRole = new iam.Role(this, `${PREFIX}LexRole`, {
        assumedBy: new iam.ServicePrincipal('lexv2.amazonaws.com'),
      });
      botRole.addToPolicy(new iam.PolicyStatement({
        actions: ['polly:SynthesizeSpeech', 'comprehend:DetectSentiment'],
        resources: ['*'],
      }));
      // AMAZON.QInConnectIntent with a CUSTOM bot role needs these Wisdom
      // permissions to reach the Q in Connect assistant (a Service-Linked Role
      // would get them automatically). Without them Lex errors at runtime with
      // "could not access your Q In Connect Assistant". See built-in-intent-qinconnect.
      botRole.addToPolicy(new iam.PolicyStatement({
        actions: [
          'wisdom:CreateSession',
          'wisdom:GetAssistant',
          'wisdom:SendMessage',
          'wisdom:GetNextMessage',
        ],
        resources: ['*'],
      }));

      const bot = new lex.CfnBot(this, `${PREFIX}Bot`, {
        name: `${PREFIX}-bot`,
        roleArn: botRole.roleArn,
        dataPrivacy: { ChildDirected: false },
        idleSessionTtlInSeconds: 300,
        autoBuildBotLocales: true,
        botLocales: [
          {
            localeId: 'en_US',
            nluConfidenceThreshold: 0.4,
            voiceSettings: { voiceId: 'Matthew', engine: 'neural' },
            intents: [
              // Lex requires at least one CUSTOM intent WITH an utterance for
              // the locale to build; a lone FallbackIntent fails the build with
              // "doesn't have any utterances". This placeholder satisfies that.
              // The real conversation is driven by AMAZON.QinConnectIntent (the
              // Connect AI agent intent), enabled on the bot in the admin site.
              {
                name: 'WelcomeIntent',
                description: 'Placeholder custom intent so the locale can build.',
                sampleUtterances: [
                  { utterance: 'hello' },
                  { utterance: 'hi' },
                  { utterance: 'help' },
                ],
              },
              {
                name: 'FallbackIntent',
                description: 'Default intent when no other intent matches',
                parentIntentSignature: 'AMAZON.FallbackIntent',
              },
            ],
          },
        ],
      });

      // A CfnBotVersion is an immutable snapshot of DRAFT at creation time. The
      // first version got frozen from a DRAFT that failed to build (no custom
      // intent), so it can't be reused. Create a NEW version (new logical id)
      // now that DRAFT builds cleanly, and depend on the bot so DRAFT is built
      // first. (Alias can't point at DRAFT: "DRAFT is not a valid value".)
      const botVersion = new lex.CfnBotVersion(this, `${PREFIX}BotVersion2`, {
        botId: bot.attrId,
        botVersionLocaleSpecification: [
          { localeId: 'en_US', botVersionLocaleDetails: { sourceBotVersion: 'DRAFT' } },
        ],
      });
      botVersion.addDependency(bot);

      const botAlias = new lex.CfnBotAlias(this, `${PREFIX}BotAlias`, {
        botId: bot.attrId,
        botAliasName: 'live',
        botVersion: botVersion.attrBotVersion,
        // Without botAliasLocaleSettings the alias has NO locale enabled and
        // Lex rejects runtime calls with "BotAliasId ... does not have Language
        // en_US enabled". Explicitly enable the en_US locale on the alias.
        botAliasLocaleSettings: [
          {
            localeId: 'en_US',
            botAliasLocaleSetting: { enabled: true },
          },
        ],
      });

      effectiveBotAliasArn = botAlias.attrArn;
    }

    // Associate the bot with the Connect instance (LEX_BOT integration).
    new connect.CfnIntegrationAssociation(this, `${PREFIX}BotAssociation`, {
      instanceId: instanceArn,
      integrationType: 'LEX_BOT',
      integrationArn: effectiveBotAliasArn,
    });

    // Associate the MCP server application with the instance (APPLICATION
    // integration). Also CDK-managed now, replacing the console "Instance
    // association" step. Preview API — see the note on the MCP app above.
    new connect.CfnIntegrationAssociation(this, `${PREFIX}McpAssociation${suffix}`, {
      instanceId: instanceArn,
      integrationType: 'APPLICATION',
      integrationArn: mcpApp.attrApplicationArn,
    });

    // The Q in Connect assistant is created here (before the flow) so the flow's
    // CreateWisdomSession block can reference its ARN. The rest of the AI agent
    // chain (prompt, agent, tools) is built later under `if (enableAiAgent)`.
    let wisdomAssistant = null;
    if (enableAiAgent) {
      wisdomAssistant = new cdk.CfnResource(this, `${PREFIX}Assistant`, {
        type: 'AWS::Wisdom::Assistant',
        properties: { Name: `${PREFIX}-assistant`, Type: 'AGENT' },
      });
    }

    // ---------------------------------------------------------------------
    // Contact Flow (CDK-managed, published) — loads flows/agentic-voice-flow
    // .json and injects the CDK-created bot alias ARN into the Get-customer-
    // input block. State ACTIVE == published. This replaces the manual console
    // import + publish. The web-call backend still needs the flow id, so it is
    // output below and passed to the web Lambda via the ContactFlowId env.
    const flowTemplate = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'flows', 'agentic-voice-flow.json'), 'utf-8'),
    );
    // Drop the leading _comment keys CFN's flow language does not accept, and
    // swap the BOT_ARN_PLACEHOLDER for the real alias ARN.
    delete flowTemplate._comment;
    for (const action of flowTemplate.Actions || []) {
      if (action.Parameters && action.Parameters._comment) delete action.Parameters._comment;
    }
    // The CreateWisdomSession block needs the assistant ARN. When the AI agent
    // chain is disabled, drop that block and wire setvoice straight to getinput
    // (no Q session needed without an AI agent).
    if (!wisdomAssistant) {
      flowTemplate.Actions = flowTemplate.Actions.filter((a) => a.Identifier !== 'wisdom');
      for (const a of flowTemplate.Actions) {
        if (a.Identifier === 'setvoice') a.Transitions.NextAction = 'getinput';
      }
    }
    let flowContent = JSON.stringify(flowTemplate);
    flowContent = flowContent.split('BOT_ARN_PLACEHOLDER').join(Token.asString(effectiveBotAliasArn));
    if (wisdomAssistant) {
      flowContent = flowContent
        .split('WISDOM_ASSISTANT_ARN_PLACEHOLDER')
        .join(Token.asString(wisdomAssistant.getAtt('AssistantArn')));
    }

    const contactFlow = new connect.CfnContactFlow(this, `${PREFIX}Flow`, {
      instanceArn,
      name: `${PREFIX}-agentic-voice`,
      type: 'CONTACT_FLOW',
      state: 'ACTIVE', // published
      content: flowContent,
    });
    const createdFlowId = cdk.Fn.select(
      1,
      cdk.Fn.split('/contact-flow/', contactFlow.attrContactFlowArn),
    );

    // ---------------------------------------------------------------------
    // Orchestrator AI agent + security profile (opt-in via -c enableAiAgent).
    // Dependency chain: Assistant -> AIPrompt(ORCHESTRATION) -> AIAgent
    // (ORCHESTRATION, referencing the prompt + MCP tools). SecurityProfile
    // grants the MCP tools (Type MCP, Namespace = Gateway id). All are Amazon
    // Q in Connect / Wisdom preview resources — kept behind the flag.
    // ---------------------------------------------------------------------
    if (enableAiAgent) {
      const assistant = wisdomAssistant; // created above so the flow can reference it

      // The orchestration AI agent requires its assistant to be associated with
      // the Connect instance (WISDOM_ASSISTANT integration). Without this the
      // AIAgent create fails: "Assistant does not associate with Connect
      // instance". Verified against the live API.
      const assistantAssoc = new connect.CfnIntegrationAssociation(this, `${PREFIX}AssistantAssoc`, {
        instanceId: instanceArn,
        integrationType: 'WISDOM_ASSISTANT',
        integrationArn: assistant.getAtt('AssistantArn'),
      });

      // Orchestration prompt as a YAML text template. Verified against the live
      // CreateAIPrompt API: `messages` must be exactly one bare
      // "{{$.conversationHistory}}" entry (optionally + one assistant prefill),
      // NOT a role/content wrapper. `system` carries the instructions.
      // Use a YAML block scalar (>-) for `system` so punctuation (colons,
      // commas, <message>, /) inside the text doesn't break YAML parsing —
      // a long unquoted single-line value fails with "not in expected YAML
      // format". `messages` stays a single bare conversation-history entry.
      // Kept in sync with the live AIPrompt (tuned via docs/latency-optimization-plan.md,
      // section A). Enhanced over the original: forceful same-language rule,
      // natural-spoken time formatting (no ISO read-out), and an efficiency rule
      // (one tool call, one final message). Runs on Claude Haiku 4.5.
      const promptYaml = [
        'system: >-',
        '  You are a friendly bilingual (English and Mandarin Chinese) voice assistant.',
        "  CRITICAL LANGUAGE RULE: reply in the SAME language as the caller's most recent",
        '  message. If the caller spoke English, reply only in English. If the caller',
        '  spoke Chinese, reply only in Chinese. Never switch languages on your own.',
        '  You can tell the current time in any timezone using get_current_time, and give a',
        '  short weather report for a city using get_weather.',
        '  Callers may mix English words (such as city names) into Chinese speech;',
        '  interpret by meaning and keep proper nouns and city names in their original form.',
        '  You MUST call a tool to get the time or weather. Never guess, estimate, or make',
        '  up a value; only report what the tool returns.',
        '  TIME FORMATTING: tools may return an ISO timestamp like 2026-08-26T16:34:02.',
        '  Never read it out verbatim. Convert it to natural spoken form: say the clock',
        '  time in 12-hour words (for example "it is about 4:34 in the afternoon", or in',
        '  Chinese "现在是下午四点半左右"). Do not speak the date, the letter T, colons,',
        '  seconds, decimals, timezone codes, or any symbols.',
        '  EFFICIENCY: Respond in as few steps as possible. Do NOT send filler, status,',
        '  acknowledgment, reasoning, or empty messages such as "let me check". Call at',
        '  most one tool per request, and as soon as the tool returns, immediately produce',
        '  the final answer as a single <message>. One tool call, one final message.',
        '  Wrap every reply to the caller in <message> tags.',
        '  Keep replies to one short spoken sentence.',
        '  Politely decline anything unrelated to time or weather.',
        'messages:',
        '  - "{{$.conversationHistory}}"',
      ].join('\n');

      const aiPrompt = new cdk.CfnResource(this, `${PREFIX}AiPrompt`, {
        type: 'AWS::Wisdom::AIPrompt',
        properties: {
          AssistantId: assistant.ref,
          Name: `${PREFIX}-orchestration-prompt`,
          ApiFormat: 'MESSAGES',
          // Must be an ACTIVE model that supports ORCHESTRATION. The CFN doc's
          // model list is stale; the live set comes from `qconnect list-models`.
          // Claude 4.5 Haiku is fast and well-suited to short voice turns.
          ModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
          TemplateType: 'TEXT',
          Type: 'ORCHESTRATION',
          TemplateConfiguration: {
            TextFullAIPromptEditTemplateConfiguration: { Text: promptYaml },
          },
        },
      });
      aiPrompt.addDependency(assistant);

      const aiAgent = new cdk.CfnResource(this, `${PREFIX}AiAgent`, {
        type: 'AWS::Wisdom::AIAgent',
        properties: {
          AssistantId: assistant.ref,
          Name: `${PREFIX}-orchestrator`,
          Type: 'ORCHESTRATION',
          Configuration: {
            OrchestrationAIAgentConfiguration: {
              ConnectInstanceArn: instanceArn,
              Locale: 'en_US',
              OrchestrationAIPromptId: aiPrompt.getAtt('AIPromptId'),
              // MCP tool ids, as QConnect actually stores them, are
              // "gateway_<gatewayId>__<target>___<toolName>" (verified via
              // get-ai-agent after a console attach). We compose that from the
              // gateway id token. QConnect must be able to enumerate the gateway
              // tools at deploy time, which requires the JWT trust chain to be
              // live. If a first deploy (before JWT is wired) fails with "MCP
              // tool ... not found", omit this block and re-deploy after JWT.
              ToolConfigurations: [
                {
                  ToolName: 'get_current_time',
                  ToolType: 'MODEL_CONTEXT_PROTOCOL',
                  ToolId: `gateway_${gatewayId}__demo-tools___get_current_time`,
                },
                {
                  ToolName: 'get_weather',
                  ToolType: 'MODEL_CONTEXT_PROTOCOL',
                  ToolId: `gateway_${gatewayId}__demo-tools___get_weather`,
                },
              ],
            },
          },
        },
      });
      aiAgent.addDependency(aiPrompt);
      aiAgent.addDependency(assistantAssoc); // assistant must be associated first

      // ------------------------------------------------------------------
      // AI agent EVENT_LOGS -> CloudWatch. The log records include
      // TRANSCRIPT_ORCHESTRATION_MESSAGE entries with participant CUSTOMER/BOT
      // and the message text — this is how the web UI shows a live transcript
      // (there is no realtime transcript push to the browser). Set up via the
      // CloudWatch Logs delivery model (source=assistant, destination=log group).
      // ------------------------------------------------------------------
      const aiLogGroup = new logs.LogGroup(this, `${PREFIX}AiLogs`, {
        logGroupName: `/connect/${PREFIX}/ai-agent`,
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: RemovalPolicy.DESTROY,
      });
      const logSource = new cdk.CfnResource(this, `${PREFIX}AiLogSource`, {
        type: 'AWS::Logs::DeliverySource',
        properties: {
          Name: `${PREFIX}-ai-agent-source`,
          LogType: 'EVENT_LOGS',
          ResourceArn: assistant.getAtt('AssistantArn'),
        },
      });
      logSource.node.addDependency(assistant);
      const logDest = new cdk.CfnResource(this, `${PREFIX}AiLogDest`, {
        type: 'AWS::Logs::DeliveryDestination',
        properties: {
          Name: `${PREFIX}-ai-agent-dest`,
          DestinationResourceArn: aiLogGroup.logGroupArn,
          OutputFormat: 'json',
        },
      });
      logDest.node.addDependency(aiLogGroup);
      const logDelivery = new cdk.CfnResource(this, `${PREFIX}AiLogDelivery`, {
        type: 'AWS::Logs::Delivery',
        properties: {
          DeliverySourceName: logSource.ref,
          DeliveryDestinationArn: logDest.getAtt('Arn'),
        },
      });
      logDelivery.addDependency(logSource);
      logDelivery.addDependency(logDest);

      // Security profile granting the two MCP tools (Type MCP, Namespace =
      // Gateway id). Minimal permissions set for a self-service AI agent.
      const secProfile = new connect.CfnSecurityProfile(this, `${PREFIX}SecProfile`, {
        instanceArn,
        securityProfileName: `${PREFIX}-mcp-tools`,
        description: 'Grants the demo MCP tools to the orchestrator AI agent.',
        applications: [
          {
            namespace: gatewayId,
            // MCP tool permission ids are "<gatewayTargetName>___<toolName>"
            // (the ___ delimiter is the AgentCore convention our tool Lambda
            // also parses). Verified against the live CreateSecurityProfile API.
            applicationPermissions: ['demo-tools___get_current_time', 'demo-tools___get_weather'],
          },
        ],
      });
      // The Application.Type (MCP) field may not be a typed prop in this CDK
      // version; set it directly on the synthesized resource.
      secProfile.addPropertyOverride('Applications.0.Type', 'MCP');

      // Attach the security profile to the AI agent. There is NO CFN field for
      // this on AWS::Wisdom::AIAgent — it's a separate connect:AssociateSecurityProfiles
      // call (EntityType AI_AGENT). Done here via a custom resource so the whole
      // chain stays in CDK. Verified against the live API (SecurityProfiles takes
      // {Id}, EntityType must be AI_AGENT).
      const secProfileId = cdk.Fn.select(
        1,
        cdk.Fn.split('/security-profile/', secProfile.attrSecurityProfileArn),
      );
      const attachSecProfile = new cr.AwsCustomResource(this, `${PREFIX}AiAgentSecProfileAttach`, {
        onCreate: {
          service: 'Connect',
          action: 'associateSecurityProfiles',
          parameters: {
            InstanceId: instanceIdValue,
            EntityType: 'AI_AGENT',
            EntityArn: aiAgent.getAtt('AIAgentArn'),
            SecurityProfiles: [{ Id: secProfileId }],
          },
          physicalResourceId: cr.PhysicalResourceId.of(`${PREFIX}-aiagent-secprofile`),
        },
        // No clean onDelete (disassociate) needed for a sandbox demo — the AI
        // agent and profile are torn down with the stack.
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });
      // associateSecurityProfiles internally reads the AI agent, so the custom
      // resource role needs wisdom:GetAiAgent in addition to the auto-generated
      // connect:AssociateSecurityProfiles permission.
      attachSecProfile.grantPrincipal.addToPrincipalPolicy(new iam.PolicyStatement({
        actions: ['wisdom:GetAiAgent', 'connect:AssociateSecurityProfiles'],
        resources: ['*'],
      }));
      attachSecProfile.node.addDependency(secProfile);
      attachSecProfile.node.addDependency(aiAgent);
    }

    // ---------------------------------------------------------------------
    // 3b. Voice gateway line (opt-in, `-c enableGateway=true`).
    //     An IoT device (EC2) authenticates to a WebSocket gateway which then
    //     starts the Connect session; the observer web page carries the media.
    //     device --ticket--> WS gateway --StartWebRTCContact--> Connect
    //                                     \--join info--> observer page (media)
    // ---------------------------------------------------------------------
    // 方案 B per-turn latency table lives in the separate StreamingStack
    // (lib/streaming-stack.js), so 方案 B never touches this live Connect stack.

    let wsCallbackUrl = '';
    if (enableGateway) {
      // Device-secret store (stands in for Secrets Manager). Reuses the vgauth
      // schema so the "same verify logic" story holds.
      const devicesTable = new dynamodb.Table(this, `${PREFIX}Devices`, {
        tableName: `${PREFIX}-devices`,
        partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        removalPolicy: RemovalPolicy.DESTROY,
      });

      // WebSocket connection registry. GSI on deviceId lets the gateway find all
      // connections (device + observers) sharing a pairing code, to broadcast.
      // TTL auto-expires orphaned rows.
      const connectionsTable = new dynamodb.Table(this, `${PREFIX}Connections`, {
        tableName: `${PREFIX}-connections`,
        partitionKey: { name: 'connectionId', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        timeToLiveAttribute: 'ttl',
        removalPolicy: RemovalPolicy.DESTROY,
      });
      connectionsTable.addGlobalSecondaryIndex({
        indexName: 'deviceId-index',
        partitionKey: { name: 'deviceId', type: dynamodb.AttributeType.STRING },
      });

      // Pre-provision the demo device at deploy time (a real IoT Thing + secret),
      // mirroring the vgauth pattern. No runtime device-creation endpoint.
      const provision = new cr.AwsCustomResource(this, `${PREFIX}DeviceProvision`, {
        onCreate: {
          service: 'Iot',
          action: 'createThing',
          parameters: { thingName: DEMO_DEVICE_ID, attributePayload: { attributes: { managedBy: PREFIX } } },
          physicalResourceId: cr.PhysicalResourceId.of(`${PREFIX}-thing-${DEMO_DEVICE_ID}`),
          ignoreErrorCodesMatching: 'ResourceAlreadyExistsException',
        },
        onDelete: {
          service: 'Iot',
          action: 'deleteThing',
          parameters: { thingName: DEMO_DEVICE_ID },
          ignoreErrorCodesMatching: 'ResourceNotFoundException|InvalidRequestException',
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE }),
      });
      const seed = new cr.AwsCustomResource(this, `${PREFIX}DeviceSeed`, {
        onCreate: {
          service: 'DynamoDB',
          action: 'putItem',
          parameters: {
            TableName: devicesTable.tableName,
            Item: {
              deviceId: { S: DEMO_DEVICE_ID },
              deviceSecret: { S: DEMO_DEVICE_SECRET },
              status: { S: 'ACTIVE' },
            },
          },
          physicalResourceId: cr.PhysicalResourceId.of(`${PREFIX}-seed-${DEMO_DEVICE_ID}`),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [devicesTable.tableArn] }),
      });
      seed.node.addDependency(devicesTable);

      // The WebSocket gateway Lambda.
      const gwFn = new lambda.Function(this, `${PREFIX}GwFn`, {
        functionName: `${PREFIX}-gateway`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'handler.handler',
        code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'gateway')),
        timeout: Duration.seconds(15),
        memorySize: 256,
        environment: {
          CONNECT_INSTANCE_ID: instanceIdValue,
          CONTACT_FLOW_ID: contactFlowId || createdFlowId,
          CONNECTIONS_TABLE: connectionsTable.tableName,
          DEVICE_INDEX: 'deviceId-index',
          DEVICES_TABLE: devicesTable.tableName,
          TOKEN_SECRET,
        },
      });
      gwFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['connect:StartWebRTCContact'],
        resources: ['*'],
      }));
      devicesTable.grantReadData(gwFn);
      connectionsTable.grantReadWriteData(gwFn);

      // WebSocket API: $connect/$disconnect/$default all → gwFn.
      const wsApi = new apigwv2.WebSocketApi(this, `${PREFIX}WsApi`, {
        apiName: `${PREFIX}-gateway`,
        connectRouteOptions: { integration: new apigwv2int.WebSocketLambdaIntegration('ConnectInt', gwFn) },
        disconnectRouteOptions: { integration: new apigwv2int.WebSocketLambdaIntegration('DisconnectInt', gwFn) },
        defaultRouteOptions: { integration: new apigwv2int.WebSocketLambdaIntegration('DefaultInt', gwFn) },
      });
      const wsStage = new apigwv2.WebSocketStage(this, `${PREFIX}WsStage`, {
        webSocketApi: wsApi,
        stageName: 'demo',
        autoDeploy: true,
      });
      // Let the gateway Lambda push messages back over connections.
      wsApi.grantManageConnections(gwFn);
      wsCallbackUrl = wsStage.url; // wss://<id>.execute-api.<region>.amazonaws.com/demo

      // ----- The IoT device host (EC2, long-lived process) -----
      // Minimal networking: 1 AZ, public subnet, no NAT. Egress 443 only, zero
      // ingress. Managed via SSM Session Manager (no SSH / port 22).
      const vpc = new ec2.Vpc(this, `${PREFIX}DeviceVpc`, {
        maxAzs: 1,
        natGateways: 0,
        subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
      });
      const sg = new ec2.SecurityGroup(this, `${PREFIX}DeviceSg`, {
        vpc,
        allowAllOutbound: true, // needs 443 to CloudFront/API + SSM
        description: 'Device host: egress only, no ingress',
      });

      // Ship the device script as an S3 asset; UserData pulls + runs it.
      const deviceAsset = new s3assets.Asset(this, `${PREFIX}DeviceAsset`, {
        path: path.join(__dirname, '..', 'device'),
      });

      const deviceHost = new ec2.Instance(this, `${PREFIX}DeviceHost`, {
        vpc,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
        // cachedInContext: resolve the AL2023 AMI once and cache it in
        // cdk.context.json, so routine deploys don't replace the device host
        // every time AWS publishes a new AMI. Refresh deliberately with
        // `cdk context --reset` (or delete the cached key).
        machineImage: ec2.MachineImage.latestAmazonLinux2023({ cachedInContext: true }),
        securityGroup: sg,
        ssmSessionPermissions: true, // managed via SSM, no SSH key
      });
      deviceAsset.grantRead(deviceHost.role);

      // The device needs the same-origin API to fetch a ticket. Prefer the
      // custom domain if set, else the CloudFront domain is not known yet here —
      // so the device calls the API Gateway REST endpoint directly for the
      // ticket (server-to-server, not browser-facing) and the WS stage for the
      // socket. Both are passed via UserData env below (api url resolved after
      // the REST API exists — see the post-API wiring).
      // Store handles for later wiring:
      this._gateway = { deviceHost, deviceAsset, wsCallbackUrl, connectionsTable, devicesTable, wsApi, wsStage };
    }

    // ---------------------------------------------------------------------
    // 4. Web calling backend (Lambda behind API Gateway) + static site (S3).
    //    Both sit behind ONE CloudFront distribution (the only public entry):
    //      GET  /*         -> S3 static assets (index.html, app.js) via OAC
    //      POST /webcall   -> API Gateway -> Lambda (StartWebRTCContact)
    //    No Lambda Function URL — avoids the open-URL auto-mitigation entirely.
    // ---------------------------------------------------------------------
    const webFn = new lambda.Function(this, `${PREFIX}WebFn`, {
      functionName: `${PREFIX}-web`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'webcall')),
      timeout: Duration.seconds(15),
      memorySize: 256,
      environment: {
        CONNECT_INSTANCE_ID: instanceIdValue,
        // The flow is now CDK-managed, so its id is known at deploy time. A
        // `-c contactFlowId=...` override still wins if provided.
        CONTACT_FLOW_ID: contactFlowId || createdFlowId,
        // AI agent transcript log group (deterministic name; only populated when
        // the AI agent chain is enabled). The /transcript endpoint reads it.
        AI_LOG_GROUP: enableAiAgent ? `/connect/${PREFIX}/ai-agent` : '',
        // Voice-gateway line: /issue-ticket mints device tickets; /gw-config
        // hands the WS URL to the observer page. Empty unless enableGateway.
        TOKEN_SECRET: enableGateway ? TOKEN_SECRET : '',
        WS_URL: wsCallbackUrl,
      },
    });
    webFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['connect:StartWebRTCContact'],
      resources: ['*'], // demo: StartWebRTCContact does not support fine-grained resource ARNs cleanly
    }));
    // Read the AI agent transcript logs for the /transcript endpoint.
    webFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['logs:FilterLogEvents'],
      resources: ['*'],
    }));

    // API Gateway in front of the web-call Lambda. This is a first-class
    // CloudFront origin (the same pattern the sibling vgauth demo uses).
    const api = new apigw.LambdaRestApi(this, `${PREFIX}Api`, {
      restApiName: `${PREFIX}-api`,
      handler: webFn,
      proxy: true,
      deployOptions: { stageName: 'demo' },
    });

    // Wire the device host now that the REST API exists (it needs the API URL
    // to fetch a ticket over HTTPS, and the WS URL to open the socket).
    if (enableGateway && this._gateway) {
      const { deviceHost, deviceAsset, wsCallbackUrl: wsUrl } = this._gateway;
      const bucket = deviceAsset.bucket.bucketName;
      const key = deviceAsset.s3ObjectKey;
      deviceHost.addUserData(
        'set -xe',
        // AL2023's default nodejs is 18 (no global WebSocket). The device uses
        // Node 22's built-in fetch + WebSocket, so install 22 from NodeSource.
        // AL2023 ships nodejs-18 preinstalled, which blocks the NodeSource pkg;
        // remove it first, then install from the NodeSource repo explicitly.
        'dnf install -y unzip',
        'curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -',
        'dnf remove -y nodejs nodejs-full-i18n || true',
        'dnf install -y nodejs --disablerepo=amazonlinux',
        'mkdir -p /opt/device',
        `aws s3 cp s3://${bucket}/${key} /tmp/device.zip`,
        'unzip -o /tmp/device.zip -d /opt/device',
        // systemd unit so the device process is long-lived and restarts.
        'cat >/etc/systemd/system/device.service <<UNIT',
        '[Unit]',
        'Description=Connect voice demo IoT device',
        'After=network-online.target',
        '[Service]',
        `Environment=API_URL=${api.url.replace(/\/$/, '')}`,
        `Environment=WS_URL=${wsUrl}`,
        `Environment=DEVICE_ID=${DEMO_DEVICE_ID}`,
        'Environment=LANGUAGE=en_US',
        'ExecStart=/usr/bin/node /opt/device/device.js',
        'Restart=always',
        'RestartSec=5',
        '[Install]',
        'WantedBy=multi-user.target',
        'UNIT',
        'systemctl daemon-reload',
        'systemctl enable --now device.service',
      );
    }

    // S3 bucket holding the static frontend (index.html, app.js).
    const siteBucket = new s3.Bucket(this, `${PREFIX}Site`, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // access only via CloudFront OAC
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    new s3deploy.BucketDeployment(this, `${PREFIX}SiteDeploy`, {
      sources: [s3deploy.Source.asset(path.join(__dirname, '..', 'web'))],
      destinationBucket: siteBucket,
    });

    // ---------------------------------------------------------------------
    // CloudFront — the ONLY allowed public entry point.
    //   default (GET)   -> S3 (static site) via OAC
    //   /webcall        -> API Gateway (POST StartWebRTCContact)
    //   /transcript     -> API Gateway (GET live transcript from AI logs)
    // ---------------------------------------------------------------------
    const apiOrigin = new origins.RestApiOrigin(api);

    // Viewer-request CloudFront Function combining two gates (a behavior may have
    // only one viewer-request function, so both live here):
    //   1) Host guard — when a custom domain is set, reject any Host that isn't
    //      it, so the raw *.cloudfront.net URL returns 403.
    //   2) Basic Auth — when `-c sitePass=...` is given, require HTTP Basic
    //      credentials so casual visitors can't view the demo. Server-enforced at
    //      the edge (can't be bypassed by reading source). The password is NEVER
    //      committed: it comes from deploy-time context and is inlined only into
    //      the (AWS-console-visible) function code. Override the username with
    //      `-c siteUser=...` (default 'demo'). Device -> /issue-ticket is
    //      unaffected: the device calls API Gateway directly, not via CloudFront.
    const siteUser = this.node.tryGetContext('siteUser') || 'demo';
    const sitePass = this.node.tryGetContext('sitePass') || '';
    let fnAssoc;
    if (domainName || sitePass) {
      const parts = ['function handler(event){var r=event.request;'];
      if (domainName) {
        parts.push(
          "var h=r.headers.host&&r.headers.host.value;" +
          "if(h!=='" + domainName + "'){return{statusCode:403,statusDescription:'Forbidden'," +
          "body:{encoding:'text',data:'Access only via " + domainName + "'}};}"
        );
      }
      if (sitePass) {
        const b64 = Buffer.from(`${siteUser}:${sitePass}`).toString('base64');
        const realm = domainName || 'demo';
        parts.push(
          "var a=r.headers.authorization&&r.headers.authorization.value;" +
          "if(a!=='Basic " + b64 + "'){return{statusCode:401,statusDescription:'Unauthorized'," +
          "headers:{'www-authenticate':{value:'Basic realm=\"" + realm + "\"'}}," +
          "body:{encoding:'text',data:'Authentication required'}};}"
        );
      }
      parts.push('return r;}');
      const guardFn = new cloudfront.Function(this, `${PREFIX}HostGuard`, {
        code: cloudfront.FunctionCode.fromInline(parts.join('')),
        comment: 'Viewer-request gate: custom-domain Host guard + optional Basic Auth.',
      });
      fnAssoc = [{ function: guardFn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }];
    }

    const apiBehavior = () => ({
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      ...(fnAssoc ? { functionAssociations: fnAssoc } : {}),
    });

    const distribution = new cloudfront.Distribution(this, `${PREFIX}Cdn`, {
      comment: 'ConnectVoiceDemo — forces all public access through the CDN',
      defaultRootObject: 'index.html',
      ...(domainName && certificate ? { domainNames: [domainName], certificate } : {}),
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        ...(fnAssoc ? { functionAssociations: fnAssoc } : {}),
      },
      additionalBehaviors: {
        // API routes go to API Gateway (not S3). /transcript needs the query
        // string (since=...) forwarded, which ALL_VIEWER_EXCEPT_HOST_HEADER does.
        // issue-ticket/gw-config back the voice-gateway line (only meaningful
        // when enableGateway; harmless otherwise — the Lambda 503s them).
        'webcall': apiBehavior(),
        'transcript': apiBehavior(),
        'issue-ticket': apiBehavior(),
        'gw-config': apiBehavior(),
      },
    });

    // Route 53 alias: voice.yagr-demo.cloud -> CloudFront.
    if (domainName && zoneName && hostedZoneId) {
      const zone = route53.HostedZone.fromHostedZoneAttributes(this, `${PREFIX}Zone`, {
        hostedZoneId,
        zoneName,
      });
      const recordName = domainName.endsWith('.' + zoneName)
        ? domainName.slice(0, -(zoneName.length + 1))
        : domainName;
      new route53.ARecord(this, `${PREFIX}AliasA`, {
        zone,
        recordName,
        target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
      });
      new route53.AaaaRecord(this, `${PREFIX}AliasAAAA`, {
        zone,
        recordName,
        target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
      });
    }

    // ---------------------------------------------------------------------
    // Outputs — everything the console-setup steps and the browser need.
    // ---------------------------------------------------------------------
    new CfnOutput(this, 'WebAppUrl', {
      value: domainName ? `https://${domainName}/` : `https://${distribution.distributionDomainName}/`,
      description: domainName
        ? 'Custom domain (the only allowed entry — raw *.cloudfront.net returns 403).'
        : 'CloudFront URL. Open in Chrome/Edge/Firefox, click Start, and talk to the demo.',
    });
    new CfnOutput(this, 'CloudFrontDomain', {
      value: distribution.distributionDomainName,
      description: 'Underlying CloudFront domain (blocked when a custom domain is enforced).',
    });
    new CfnOutput(this, 'GatewayUrl', {
      value: Token.asString(gateway.getAtt('GatewayUrl')),
      description: 'AgentCore Gateway MCP endpoint (register as an MCP server in Connect).',
    });
    new CfnOutput(this, 'GatewayArn', {
      value: Token.asString(gateway.getAtt('GatewayArn')),
      description: 'AgentCore Gateway ARN.',
    });
    new CfnOutput(this, 'ConnectInstanceId', {
      value: instanceIdValue,
      description: 'Amazon Connect instance id — used for the bot, AI agent, and contact flow.',
    });
    new CfnOutput(this, 'ToolLambdaArn', {
      value: toolFn.functionArn,
      description: 'Tool Lambda ARN (get_current_time, get_weather).',
    });
    new CfnOutput(this, 'ContactFlowIdInUse', {
      value: contactFlowId || createdFlowId,
      description: 'Contact flow (CDK-managed, published) the browser web call lands on.',
    });
    new CfnOutput(this, 'BotAliasArnInUse', {
      value: effectiveBotAliasArn,
      description: 'Lex V2 bot alias associated with the instance (LEX_BOT integration).',
    });

    if (enableGateway && this._gateway) {
      new CfnOutput(this, 'VoiceGatewayWsUrl', {
        value: this._gateway.wsCallbackUrl,
        description: 'Voice gateway WebSocket URL. The EC2 device and the observer page connect here.',
      });
      new CfnOutput(this, 'DeviceInstanceId', {
        value: this._gateway.deviceHost.instanceId,
        description: 'EC2 instance running the simulated IoT device. Manage via SSM Session Manager (no SSH).',
      });
      new CfnOutput(this, 'ObserverPageUrl', {
        value: domainName
          ? `https://${domainName}/gateway.html`
          : `https://${distribution.distributionDomainName}/gateway.html`,
        description: 'Observer console for the IoT device → voice gateway line.',
      });
    }
  }
}

module.exports = { ConnectVoiceDemoStack };
