# 控制台补充步骤（CDK 覆盖不到的部分）

`npm run deploy` 会自动建好并**已实机验证**（几乎全链路 CDK 化）：
- 工具 Lambda、AgentCore Gateway(MCP)、Connect 实例、web calling 后端 + 前端（CloudFront→S3/API Gateway），**端到端 web call 已打通**（`/webcall` 返回真实 Chime 加入信息）。
- **MCP server 注册**（`AWS::AppIntegrations::Application`，Namespace = Gateway ID）+ **APPLICATION 集成关联**。
- **Lex V2 bot**（Bot + Version + Alias）+ **LEX_BOT 集成关联**。
- **Contact Flow**（`AWS::Connect::ContactFlow`，`State=ACTIVE` 已发布，注入 bot alias ARN）。
- **（`-c enableAiAgent=true` 时）orchestrator AI agent 全链路**：`AWS::Wisdom::Assistant` + `AIPrompt`(ORCHESTRATION, Claude 4.5 Haiku) + `AIAgent`(ORCHESTRATION) + WISDOM_ASSISTANT 关联 + `AWS::Connect::SecurityProfile`（MCP 工具授权）。

剩下必须在控制台/运行时做的只有两件小事（都是「运行时依赖」，CFN 无法在部署期完成）：
1. **Gateway 的 JWT 入站授权**——已 CDK 化，但需两轮部署（见第 2 节）。
2. **把 MCP 工具附到 AI agent** + **bot 上启用 agentic voice / AI agent intent**——见第 3、4 节。

开始前记下 `cdk deploy` 输出：`ConnectInstanceId`、`GatewayUrl`/`GatewayArn`、`WebAppUrl`、`BotAliasArnInUse`、`ContactFlowIdInUse`。

---

## 1. 开通 Connect Customer 与 agentic voice

1. 确认 Connect 实例已启用 **Connect Customer**（agentic voice 的前置）。
   参见 `enable-nextgeneration-amazonconnect.html`。
2. Bedrock 控制台：在目标区（`us-west-2`）**开通所需基础模型的访问**（Model access）。

## 2. Gateway JWT 入站授权（也由 CDK 管理，两轮部署）

Gateway 的 `AuthorizerType=CUSTOM_JWT` + `AuthorizerConfiguration.CustomJWTAuthorizer` 已通过 CDK 支持并**实机验证**。但 AgentCore 有两条硬约束需要两轮部署：
- Gateway 一旦创建，**AuthorizerType 不可改**（服务端明确拒绝，只能用新 Gateway 替换）。
- AppIntegrations MCP application 的 access URL 与 Gateway 绑定，也无法迁移。

因此当从 `NONE` 切到 `CUSTOM_JWT` 时，CDK 会**同步替换** Gateway + Target + MCP application + Association 一整套（通过在启用 JWT 时对这些资源的逻辑 id 加 `Jwt` 后缀）。

**部署流程**：

1. 首次 `npm run deploy` → Gateway 用 `NONE`，输出 `GatewayArn`。
2. 切到 JWT（Gateway 会重建，得到新 Gateway ID）：
   ```bash
   npm run deploy -- \
     -c jwtDiscoveryUrl=https://<connect-instance-alias>.my.connect.aws/.well-known/openid-configuration \
     -c jwtAudience=placeholder-audience
   ```
   记下输出里的新 `GatewayArn`——ID 就在里面（例如 `connect-voice-demo-gateway-jwt-<xxx>`）。
3. 用真实 Gateway ID 精确回填 audience（**in-place 更新，不再重建 Gateway**）：
   ```bash
   npm run deploy -- \
     -c jwtDiscoveryUrl=https://<connect-instance-alias>.my.connect.aws/.well-known/openid-configuration \
     -c jwtAudience=connect-voice-demo-gateway-jwt-<新后缀>
   ```

参考 `3p-apps-mcp-server.html`：JWT 的 `aud` claim = Gateway ID，Discovery URL = Connect 实例的 OIDC endpoint。

## 3. orchestrator AI agent（已由 CDK 建好，仅需附工具 + 设默认）

