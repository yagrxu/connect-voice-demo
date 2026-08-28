# 语音 AI 演示 · 三方案对比（Connect / Transcribe / Nova Sonic）

一个在浏览器里用语音和 AI 对话的演示：打开网页、点 Start、对着麦克风说话，它会语音回复，并在需要时调用两个简单工具（`get_current_time`、`get_weather`）。

**这不再是 Connect-only 的 demo。** 同一套前端与延迟面板下，提供**三种可切换、可横向对比**的技术实现：

- **方案 A · Connect**：用 **Amazon Connect** 原生能力——agentic voice 做 ASR+TTS、orchestrator AI agent 做大脑、工具经 **AgentCore Gateway** 暴露为 **MCP**。托管黑盒，拿不到分段边界，只能测端到端延迟（≈3–4s）。
- **方案 B · Transcribe**：**自控三段流式管线**——浏览器 WSS 上行 16k PCM，ECS Fargate 服务串起 **Amazon Transcribe（ASR）→ Bedrock Converse（Claude Haiku，LLM）→ Amazon Polly（TTS）**，可**精确切分**计时 ASR/LLM/TTS（≈2.3s，LLM 主导）。
- **方案 C · Nova Sonic**：**端到端语音（S2S）**——同一前端连到另一个 Fargate 服务，调用 **Bedrock Nova 2 Sonic** 双向流，识别/推理/合成一体完成，延迟最低（≈1.4s），不可切分单段。

方案 B/C 不经 Connect，共用同一套 **ECS Fargate（ARM64）+ ALB(WSS)** 流式基建，按路径路由（`/ws/session`→B、`/ws/nova`→C），每回合时间戳写 DynamoDB 供延迟面板做横向对比。

> 三方案计时锚点统一：都从「说完话」起算到首个回复音频，不含说话时长，可公平对比。姊妹实现见 [`../chatbot-demo`](../chatbot-demo)（纯 Nova Sonic）。人设刻意去掉——就是个朴素的通用语音助手，只有报时间和报天气两个工具，保持最简。

## 架构一览（方案 A · Connect）

```
浏览器(Start) → web 后端 Lambda(StartWebRTCContact) → Connect 实例
   → Amazon Chime SDK for JS 建立 WebRTC 语音流
   → Contact Flow: Set voice(agentic voice) → Get customer input(Conversational AI bot)
        → Orchestrator AI agent（大脑）→ MCP 工具(AgentCore Gateway → 工具 Lambda)
        → agentic voice 播报 → 回浏览器
```

方案 B/C 的自控流式架构（前端→ALB→两个 Fargate 服务→AWS 托管 AI）见网页 `web/architecture.html`（顶部「方案」标签可切三方案，图会高亮当前所选管线）与 [`docs/latency-optimization-plan.md`](docs/latency-optimization-plan.md)。方案 A 时序详见 [`docs/architecture.md`](docs/architecture.md)。

## 前置条件

- **Node 18+** 和 **AWS CDK v2**（`npx cdk`）。
- **Python 3.12**（跑工具单测用）。
- **AWS 凭证**，指向沙箱账号，区域 **`us-west-2`**（俄勒冈）。该区对 Bedrock / AgentCore / Connect agentic voice 支持最成熟。
- 目标区已开通 **Bedrock 基础模型访问** 和 **Connect Customer**（agentic voice / agentic self-service 的前置）。
- 浏览器用 **Chrome / Edge / Firefox**（Safari 的部分 WebRTC 能力不支持）。

## 部署

```bash
cd connect-demo
npm install

export CDK_DEFAULT_ACCOUNT=<your-account-id>
export CDK_DEFAULT_REGION=us-west-2   # 注意：若 shell 里已有 AWS_REGION 会覆盖此项

npm run deploy
```

`npm run deploy` 自动建好：工具 Lambda、AgentCore Gateway(MCP)、**MCP server 注册 + 关联**、**Lex V2 bot + 关联**、**Contact Flow（已发布）**、Connect 实例、web calling 后端 + 前端（CloudFront→S3/API Gateway）。加 `-c enableAiAgent=true` 还会建好 **orchestrator AI agent 全链路**（Wisdom Assistant + AIPrompt + AIAgent + WISDOM_ASSISTANT 关联 + security profile）。**浏览器 web call 端到端已打通**（`/webcall` 返回真实 Chime 加入信息）。

