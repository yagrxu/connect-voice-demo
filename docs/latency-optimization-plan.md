# 延迟优化方案（两条路）

本文基于实测数据，给出两套并行推进的方案：
- **方案 A —— 在现有 Connect 架构上调优**（低风险、快见效，但有天花板）。
- **方案 B —— 自建语音管线**（能做到每段精确埋点 + 运行时切模型 + 1 秒级延迟，工程量大）。

> 实测基线（Nova Lite，工具回合，客户端反推）：
> ASR≈ 2.0–5.0s（波动大）· LLM = 2.2s（服务器日志，精确）· TTS≈ 0.1s · 总 ~4.5–8s。
> 结论：**TTS 可忽略；LLM 已到最快档；ASR 端点检测是最大且最不稳的可调项。**

---

## ⚠️ 当前线上状态（先记一笔，两方案都涉及）

- 线上 AI agent 的模型已被我用 `update-ai-prompt` **临时改为 Nova Lite + 强化 prompt**（英语场景更顺、强制调工具）。
- **CDK 代码（`lib/connect-demo-stack.js:471`）里仍是 Claude Haiku 4.5** —— 存在配置漂移。
- 执行前先决定：**保留 Nova Lite 就把 CDK 代码改成一致**；**要回 Haiku 就 `update-ai-prompt` 改回**（还原值：`us.anthropic.claude-haiku-4-5-20251001-v1:0`）。下次任何 `cdk deploy` 都会以 CDK 代码为准覆盖线上。

---

# 方案 A：Connect 现架构调优

按**投资回报**排序。每项含：目标 / 动作 / 验证 / 风险。

> ## A 执行结果（已试）
> - **A4（自然口语时间）✅ 完成**：prompt 加时间格式化规则，Haiku 下正确（"下午五点五十八"，不再念 ISO 时间戳）。当前线上 = **Haiku 4.5 + 增强 prompt**（语言/效率/时间规则）。
> - **A2（削减 LLM 往返）❌ 无收益**：工具回合仍 3~4 步（tool_use→中间→结果→最终），是托管编排的结构性行为，prompt 压不动；非工具回合本就 ~1s。
> - **A1（ASR 端点检测）❌ 无可调面**：API 端唯一相关字段 `speechDetectionSensitivity` 取值 `{Default, MaximumNoiseTolerance, HighNoiseTolerance}` —— 是**噪声容忍度**，不是静音超时。真正的 end-of-speech 静音等待在 agentic voice 里**全托管、无任何 API/配置字段**。
> - **模型**：Haiku 4.5 = 质量最优（语言对、时间自然、不刷屏、时间不算错），~3~3.6s；Nova Micro/Lite 更快但指令跟随崩（英问中答、刷屏、"昨天"错算）——不可用。
> - **结论**：Connect 工具回合地板 ≈ **3~3.6s + 一段不可调的 ASR 端点等待**。A 线除 A4 质量改进外，**延迟无更多空间**。要继续降延迟 / 让每段可测可调 → **方案 B**。

## A1. ASR 端点检测（最高优先级）
- **目标**：把"你停口 → Connect 判定你说完"的等待从 2–5s 压到 ~1s 并稳定下来。这是当前最大、最不稳的一块。
- **动作**：
  1. 定位确切旋钮：Lex V2 bot locale 的 `speechDetectionSensitivity`（已确认存在）；agentic voice / agentic self-service 在控制台的 **end-of-speech / 静音超时 / barge-in** 设置。
  2. 逐步调短静音判定，每档跑 5–10 轮记录 ASR≈ 分布。
- **验证**：页面 ASR≈ 中位数下降且方差变小；体感"说完到回话"变短。
- **风险**：调太激进会**误截断**用户说话（还没说完就判定结束）。要找"不误截断的最短值"。

## A2. 削减 LLM 往返次数
- **目标**：工具回合现在是 3 次串行推理（各 ~1s）。砍掉中间冗余步 → 省 ~1s。
- **动作**：
  1. 优化 orchestration prompt：禁止中间/寒暄消息，要求"工具返回后**一步**给出最终 `<message>`"。
  2. 确认没有"先说'让我查一下'再调工具"这类会多一次往返的指令（现线上 prompt 已无，保持）。
- **验证**：AI-agent 日志里一个工具回合的 `TRANSCRIPT_ORCHESTRATION_MESSAGE` BOT 条目从 3 条降到 2 条；CUSTOMER→BOT 总时长下降。
- **风险**：过度约束可能让它跳过必要的工具调用（Nova 系尤其）——回归测试天气/时间。

