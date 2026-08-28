'use strict';
// 方案 B — self-hosted streaming pipeline (Fargate-direct).
//
// Browser --WSS--> ALB --> Fargate (streaming-backend: Transcribe+Bedrock+Polly)
//                                     writes per-turn timestamps to DynamoDB.
//
// Deliberately a SEPARATE stack from ConnectVoiceDemoStack so 方案 B never risks
// the live Connect demo. Opt-in via `-c enableStreaming=true` (bin/app.js).
// Building the container image requires Docker at deploy time.
//
// See docs/latency-optimization-plan.md (方案 B, B0 = Fargate-direct).
const path = require('path');
const { Stack, Duration, CfnOutput, RemovalPolicy } = require('aws-cdk-lib');
const ec2 = require('aws-cdk-lib/aws-ec2');
const ecs = require('aws-cdk-lib/aws-ecs');
const ecsPatterns = require('aws-cdk-lib/aws-ecs-patterns');
const elbv2 = require('aws-cdk-lib/aws-elasticloadbalancingv2');
const iam = require('aws-cdk-lib/aws-iam');
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const route53 = require('aws-cdk-lib/aws-route53');
const { Platform } = require('aws-cdk-lib/aws-ecr-assets');

const PREFIX = 'ConnectVoiceDemo';

class StreamingStack extends Stack {
  constructor(scope, id, props) {
    super(scope, id, props);
    const { zoneName, hostedZoneId } = props;
    const llmModel = this.node.tryGetContext('llmModelId') ||
      'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    const streamDomain = zoneName ? `stream.${zoneName}` : undefined;

    // --- Per-turn latency timestamps (precise ASR/LLM/TTS) -----------------
    const timings = new dynamodb.Table(this, `${PREFIX}TurnTimings`, {
      tableName: `${PREFIX}-turn-timings`,
      partitionKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'turnId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Cheap VPC: public subnets only, no NAT (Fargate gets a public IP) --
    const vpc = new ec2.Vpc(this, `${PREFIX}StreamVpc`, {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC }],
    });
    const cluster = new ecs.Cluster(this, `${PREFIX}StreamCluster`, { vpc });

    // Task role: Transcribe streaming + Bedrock + Polly + write timings.
    const taskRole = new iam.Role(this, `${PREFIX}StreamTaskRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'transcribe:StartStreamTranscription',
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:Converse',
        'bedrock:ConverseStream',
        'bedrock:InvokeModelWithBidirectionalStream',  // Nova Sonic S2S
        'polly:SynthesizeSpeech',
      ],
      resources: ['*'], // demo scope; tighten to model/voice ARNs for prod
    }));
    timings.grantWriteData(taskRole);

    // Build native arm64 and run on Fargate Graviton (ARM64) — matches the build
    // host (Apple Silicon), so no slow QEMU cross-build, and Graviton is cheaper.
    // The image arch and the task runtimePlatform below MUST agree.
    const image = ecs.ContainerImage.fromAsset(path.join(__dirname, '..', 'streaming-backend'),
      { platform: Platform.LINUX_ARM64 });

    // Custom domain for WSS (browser page is HTTPS -> WS must be WSS). The
    // pattern provisions an ACM cert (us-west-2, matches ALB region) + Route 53
    // alias when domainZone + domainName + HTTPS are given.
    const domainZone = zoneName
      ? route53.HostedZone.fromHostedZoneAttributes(this, `${PREFIX}StreamZone`, { hostedZoneId, zoneName })
      : undefined;

    const svc = new ecsPatterns.ApplicationLoadBalancedFargateService(this, `${PREFIX}StreamSvc`, {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      desiredCount: 1,
      assignPublicIp: true,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      taskSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publicLoadBalancer: true,
      idleTimeout: Duration.seconds(3600), // long-lived WS
      ...(domainZone && streamDomain ? {
        protocol: elbv2.ApplicationProtocol.HTTPS,
        domainName: streamDomain,
        domainZone,
        redirectHTTP: true,
      } : {}),
      taskImageOptions: {
        image,
        containerPort: 8000,
        taskRole,
        environment: {
          AWS_REGION: this.region,
          LLM_MODEL_ID: llmModel,
          TURN_TIMINGS_TABLE: timings.tableName,
        },
      },
    });

    // Health check + sticky sessions (keep a WS on one task).
    svc.targetGroup.configureHealthCheck({ path: '/health', interval: Duration.seconds(30) });
    svc.targetGroup.enableCookieStickiness(Duration.hours(1));

    // --- Nova Sonic (end-to-end S2S) — SECOND service on the SAME ALB ---------
    // Separate image/service because aws-sdk-bedrock-runtime needs awscrt~=0.32,
    // which conflicts with amazon-transcribe's awscrt~=0.26. Routed by path
    // /ws/nova on the shared ALB (transcribe stays the default /ws/session).
    const novaImage = ecs.ContainerImage.fromAsset(path.join(__dirname, '..', 'streaming-backend'),
      { platform: Platform.LINUX_ARM64, file: 'Dockerfile.nova' });
    const novaTaskDef = new ecs.FargateTaskDefinition(this, `${PREFIX}NovaTaskDef`, {
      cpu: 512,
      memoryLimitMiB: 1024,
      taskRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    novaTaskDef.addContainer('nova', {
      image: novaImage,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'nova' }),
      environment: { AWS_REGION: this.region, TURN_TIMINGS_TABLE: timings.tableName },
      portMappings: [{ containerPort: 8000 }],
    });
    const novaService = new ecs.FargateService(this, `${PREFIX}NovaSvc`, {
      cluster,
      taskDefinition: novaTaskDef,
      desiredCount: 1,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      healthCheckGracePeriod: Duration.seconds(60),
    });
    const novaTG = new elbv2.ApplicationTargetGroup(this, `${PREFIX}NovaTG`, {
      vpc,
      port: 8000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [novaService.loadBalancerTarget({ containerName: 'nova', containerPort: 8000 })],
      healthCheck: { path: '/health', interval: Duration.seconds(30) },
      stickinessCookieDuration: Duration.hours(1),
      deregistrationDelay: Duration.seconds(10),
    });
    svc.listener.addTargetGroups(`${PREFIX}NovaRoute`, {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/ws/nova', '/ws/nova/*'])],
      targetGroups: [novaTG],
    });

    const base = streamDomain ? `wss://${streamDomain}` : `ws://${svc.loadBalancer.loadBalancerDnsName}`;
    new CfnOutput(this, `${PREFIX}StreamWsUrl`, {
      value: `${base}/ws/session`,
      description: 'Transcribe pipeline WS endpoint (STREAM_WS.transcribe in web/app.js).',
    });
    new CfnOutput(this, `${PREFIX}NovaWsUrl`, {
      value: `${base}/ws/nova`,
      description: 'Nova Sonic pipeline WS endpoint (STREAM_WS[nova-sonic] in web/app.js).',
    });
    new CfnOutput(this, `${PREFIX}StreamTimingsTable`, { value: timings.tableName });
  }
}

module.exports = { StreamingStack };