> **几乎全链路 CDK 化。** 仅剩两件运行时小事（CFN 无法在部署期完成）：Gateway 的 **JWT 入站授权**（已 CDK 化，两轮部署）；以及 JWT 就绪后在控制台**把 MCP 工具挂到 AI agent** + bot 上启用 agentic voice。详见 [`docs/console-setup.md`](docs/console-setup.md)。
> 若复用已存在的 Connect 实例（避免账号实例配额）：追加 `-c instanceId=<你的实例 id>`。

### 方案 B/C：流式后端（可选，与 Connect 栈隔离）

方案 B/C 是独立的 `ConnectVoiceDemoStreamingStack`（`lib/streaming-stack.js`），用 `-c enableStreaming=true` 单独开启，**不依赖 Connect / Lex / Wisdom**。镜像用 **podman** 构建（Docker Desktop 被 org 登录门槛挡住）：

```bash
CDK_DOCKER=podman npx cdk deploy ConnectVoiceDemoStreamingStack \
  -c enableStreaming=true --require-approval never
```

会建好：**两个 ARM64 Fargate 服务**（服务①Transcribe 管线挂 `/ws/session`、服务②Nova Sonic 挂 `/ws/nova`，因 `awscrt` 版本冲突必须拆开）、共用 **ALB(WSS)** 按路径路由、DynamoDB `turn-timings`（每回合时间戳）。前置：Bedrock 控制台开通 **Claude Haiku** 与 **Nova 2 Sonic** 访问。

## 第二条线：IoT 设备接入语音网关（可选）

默认部署是「人对着浏览器说话」。加 `-c enableGateway=true` 会额外拉起一条**贴近客户真实链路**的线：把语音能力后面隐含的 **voice gateway** 抽象成独立组件，演示一个注册的 IoT 设备如何鉴权接入。

```bash
npx cdk deploy -c enableGateway=true -c enableAiAgent=true \
  -c jwtDiscoveryUrl=... -c jwtAudience=... --require-approval never
```

会额外建好：
- **voice gateway** = API Gateway **WebSocket API + Lambda**（真长连接、serverless）。`$connect` 验设备票，`start-call` 时调 `StartWebRTCContact`，把 Chime 加入信息**只定向推**给配对的观测网页。
- **IoT 设备** = 一台 **EC2**（t3.micro，AL2023）上的常驻 Node 进程（`device/device.js`），先 `POST /issue-ticket` 拿短期票（模拟 IoT Core 发票，Mode A），再用 WebSocket 长连接接入网关。经 **SSM Session Manager** 管理（无 SSH / 22 端口）。
- **两张 DynamoDB 表**（设备密钥 + WS 连接注册）、预置的 IoT **Thing**（`speaker-001`）。

**鉴权模型（无任何一跳裸奔）**：设备→网关用短期票（网关本地验，0 次回调 IoT Core）；`StartWebRTCContact` 只有网关 IAM 角色能调、且仅在验票通过后调（堵上原本开放的 `/webcall`）；网页→Connect 的媒体流靠 Connect 校验一次性 `ParticipantToken`（网关验票后才签发）。票据里的 HMAC 与 AgentCore 的 OIDC JWT 无关，只守 device↔gateway 的 WebSocket。移植自姊妹 demo `../cdk`（vgauth）的验票纯函数。

**验证**：打开 `ObserverPageUrl`（`/gateway.html`）点「连接网关（观测）」→ EC2 设备上线后「加入音频」亮起 → 点击用麦克风与 AI 对话。设备与网页是两个独立进程，只靠配对码 `speaker-001` 在网关处会合。

> ⚠️ EC2 常驻是这条线唯一的持续成本（t3.micro）；不演示时可停/终止实例。默认部署（不带 `-c enableGateway=true`）不产生任何新增资源。

## 试试这些提示

