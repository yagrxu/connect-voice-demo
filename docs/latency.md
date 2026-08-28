# 延迟丈量与模型选型（读我先）

> 一句话：本 demo 跑在 **Amazon Connect agentic voice** 上，ASR / LLM / TTS 三段都在
> Connect 托管的黑盒里，**无法从我们自己的代码里逐段打点**。能近实时准确测到的只有
> **端到端回合延迟**（用户说完 → AI 开口）。要"逐段丈量 + 运行时切模型"，需要换成自建管线
> （见最后一节）。

## 1. 为什么 ASR / LLM / TTS 拆不出来

看 [`architecture.md` 的分工表](architecture.md)：ASR、TTS 由 Connect agentic voice 托管，
"大脑"（LLM/多步推理）由 Connect orchestrator AI agent 托管。**这三段都不在我们写的代码里跑**，
所以拿不到"ASR 定稿""LLM 首 token（TTFT）""TTS 首音频块（TTFB）"这些边界时间戳。

代码里已经把这个约束写死了——`web/app.js`（文件头注释）：

> Connect only gives us a **"dumb" audio stream** — it does NOT push
> "user finished / AI thinking / AI speaking" events. So we **INFER** conversation
> state from audio levels (mic vs speaker).

也就是说，现在 UI 上的 `Listening / Thinking / Speaking`（`web/app.js` 的 `startPhaseLoop`）
**不是真实计时**，是靠 Chime SDK 的麦克风/扬声器**音量水平猜**出来的相位，不代表任何一段的真实耗时。

## 2. 这个架构下能测什么、测不了什么

| 指标 | 能测? | 从哪来 | 实时性 | 备注 |
|---|---|---|---|---|
| **端到端回合延迟**<br>（用户停说 → AI 开口） | ✅ 已实现 | 客户端 Chime 音量事件：`lastMicActive`（用户停）→ 扬声器音量上升沿（AI 开口），见 `web/app.js` 的 `startPhaseLoop` + `recordTurnLatency` | 近实时 | **客户体感最强的数**。UI 已有"回合延迟"面板：末次值 + 每回合 P50/P95 + 柱状趋势（绿 ≤1.5s / 橙 ≤3s / 红更慢）。开场问候不计入 |
| **工具调用延迟**<br>（MCP 工具 Lambda 耗时） | ✅ | 我们自有的 `lambda/tools/handler.py`，可自行打点 / 看 CloudWatch Lambda Duration | 近实时 | 只是工具执行，**不是** ASR/LLM/TTS |
| **粗略"响应延迟"**<br>（客户末句 → AI 首句） | ⚠️ 粗略 | Connect AI-agent 的 `TRANSCRIPT_ORCHESTRATION_MESSAGE` 日志里每条带 `event_timestamp`（`lambda/webcall/handler.js` 的 `getTranscript`）；取最后一条 CUSTOMER 与下一条 BOT 的时间差 | **非实时**（CloudWatch 摄取滞后数秒，浏览器每 1.5s 轮询） | 这个差值把 ASR 定稿 + 端点检测 + LLM + TTS 首字节**全揉在一起**，拆不开，且滞后 |
| **ASR 单段延迟** | ❌ | 托管在 Connect，无边界事件 | — | — |
| **LLM 单段 / TTFT** | ❌ | 托管在 orchestrator AI agent | — | — |
| **TTS 单段 / TTFB** | ❌ | 托管在 agentic voice | — | — |

> Connect / Lex 侧确有一些 CloudWatch 指标和 Contact Lens 会话分析，但**不提供逐回合的
> ASR/LLM/TTS 分段延迟**。若要挖 Connect 自带的组件级指标，需在目标区的 CloudWatch /
> Connect 控制台自行核实有哪些可用——本 demo 的代码路径里取不到分段值。

**回合延迟怎么算的（已实现）**：`web/app.js` 的 `startPhaseLoop` 里，麦克风音量活跃时持续记
`lastMicActive`（用户最后说话时刻）并标记 `turnOpen`；一旦检测到扬声器音量的**上升沿**（AI 开口）
且 `turnOpen` 为真，就记一次 `now - lastMicActive` 为该回合延迟，然后关闭 `turnOpen`（保证一轮只记一次，
开场问候因用户尚未开口被跳过）。UI 面板显示末次值、P50/P95、最近 24 回合柱状趋势。
**注意这是从音量推断、不是服务端时间戳**，含 ±几百 ms 误差，且打断（barge-in）等场景可能不准——
用于横向趋势和量级判断足够，不要当精确基准。要精确到毫秒、且分段，走第 4 节自建管线。

## 3. 模型切换：不是运行时下拉，是改配置重部署

LLM 型号写死在 AI agent 的 prompt 配置里——见 [`console-setup.md`](console-setup.md)：
`AIPrompt`(ORCHESTRATION) 当前用的是 **Claude 4.5 Haiku**。

- **换 Claude 型号** = 改 `lib/connect-demo-stack.js` 里的 AIPrompt/AIAgent 配置（或控制台里调）
  → **重新部署**。没有"每轮切模型"的下拉。
- **想 A/B 比较不同 Claude 的延迟**：分别部署两套配置，各自跑几轮，对比第 2 节的
  **端到端回合延迟分布**（P50/P95）。这是这个架构下唯一可行的模型选型对比方式，粒度是回合级、不是分段级。

## 4. 如果客户真的需要"逐段延迟 + 运行时切模型"

那就**不该用 Connect agentic voice**，得回到**自建管线**——三段都在你自己的代码里跑，才能逐段打点、才能运行时切模型：

```
浏览器麦克风 ──PCM over WS──▶ 自建网关 ──▶ Transcribe 流式 ──▶ Bedrock(Claude, 可切) ──▶ Polly
   ▲                            │  每个接缝 hrtime 打点：                                 │
   │                            │  ASR定稿 / LLM首token(TTFT) / TTS首块(TTFB)             │
   └──────── 音频块 + SSE 延迟事件 ◀┴────────────────────────────────────────────────────┘
```

- 能拿到的指标：ASR 定稿延迟、端点检测延迟、LLM TTFT、TTS TTFB、端到端体感延迟。
- 能做的交互：UI 下拉切 Claude 型号，实时看每段延迟怎么变（真正的选型/调试台）。
- **取舍**：Connect 托管的 barge-in 打断、回合切换、电话接入等能力要**自己重建**；运维和合规也从"托管"变成"自持"。
- 参考姊妹项目 [`../chatbot-demo`](../chatbot-demo)（原 Nova Sonic 端到端方案，注意 Nova Sonic 即将下线），
  或基于 Transcribe streaming + Bedrock + Polly 新搭。

**选型建议**：客户若只关心"AI 回话有多快"，Connect 方案 + 第 2 节的回合延迟表就够，省去自建成本；
客户若要按 ASR/LLM/TTS 分别调优、并频繁横比不同模型，自建管线是唯一能满足的形态。