传 `-c enableAiAgent=true` 时，CDK 已建好：`ConnectVoiceDemo-assistant`（Wisdom Assistant，已 WISDOM_ASSISTANT 关联到实例）、`ConnectVoiceDemo-orchestration-prompt`（ORCHESTRATION prompt）、`ConnectVoiceDemo-orchestrator`（ORCHESTRATION AI agent）、`ConnectVoiceDemo-mcp-tools`（security profile，已授权 `demo-tools___get_current_time` / `demo-tools___get_weather`）。

**security profile 已由 CDK 关联到 AI agent**：通过 `connect:AssociateSecurityProfiles`（`EntityType=AI_AGENT`）的 `AwsCustomResource` 完成——`AWS::Wisdom::AIAgent` 的 CFN 没有这个字段，但 API 有，所以也 CDK 化了（custom resource 角色需 `wisdom:GetAiAgent` + `connect:AssociateSecurityProfiles`，已在 stack 里授予）。

**唯一还需在控制台手点的**：把 MCP 工具挂到 AI agent 的 **Tools** 区域。原因是 AI agent 的 `ToolConfigurations` 在创建/更新时会让 QConnect 去 Gateway 枚举 MCP 工具校验；Gateway 是 `CUSTOM_JWT`，只有当 JWT 信任链真正就绪、Connect 能调用 Gateway 时工具才可枚举。步骤：

1. 先确保第 2 节的 JWT 授权已配好、Connect 能真正调用 Gateway（工具可被枚举）。
2. Connect 控制台 → **AI agent designer** → 打开 `ConnectVoiceDemo-orchestrator`。security profile `ConnectVoiceDemo-mcp-tools` 已关联（CDK 完成），**Tools** 区域添加 `demo-tools___get_current_time`、`demo-tools___get_weather`；保留默认 `Complete` / `Escalate`。
   - 若报 insufficient permissions：把 `ConnectVoiceDemo-mcp-tools` 这个 security profile 也分配给你**登录用的用户**（工具调用按 AI agent + 登录用户权限的组合鉴权）。
3. **AI Agents 页** → **Default AI Agent Configurations** → 把 `ConnectVoiceDemo-orchestrator` 设为 **Self Service** 默认。

（prompt 内容已内嵌在 CDK 建的 AIPrompt 里；若要改，编辑 `lib/connect-demo-stack.js` 的 `promptYaml` 或直接在控制台调。`prompts/orchestration-prompt.md` 是同一份内容的可读版。）

## 4. Lex bot 与 Contact Flow（已由 CDK 建好）

Lex V2 bot（Bot/Version/Alias）、LEX_BOT 关联、以及 Contact Flow（`State=ACTIVE` 已发布、已注入 bot alias ARN）都由 `npm run deploy` 自动建好，web call 端到端已打通。**无需在控制台建 bot 或导入 flow。**

只需在控制台对**这个已建好的 bot** 补两项 agentic self-service 配置：
1. 在 bot 上**启用 Connect Customer AI agent intent**（把 bot 接到第 3 步的 orchestrator AI agent）。
2. **Speech Configuration**：Voice Provider 选 **Amazon Connect agentic voice**，Speech model 选 **Advanced**。
   - ⚠️ 不要选 **Nova Sonic**（Speech-to-Speech）——本 demo 的目的就是替换掉要下线的 Nova Sonic。

（如果你想用自己在控制台单独建的 bot 替换 CDK 建的，部署时传 `-c botAliasArn=<你的 bot alias ARN>`。）

## 5. 测试

打开 `WebAppUrl` → 用 Chrome/Edge/Firefox（**不支持 Safari 的部分能力**）→ 点 **Start** 并授权麦克风 → 说：

- "What time is it in Tokyo?"
- "What's the weather in Seattle?"

应听到 agentic voice 播报结果；在 CloudWatch 里能看到工具 Lambda 的调用日志。

## 清理

```bash
npm run destroy
```

会删掉 CDK 建的所有资源（含 Lex bot、Contact Flow、MCP 注册、AI agent 全链路、security profile）。若在控制台手动改过 AI agent 的工具挂载，这些改动随 AI agent 一起删除，无需单独清理。