打开 `WebAppUrl` → 点 **Start**（授权麦克风）→ 说：

- "What time is it in Tokyo?" — 调用 `get_current_time`
- "What's the weather in Seattle?" — 调用 `get_weather`
- "Tell me the weather in Paris and the time in New York." — 一轮里调用两个工具

## 运行测试

```bash
npm test          # 等价于 python3 -m pytest lambda/tools -q
npm run synth     # CDK 合成，验证模板无误
```

## 项目结构

| 路径 | 作用 |
| --- | --- |
| `bin/app.js` | CDK 入口，默认 `us-west-2`；实例化 Connect 主栈，`-c enableStreaming=true` 时追加流式栈 |
| `lib/connect-demo-stack.js` | 方案 A 全部基建：工具 Lambda、AgentCore Gateway(MCP)、Connect 实例、web 后端；CloudFront（唯一入口）→ S3 静态站 + API Gateway |
| `lib/streaming-stack.js` | 方案 B/C 流式栈：VPC、两个 ECS Fargate 服务（ARM64）、共用 ALB(WSS) 按路径路由、DynamoDB `turn-timings` |
| `lambda/tools/tools.py` | 两个工具的纯函数（复用自原 demo，确定性、无外部 API） |
| `lambda/tools/handler.py` | MCP 工具入口，按工具名路由 |
| `lambda/webcall/handler.js` | 发起 web call（`StartWebRTCContact`），经 API Gateway 暴露；含 `/issue-ticket` `/gw-config` |
| `lambda/gateway/` | voice gateway 的 WebSocket Lambda（`handler.js`）+ 移植的验票纯函数（`auth.js`）—— 仅 `-c enableGateway=true` 时部署 |
| `device/device.js` | EC2 上模拟的 IoT 设备进程（拿票 → WS 长连接 → 起会话）；零依赖，Node 22 全局 `fetch`/`WebSocket` |
| `web/` | 浏览器页面（托管在 S3，经 CloudFront）：Start/Stop + Amazon Chime SDK WebRTC；`gateway.html` 是 IoT 线观测台；`stream.js` 是方案 B/C 流式客户端（WSS + AudioWorklet） |
| `streaming-backend/` | 方案 B/C 自控流式后端（Python）：`transcribe_pipeline.py`（Transcribe+Bedrock+Polly，方案 B）与 `nova_*` / `nova/`（Nova Sonic S2S，方案 C）；由 `lib/streaming-stack.js` 部署为两个 Fargate 服务。见 [`docs/latency-optimization-plan.md`](docs/latency-optimization-plan.md) |
| `flows/agentic-voice-flow.json` | 可导入的 Contact Flow 定义 |
| `prompts/orchestration-prompt.md` | AI agent 的 orchestration prompt |
| `docs/` | 架构说明 + 控制台补充步骤 + [延迟丈量与模型选型](docs/latency.md) + [延迟优化方案(两条路)](docs/latency-optimization-plan.md) |

## 清理

```bash
npm run destroy
```

删掉 CDK 建的资源。**在控制台手动建的 AI agent / bot / flow 需手动删除**（或直接删掉 Connect 实例）。

## 本演示刻意未实现的功能

- 电话号码 / PSTN 接入（本 demo 只走浏览器 web calling）。
- 真实天气 API（`get_weather` 返回确定性模拟数据，可离线演示）。
- 转人工队列的完整实现（flow 里预留了 `Escalate` 路由，但没接真实 agent）。
- **方案 A 的 ASR/LLM/TTS 分段延迟丈量**——三段由 Connect agentic voice 托管，拿不到分段边界事件，只能测端到端回合延迟（**方案 B 可精确切分**，方案 C 端到端 S2S 同样不可切分）。详见 [`docs/latency.md`](docs/latency.md)。
- AI agent 的 MCP **工具挂载**（运行时依赖：需 JWT 就绪后在控制台完成，见 `docs/console-setup.md` 第 3 节）。其余全链路——工具、Gateway+MCP 注册、JWT 授权、Lex bot、Contact Flow、web calling、AI agent/prompt/assistant/security profile——均已 CDK 自动化并实机验证。
