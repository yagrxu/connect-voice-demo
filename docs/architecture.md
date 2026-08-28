# 架构说明

## 时序（浏览器一次语音对话）

```
浏览器 (打开 CloudFront URL) ── 唯一公网入口就是 CloudFront ──┐
   │  GET /  、/app.js                                        │  POST /webcall
   ▼                                                          ▼
CloudFront → S3 静态站(OAC)                        CloudFront → API Gateway
   │  加载 web/index.html + app.js                            │
   │  点 Start                                                ▼
   └──────────────────────────────────►  web 后端 Lambda (lambda/webcall/handler.js)
                                             │  connect:StartWebRTCContact(InstanceId, ContactFlowId)
                                             ▼
Amazon Connect 实例
   │  返回 ConnectionData(Meeting/Attendee)
   ▼
Amazon Connect 实例
   │  返回 ConnectionData(Meeting/Attendee)
   ▼
浏览器用 Amazon Chime SDK for JS 建立 WebRTC 语音流（麦克风上行 / agentic voice 下行）
   │
   ▼
Contact Flow (flows/agentic-voice-flow.json)
   Set logging → Set voice(=Amazon Connect agentic voice) → Get customer input(=Conversational AI bot)
   │
   ▼
Orchestrator AI agent（Connect 托管的大脑：多步推理 + 判断调哪个工具）
   │  MCP tool call
   ▼
AgentCore Gateway (MCP)  ──►  工具 Lambda (lambda/tools/handler.py)
                                get_current_time / get_weather
   │  结果回传
   ▼
AI agent 生成 <message> 文本 → agentic voice TTS → 经 WebRTC 播回浏览器
   │
   ▼
Check contact attributes（读 Lex 会话属性 Tool）→ Complete → Disconnect
```

## 我们写什么 vs Connect 托管什么

| 组件 | 谁负责 | 代码位置 |
|---|---|---|
| ASR / TTS（agentic voice） | Connect 托管 | Set voice block（flow JSON / 控制台） |
| 大脑（判断调工具、多步推理） | Connect orchestrator AI agent | `prompts/orchestration-prompt.md` |
| 工具执行逻辑 | 我们的 Lambda | `lambda/tools/{tools.py,handler.py}` |
| 工具暴露为 MCP | AgentCore Gateway | `lib/connect-demo-stack.js` |
| MCP server 注册 + 关联到实例 | AppIntegrations Application(MCP_SERVER) + IntegrationAssociation(APPLICATION) | `lib/connect-demo-stack.js`（CDK 自动，已实机验证）|
| Gateway JWT 入站授权 | AuthorizerType=CUSTOM_JWT + AuthorizerConfiguration | `lib/connect-demo-stack.js`（`-c jwtDiscoveryUrl` + `-c jwtAudience`，两轮部署，已实机验证）|
| Lex V2 bot（Bot/Version/Alias）+ 关联 | AWS::Lex::* + IntegrationAssociation(LEX_BOT) | `lib/connect-demo-stack.js`（CDK 自动，已实机验证；`-c botAliasArn` 可覆盖）|
| Contact Flow（发布） | AWS::Connect::ContactFlow（State=ACTIVE） | `lib/connect-demo-stack.js` + `flows/agentic-voice-flow.json`（CDK 自动，已实机验证）|
| Orchestrator AI agent 全链路 | Wisdom Assistant + AIPrompt(ORCHESTRATION) + AIAgent + WISDOM_ASSISTANT 关联 + Connect SecurityProfile(MCP) | `lib/connect-demo-stack.js`（`-c enableAiAgent=true`，CDK 自动，已实机验证；工具挂载见 console-setup 第 3 节）|
| 浏览器语音流接入 | Connect web calling + Chime SDK JS | `lambda/webcall/handler.js`, `web/` |
| 公网入口（合规） | CloudFront → S3(OAC) 静态站 + API Gateway | `lib/connect-demo-stack.js` |
| 编排 | Connect 实例 + Contact Flow | `lib/connect-demo-stack.js`, `flows/` |

> 安全合规：唯一的公网入口是 CloudFront。静态页放 S3（Block Public Access + OAC），`/webcall` 经 API Gateway。**不暴露 Lambda Function URL**，避免触发账号的公开访问自动缓解（Epoxy `LambdaFunctionPolicyBlockPublicAccess`）。

## 与原 Nova Sonic demo 的差异

| 维度 | 原 demo（Nova Sonic） | 本 demo（Connect） |
|---|---|---|
| 语音引擎 | Nova Sonic 端到端 speech-to-speech | Connect agentic voice 的 ASR + TTS |
| 对话回合 | 端到端，可自然打断 | agentic voice 支持 barge-in 打断，回合切换 |
| 大脑 | Nova Sonic 内置 + 本地/远程工具调度 | Connect orchestrator AI agent（托管） |
| 工具 | 进程内 / AgentCore Action Group | MCP（AgentCore Gateway → Lambda） |
| 浏览器接入 | 自建 WebSocket + Bedrock 双向流 | Connect web calling（WebRTC）+ Chime SDK |
| 明确取舍 | 依赖 Nova Sonic | **不使用 Nova Sonic**（含 Connect 的 Nova Sonic S2S 选项） |

工具逻辑（`get_current_time` / `get_weather`）与原 demo 逐行等价，确定性、无外部 API。