## A3. 开启并确认 prompt 缓存命中
- **目标**：span 里见到 `cache_write=587, cache_read=0` —— 说明有缓存但当轮在写、没读。确认后续轮 `cache_read>0`，省输入处理时间。
- **动作**：连续多轮对话，检查 AI-agent trace span 的 `cache_read_input_tokens` 是否 >0；若始终为 0，排查系统提示是否稳定可缓存。
- **验证**：`cache_read_input_tokens>0`；TTFT 略降。
- **风险**：低。

## A4. 模型选择（英语场景已定调）
- **结论**：英语单语 → **Nova Lite** 是甜点位（快 + 工具可靠 + 语言对）。
  - 修 Nova Lite "念 ISO 时间戳"的毛病：prompt 加"时间用自然口语说，不要读 ISO 格式"。
  - **Haiku 4.5** 作为质量兜底（慢但最自然、多语言）。
  - **不用 Nova Micro**（工具调用纪律差）。
- **验证**：英问英答、每次真调工具、时间读法自然。
- **风险**：模型换动的是线上 AI agent，可回退（见顶部状态）。

## A5. 冷启动
- **目标**：首轮 +3–4s。
- **动作**：保留已有的本地问候垫场；如需可加保活。
- **风险**：低。

## A6. 测量本身的精度
- **动作**：现 ASR≈ 靠客户端 VAD 反推、有噪声。可收紧 VAD 停口判定（加静音保持窗口）降低抖动；或接受为量级参考。LLM/TTS 已可信。
- **备注**：A1 调优的**验证**依赖这个测量，所以先把 VAD 调稳一点更划算。

## 方案 A 的天花板（务必对客户说清）
- ASR/LLM/TTS **无法真正分段精确测量**（ASR/TTS 无服务器时间戳）。
- LLM 的 3 次串行往返是编排结构，压缩有限。
- **做到头大概 ~2–3s、且每段不可精确归因**。要 1 秒级 + 每段可测 → 方案 B。

---

# 方案 B：三方案集成（一个页面，三条管线，同一延迟面板对比）

不是"另起一个 demo"，而是**在现页面加一个"方案"选择器（放在语言下拉旁边）**，一键切换三条后端管线，用**同一张 DynamoDB 时间戳表 + 同一块延迟面板**并排对比：

| 方案（下拉项） | 管线 | ASR/LLM/TTS 分段 | 现状 |
|---|---|---|---|
| **Connect** | 现有 agentic voice（Chime WebRTC） | ≈ 估算（黑盒，客户端反推） | ✅ 已上线 |
| **Transcribe** | Transcribe 流式 + Bedrock + Polly（自控三段） | **精确**（每段自己打点） | ✅ 已上线并生产验证（`ConnectVoiceDemoStreamingStack`） |
| **Nova Sonic** | 端到端 speech-to-speech（复用 `../chatbot-demo`） | **无三段**（S2S 一体）；测 E2E + 首字/首音 | 🔨 待移植 |

> 价值：同一页面把"托管黑盒 vs 自控三段 vs 端到端 S2S"的延迟**当场量给客户看**，这就是最初要的选型/调试台。

## B0 决策（已定 = Fargate-direct）
- **不用 Lambda**：流式后端需要**持续双向连接**，API Gateway WebSocket 每帧触发独立 Lambda、维持不了一个 Transcribe/Nova Sonic 流；Lambda 只能"攒整句批处理"，会丢掉流式低延迟、比 Connect 还慢。
- **不用 AgentCore Runtime（对本场景）**：浏览器连不到 AgentCore（它只能用 SigV4 的 `InvokeAgentRuntimeWithWebSocketStream` 调），所以浏览器边缘**始终需要一个常驻 Fargate 服务**做 WS 前端（chatbot-demo 也是 Fargate 前端再代理到 AgentCore）。既然 Fargate 免不了，**直接在 Fargate 上跑管线**比"Fargate 代理 → AgentCore"更简单。
- **托管 = 单个 Fargate FastAPI 服务（Fargate-direct）**：Transcribe 管线 = `streaming-backend/`（我写的）；Nova Sonic = 复用 chatbot-demo 的 `SonicSession` 直连路径。
- **语言 = Python**（复用 chatbot-demo 骨架）；connect-demo 的 CDK 仍是 JS。
- **独立 CDK 栈** `ConnectVoiceDemoStreamingStack`（`lib/streaming-stack.js`），`-c enableStreaming=true` 才建，**完全不碰线上 Connect 主栈**。含：VPC(公有子网/无 NAT) + ECS Fargate + ALB(HTTPS/WSS, `stream.<zone>`) + DynamoDB 计时表 + IAM。
- **未部署**：`cdk deploy ConnectVoiceDemoStreamingStack -c enableStreaming=true`（需 Docker build 镜像；有持续成本，需显式点头）。部署后把输出的 `StreamWsUrl` 填进 `web/app.js` 的 `STREAM_WS_URL`。

