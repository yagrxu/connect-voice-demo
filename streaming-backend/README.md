# streaming-backend — 方案 B 自控流式管线（未部署）

方案 B 的后端。把语音三段从 Connect 黑盒里拿出来自己跑，从而**每段精确打点**、可切模型、可压端点。详见 [`../docs/latency-optimization-plan.md`](../docs/latency-optimization-plan.md)。

> ✅ **状态：已部署并生产端到端验证通过**（`ConnectVoiceDemoStreamingStack`，Fargate ARM64，`wss://stream.yagr-demo.cloud/ws/session`）。Transcribe 流式 / Bedrock Converse+工具 / Polly / 计时全部确认可用。首次联调修过一处：`result.alts` → `result.alternatives`；架构改为 ARM64 匹配镜像。常驻 Fargate 有持续成本，不用时 `cdk destroy ConnectVoiceDemoStreamingStack -c enableStreaming=true` 拆掉。

## 这里服务哪条管线
- **Transcribe 管线**（本目录）：`浏览器16k PCM → Transcribe 流式 → Bedrock Converse 流式(+工具) → Polly → 浏览器`，每轮写一行时间戳到 DynamoDB。
- **Nova Sonic 管线**：**不在这里**——直接复用 `../../chatbot-demo` 的 Strands/BidiAgent（已是 AgentCore Runtime）。Node 瘦代理把 `pipeline=nova-sonic` 路由到那个 runtime。

## 文件
| 文件 | 作用 |
|---|---|
| `app.py` | FastAPI WebSocket 服务（`/ws/session`、`/health`） |
| `transcribe_pipeline.py` | 三段编排 + 每段打点（核心） |
| `tools.py` | get_current_time / get_weather（确定性，与 connect-demo/chatbot-demo 一致）+ Converse toolConfig |
| `timings.py` | `TurnTiming` → DynamoDB（`ConnectVoiceDemo-turn-timings`），派生 ASR/LLM/TTS/E2E |
| `Dockerfile` | 容器镜像（AgentCore Runtime / Fargate 用） |

## 环境变量
- `AWS_REGION`（默认 us-west-2）
- `LLM_MODEL_ID`（默认 Claude Haiku 4.5；改这个即可切模型做 A/B）
- `TURN_TIMINGS_TABLE`（默认 `ConnectVoiceDemo-turn-timings`）

## 本地冒烟（可选，需 AWS 凭证 + 模型访问）
```bash
pip install -r requirements.txt
uvicorn app:app --port 8000
# 用一个 WS 客户端连 ws://localhost:8000/ws/session，发 {"type":"start","pipeline":"transcribe"} 再发 16k PCM
```

## 容器构建：用 podman（不用 docker）
本项目一律用 **podman** 构建镜像（docker desktop 有组织登录限制）。CDK 通过
`CDK_DOCKER=podman` 调用 podman，本地测试用 `podman build/run`：
```bash
CDK_DOCKER=podman CDK_DEFAULT_ACCOUNT=<your-account-id> CDK_DEFAULT_REGION=us-west-2 \
  npx cdk deploy ConnectVoiceDemoStreamingStack -c enableStreaming=true --require-approval never
```

## 部署（待定，需点头）
1. build & push 镜像到 ECR。
2. CDK 建 AgentCore Runtime（指向镜像）+ IAM（`transcribe:StartStreamTranscription`、`bedrock:InvokeModelWithResponseStream`/`Converse*`、`polly:SynthesizeSpeech`、`dynamodb:PutItem`）。
3. Node 瘦代理经 `InvokeAgentRuntimeWithWebSocketStream` 把浏览器 WS 接到 runtime；`web/app.js` 的 `STREAM_WS_URL` 指向它。
4. DynamoDB 表已在 CDK 定义（`ConnectVoiceDemo-turn-timings`），随栈部署。

## 已知细节
- Polly PCM 上限 16 kHz；服务启动会给浏览器发 `{"type":"audio_format","rate":16000}`，客户端按此速率回放（Nova Sonic 是 24 kHz）。
- Bedrock 双向流（Nova Sonic）单会话 ~8 分钟上限；Transcribe/Polly 无此限，但要处理断线重连。