## 架构：两种传输并存
```
                        ┌─ 方案=Connect  → 现有 start()：StartWebRTCContact + Chime WebRTC
浏览器 [方案▾][语言▾][▶] ─┤
                        └─ 方案=Transcribe/NovaSonic → 原始 WebSocket 送 PCM 到常驻后端
                                     │
                    ┌────────────────┴─────────────────┐
        [Transcribe 管线 @AgentCore]         [Nova Sonic 管线 @AgentCore]
         Transcribe流式→Bedrock流式→Polly     lift chatbot-demo Strands/BidiAgent
         每段打点 → DynamoDB                   S2S 首字/首音打点 → DynamoDB
         (Node 后端经 InvokeAgentRuntimeWithWebSocketStream 代理，工具走现有 MCP Gateway)
                    └────────────────┬─────────────────┘
                          同一张 DynamoDB 时间戳表（按 turnId）
                                     │
                        延迟面板按"方案"渲染对应分段
```
- **Connect** 走 Chime WebRTC（不变）；**Transcribe / Nova Sonic** 共用一套"浏览器 PCM 采集 + WS + 音频回放"前端（16kHz 上行 / 24kHz 下行，参考 chatbot-demo 的 `static/index.html`，几乎可直接搬）。

## 三条管线各自的设计

### B-Connect（已完成，保持）
- ≈ 估算：`ASR = CUSTOMER日志ts − 用户停口`、`LLM = BOT ts − CUSTOMER ts`(精确)、`TTS = 首音频 − BOT ts`。已在 `web/app.js` 实现。

### B-Transcribe（新建，标准三段，精确）
- 常驻进程（**Fargate**，Lambda 不适合长连接流式）持有会话：
  - **Transcribe Streaming**：出 partial/final，端点检测我们自己控（可调到比 Connect 激进）→ 打点 `t_asr_first_partial / t_asr_final`。
  - **Bedrock 流式**（Converse API + 工具，模型走配置/下拉可切 Claude/Nova）→ 打点 `t_llm_req / t_first_token / t_llm_done`。
  - **Polly 流式**：首字节即回、边合成边播 → 打点 `t_tts_req / t_tts_first_byte`。
- 工具直接复用现有 `lambda/tools`（get_current_time / get_weather，schema 与 chatbot-demo 一致）。

### B-NovaSonic（移植 chatbot-demo）
- **端到端 S2S**：单条 `bedrock:InvokeModelWithBidirectionalStream`（模型 `amazon.nova-2-sonic-v1:0`），PCM 进、PCM+转写+工具请求出——**没有独立 ASR/LLM/TTS 三段**，面板对该方案只显示 **E2E + 首转写 + 首音频**。
- **落地方式（首选 AgentCore，最省事）**：
  - **(首选) AgentCore Runtime + 代理**：chatbot-demo 已有这条路——Strands `BidiAgent`(`agents/strands/entrypoint.py`) 跑在 **AgentCore Runtime**，工具走 **MCP Gateway**（connect-demo 现在也已经在用 AgentCore Gateway 挂工具，一致）。connect-demo 后端像 chatbot-demo 的 `/ws/agent` 那样，用 `bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream`（SigV4 WS）**代理**过去即可。**不用自建 Fargate/ALB，AgentCore 托管运行时**，是"最容易"的路。
  - (备选1) Python Fargate 侧车 + Node 代理：把 `SonicSession`+`events.py` 作为独立 Python 服务自管。
  - (备选2) Node 重写双向流（JS SDK `InvokeModelWithBidirectionalStreamCommand`）：`events.py` 逻辑 1:1 可移植，但流/凭证管线要重写。
- 可直接搬的件：`events.py`、`SonicSession`、`messages.py`(WS 消息契约)、`static/index.html`(浏览器音频客户端)、工具 schema；AgentCore 路还可直接复用 chatbot-demo 的 `agents/strands` 容器。
- **约束**：Bedrock 双向流单会话 ~8 分钟上限；Nova Sonic 仅 `us-east-1/us-east-2/us-west-2/ap-northeast-1`（us-west-2 ✅）。

## DynamoDB 时间戳表（统一、按方案灵活）
- 表名：`voice-turn-timings`；主键 `PK=sessionId`、`SK=turnId`；`pipeline` 字段标记 Connect/Transcribe/NovaSonic。
- 属性（epoch-ms，按方案存在哪些填哪些）：`t_recv`、`t_asr_first_partial`、`t_asr_final`、`t_llm_req`、`t_llm_first_token`、`t_llm_done`、`t_tts_req`、`t_tts_first_byte`、`t_first_audio_out`、`model`、`usage_tokens`、`text_user`、`text_bot`。
- Nova Sonic 只填 `t_recv / t_first_transcript / t_first_audio_out / t_done`（无三段）。
- 派生指标读时算；面板按 `pipeline` 决定画三段瀑布还是 E2E 单条。`TTL` 自动清理。

## 分阶段执行计划
| 阶段 | 内容 | 产出/验证 |
|---|---|---|
| **B0 选型** | 定区域(us-west-2)、载体(Fargate)、Nova Sonic 用侧车还是 Node 重写、复用现 CloudFront/域名、DynamoDB 表 | 一页决策记录 |
| **B1 UI+路由** | 加"方案"下拉；app.js 按方案分流（Connect=现有；其余=新 WS 通道）；搬 chatbot-demo 浏览器音频客户端 | 选 Connect 走老路；选其它建起 WS、能回放一段回声 |
| **B2 常驻后端** | **首选 AgentCore Runtime 托管**流式代理（复用 chatbot-demo 的 `agents/strands` 容器 + MCP Gateway，`InvokeAgentRuntimeWithWebSocketStream` 代理），省掉自建 Fargate/ALB；两条自控管线都可放 AgentCore | WS 端到端连通 |
| **B3 Transcribe 管线** | Transcribe→Bedrock→Polly 全流式 + 工具 + 打点写 DynamoDB | 该方案实时字幕 + 精确三段时间 |
| **B4 Nova Sonic 管线** | 按 B0 决策接入(侧车代理/Node 重写) + S2S 打点 | 该方案能对话 + E2E/首音时间 |
| **B5 埋点统一** | 三方案 turnId 贯通同一张表；补 chatbot-demo 缺的计时(其 `.kiro/specs/observability-traces` 是蓝图) | 一行数据含各方案该有的时间戳 |
| **B6 面板对比** | 面板按 pipeline 渲染；加"方案"维度的 P50/P95 并排 | 三方案延迟当场并排对比 |
| **B7 打磨** | barge-in、端点调优、8 分钟会话上限处理、成本核算、压测 | 1 秒级目标验证 |

## 成本 / 风险
- **托管优先用 AgentCore Runtime**：避免自建 Fargate/ALB 的运维与常驻成本；工具复用现有 MCP Gateway。仅当某条管线不适合 AgentCore 时才回退 Fargate。
- **语言栈混合**：connect-demo 是 Node/CDK-JS，Nova Sonic 核心是 Python；走 AgentCore（复用 chatbot-demo 的 Strands 容器）可基本回避 Node 重写双向流的坑。
- 自控管线要**自己实现 turn-taking / barge-in / 断线重连**（Connect 本来托管这些）。
- Nova Sonic：~8 分钟会话上限、区域受限、无多会话续接。
- 三方案要**从零加计时层**才能公平对比（chatbot-demo 现无埋点，其 `.kiro` observability 规格可做蓝图）。

---

## 两方案怎么配合
- **A 已到头**：现 demo 定在 **Haiku 4.5 + 增强 prompt**（质量最优，延迟 ~3–3.6s，Connect 下限）。
- **B 是终局**：想启动时按 B0→B7 走。托管**首选 AgentCore Runtime**（复用 chatbot-demo 的 Strands/AgentCore 路 + 现有 MCP Gateway），最省改写、无需自建 Fargate/ALB。
- 三方案上线后，同一页面即可回答客户："同样一句话，Connect / 自控三段 / Nova Sonic 各要多久、每段卡在哪"。
