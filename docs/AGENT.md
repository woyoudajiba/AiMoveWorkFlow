# 映序 Agent 接口

映序提供 JSON CLI 和标准 MCP stdio 两个入口。二者使用同一份 26 个工具定义和执行逻辑，连接现有本地 HTTP 服务，覆盖人物身份、场景造型三视图、片段整板分镜、固定设定板模板和视频导出。所有模型密钥仍由映序应用保存；Agent 接口没有密钥配置工具，也不接收密钥参数。

## 启动本地服务

在 PowerShell 7 中运行：

```powershell
Set-Location D:\A_Electron\AiMoveWorkFlow
npm.cmd install
npm.cmd run build
npm.cmd run server
```

默认监听 `http://127.0.0.1:4318`，数据存放在项目 `data/`。先用浏览器打开此地址，使用现有美怡莱 TDL 账号登录，再在「模型连接」中配置所需模型。每个账号的作品与模型配置相互隔离。状态中的 `Configured` 仅表示已填写凭据，不表示供应商认证已验证。

Agent 首次调用绑定此实例当前已登录的账户会话；没有登录时返回 `AUTH_REQUIRED`。退出或更换账号后，已有 MCP / 长驻 Agent 返回 `AUTH_REQUIRED` 或 `SESSION_CHANGED`，需要重新启动该 Agent 连接。不会自动重连到另一个账号，也不接收账号密码、云端令牌或登录命令。一次性 CLI 每次启动绑定当前账号；跨多条 CLI 的自动流程应避免同时切换账号。

退出会阻止新的操作；已接受的生成任务仍在原账号后台完成。重新启动应用后，只在对应账号登录并进入工作台时恢复其任务。桌面端可通过 Windows 加密记住登录；纯 Node 服务仅保存当前进程会话。旧版作品通过工作台的「导入旧版作品」主动归属一次，原件保留且不会复制旧密钥。

`studio_status` 同时返回六个文字模型的公开目录、推荐标记和配置状态；`analyze_project` 使用工作台当前所选模型。Coding Plan 与 Token Plan 独立配置，Agent 不接收或输出两组密钥。更换文字模型请在「模型连接」操作。

需要独立数据目录时，可在启动前设置 `$env:AI_FRAME_DATA_DIR='D:\YourStudioData'`。同一数据目录只运行一个应用实例。已有服务可直接使用，无需为 Agent 重启；CLI/MCP 的 `--url` 必须指向需要操作的那个实例。桌面端可能使用不同端口，不要把另一个实例的数据误当成当前作品。

Agent 仅接受字面形式 `http://127.0.0.1:<port>`，默认端口为 `4318`。外部主机、`localhost` 别名、HTTPS、路径、凭据、查询参数和重定向均被拒绝；不会把小说或素材转发到重定向地址。模型调用由本地应用执行。

## JSON CLI

为保证 stdout 只有 JSON，自动化调用直接运行 `node`，或对 npm 使用 `--silent`。从任意工作目录运行时可使用脚本绝对路径。

```powershell
node D:\A_Electron\AiMoveWorkFlow\scripts\agent-cli.mjs --url http://127.0.0.1:4318 list
'{}' | node D:\A_Electron\AiMoveWorkFlow\scripts\agent-cli.mjs call studio_status
```

`list` 返回工具描述、严格 JSON Schema 和 MCP annotations。调用格式：

```text
node scripts/agent-cli.mjs [--url http://127.0.0.1:4318] call <tool_name> [--input args.json]
```

参数可通过 UTF-8 JSON 文件或标准输入传入，不放在命令行字符串里拼接。输入上限 1 MiB；小说正文仍受应用 120000 字符限制。未提供 `--input` 时读取标准输入，空输入等价于 `{}`。

创建作品示例：

```powershell
$projectArgs = @{
  title = '末班灯'
  novel = Get-Content -Raw -Encoding utf8 D:\Stories\末班灯.txt
  style = '写实电影，自然光影，保持角色一致'
  visualStyle = 'photorealistic'
  aspectRatio = '9:16'
  durationMode = 'auto'
  duration = 30
}
$projectArgs | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 D:\Stories\project-input.json
node D:\A_Electron\AiMoveWorkFlow\scripts\agent-cli.mjs call create_project --input D:\Stories\project-input.json
```

成功输出一行 JSON，例如：

```json
{"ok":true,"tool":"create_project","result":{"project":{"id":"作品ID","title":"末班灯"},"reused":false}}
```

失败输出 `{"ok":false,"error":{"code":"...","message":"..."}}`，退出码为 `1`。成功退出码为 `0`。JSON 输出包含完整字段，上面的示例省略了其余作品字段。

## MCP 配置

使用官方 `@modelcontextprotocol/sdk` 1.x 的 `McpServer`、`StdioServerTransport`，未自行实现 JSON-RPC。以下配置可复制到支持 stdio MCP 的调用端；本项目不会自动修改任何全局配置。

```json
{
  "mcpServers": {
    "aiframe-studio": {
      "command": "node",
      "args": [
        "D:\\A_Electron\\AiMoveWorkFlow\\scripts\\agent-mcp.mjs",
        "--url",
        "http://127.0.0.1:4318"
      ]
    }
  }
}
```

不同调用端的外层配置名称可能不同，`command/args` 保持上述值。若调用端找不到 `node`，将 `command` 改为本机 `node.exe` 的绝对路径。这里不配置 API Key、Token 或环境凭据。MCP 进程本身不启动/停止映序 HTTP 服务；stdout 只写协议，启动错误写 stderr。

MCP 成功调用同时返回 JSON 文本 `content` 和相同的 `structuredContent`：`{ok:true,result:...}`。业务失败使用 `isError:true`；参数不符合 Schema 时由 SDK 拒绝。调用端应检查错误状态，不以收到一次响应当作生成完成。

## 工具

所有对象采用严格字段白名单；额外字段会报错。ID 只接受字母、数字、下划线和连字符，不能传本机路径或任意 URL。

| 工具 | 必填参数 | 行为 |
| --- | --- | --- |
| `studio_status` | 无 | 读取作品列表及模型配置标记 |
| `list_board_templates` | 无 | 读取三种固定模板及每页分镜、三视图容量；只读 |
| `create_project` | `title, novel` | 本地创建；可选 `style, visualStyle, sourceType, narrativeMode, aspectRatio, duration, durationMode, generationMode`；`visualStyle` 支持 `photorealistic`（仿真人/写实）、`2d-animation`（2D 动画）和 `3d-animation`（3D 动画），默认 `photorealistic`，并作为分析、生图和视频的硬媒介约束；`style` 只补充色调、时代和镜头气质。`narrativeMode` 支持 `auto`、`narrator`（广告/纪录片/新闻/论文旁白）和 `protagonist`（主角观察视角），默认 `auto`；默认 `segment-board`，兼容旧作品时传 `legacy-shot`；新作品 `aspectRatio` 仅允许 `9:16` |
| `get_project` | `projectId` | 默认不返回小说全文；显式 `includeNovel:true` 才返回 |
| `analyze_project` | `projectId` | 付费分析；明确“第 N 集”的剧本会按剧集保留片段边界并记录群众演员信息；已有结果/进行中/待核实分析时复用 |
| `reset_duration` | `projectId, duration` | 已分析作品显式切换 15/30 秒并清空当前派生规划；保留原稿和历史台账；有活动任务时拒绝，之后必须重新分析 |
| `update_character` | `projectId, characterId, patch` | 更新 `name, role, aliases, appearance, evidence` 的非空子集 |
| `generate_character` | `projectId, characterId` | 付费定妆；可选 `regenerate:true` 明确重做 |
| `approve_character` | `projectId, characterId, reviewedVersion` | 确认已经实际检查的角色版本 |
| `create_scene` | `projectId, name` | 创建连续时空和服装状态；可选 `description` |
| `update_scene` | `projectId, sceneId, patch` | 更新 `name, description`，使该场景造型与分镜过期 |
| `create_look` | `projectId, sceneId, characterId, name, appearance` | 以已确认的当前人物身份创建造型草稿；同场景人物唯一 |
| `update_look` | `projectId, lookId, patch` | 更新 `name, appearance`，仅使匹配场景和人物的分镜过期 |
| `generate_look` | `projectId, lookId` | 生成本场景正面/侧面/背面三视图；可选 `regenerate:true` |
| `approve_look` | `projectId, lookId, reviewedVersion` | 实际检查当前三视图后审核，不生成分镜或视频 |
| `update_shot` | `projectId, shotId, patch` | 更新 `sceneId, scene, action, camera, movementId, movementPlan, transitionPlan, dialogue, sourceEvidence, backgroundActors, characterIds, duration, trimStart` 的非空子集 |
| `generate_shot` | `projectId, shotId` | 付费单镜图片；可选 `regenerate:true` |
| `approve_shot` | `projectId, shotId, reviewedVersion` | 确认已检查的图片版本，不提交视频 |
| `approve_segment_board` | `projectId, segmentId, reviewedVersion` | 确认已检查的整段分镜板及全部裁切画面；只接受当前整板版本 |
| `generate_video` | `projectId, shotId` | 付费 MiniMax / 火山方舟视频；按所属片段模式保留整板或全部逐镜审核门禁，并在视频阶段上传人物参考图；可选 `regenerate:true` |
| `get_jobs` | `projectId` | 可选 `jobId` 读取一个任务；只读 |
| `resume_job` | `projectId, jobId` | 恢复原视频查询或图片成功回执下载，不重新生成 |
| `generate_segment_images` | `projectId, segmentId` | `segment-board` 片段只提交一次完整整板生图，AI 决定 3–12 个镜头并由服务端裁切；旧 `legacy-shot` 作品才逐镜补缺 |
| `generate_segment_videos` | `projectId, segmentId` | 审核后补缺视频；旧版视频须逐镜明确重做 |
| `set_board_template` | `projectId, segmentId, templateId` | 保存模板偏好；不改镜头/审核/素材版本，导出进行中拒绝切换 |
| `storyboard_preview` | `projectId, segmentId` | 本地导出分页设定板、CSV、manifest；可选 `templateId` 仅覆盖本次预览 |
| `export_segment` | `projectId, segmentId` | 当前片段全部视频齐备后本地合成；复用明确匹配当前模板的最新有效导出 |

生成、编辑、审核等操作返回 `{project,reused,reason?}`。`get_project` 直接返回作品。`get_jobs` 返回 `{projectId,jobs}` 或 `{projectId,job}`。`storyboard_preview` 返回 `templateId`、兼容第一页的 `gridUrl`、全部 `pages` 以及 `manifestUrl/csvUrl`。每个 page 包含 `number, gridUrl, shotNumbers, lookIds, continuation, layout`；读取和交付时遍历全部页面，不能只交付第一页。所有 URL 都是本作品的本地相对路径，加上实际 `--url` 即可读取。媒体存在不代表已通过人工验收。

模板 ID 固定为 `classic-nine`（每页 9 镜、2 组造型）、`eight-one`（8 镜、1 组造型）、`three-three`（3 镜、3 组造型）。每组造型是同场景同角色的一张正/侧/背三视图。旧 `legacy-shot` 作品仍按九镜兼容；新的 `segment-board` 片段由 AI 决定 3–12 个镜头，模板只约束审核板排版和页面容量，整板生图本身只生成镜头面板，不添加角色参考区。同页只放同一连续场景，镜头或造型超容量时自动续页；空槽保留占位。多页文件名为 `001-01.jpg` 等，成片仍为 `001.mp4`。

## 一次制作流程

1. `studio_status` 确认连接到正确实例，`create_project` 建立作品。
2. `analyze_project` 提交一次；用 `get_jobs/get_project` 查询，直到任务完成。不要循环调用生成工具代替查询。
3. 修订角色，调用 `generate_character`。读取完成后的角色 `reference`、`version` 和 `referenceVersion`，实际查看图片后才调用 `approve_character`，传所检查的 `reviewedVersion`。
4. 旧 `legacy-shot` 作品检查 `scenes`、`looks` 和各镜 `sceneId`，按需生成并审核角色身份和场景三视图。新的 `segment-board` 作品不把角色图片上传到分镜生图；整板只依据镜头计划和文字造型事实生成面板，人物身份参考图在视频提交时再上传。
5. 读取片段后调用 `generate_segment_images`。`segment-board` 只创建一个整板任务，等待 `storyboard` 完成后检查整板和每个竖屏裁切镜头；确认读取到的 `storyboardImageVersion` 后调用 `approve_segment_board`。`legacy-shot` 仍可对单镜调用 `generate_shot`，并在图片完成后逐镜 `approve_shot`。图片 API 成功不等于人工审核。
6. 整板审核或全部逐镜审核完成后调用 `generate_segment_videos`；视频完成后检查播放和剪辑，最后 `export_segment`。`storyboard_preview` 只用于导出/检查排版，不改变审核状态。

一张分镜图应只表示一个代表性时刻。若模型把“先特写、再拉远”等时序描述画成上下分屏，先用 `update_shot` 将动作和机位收敛为同一时刻、同一景别，再对该镜显式 `generate_shot(regenerate:true)`；检查结果后重新导出设定板。`segment-board` 的完整视频请求把按顺序的 9:16/16:9 裁切图作为视觉事实，超出供应商图片上限时使用本地无标签顺序参考图，并按供应商能力保留第一镜和角色参考图；整板永不上传。`legacy-shot` 只发送独立分镜原图。两种模式都禁止把审核板文字、边框、参考标签或其他镜头发展成视频内容。

参考审核参数：

```json
{"projectId":"作品ID","shotId":"分镜ID","reviewedVersion":3}
```

明确重做一个分镜：

```json
{"projectId":"作品ID","shotId":"分镜ID","regenerate":true}
```

## 幂等、版本与错误

- 当前同版素材默认复用。人物身份和场景造型通过 `referenceVersion`、分镜图片通过 `imageVersion`、视频通过 `videoVersion` 与对象 `version` 比较。旧作品缺少素材版本依据时，不把 URL 存在当作当前素材；返回 `STALE_ASSET`，实际检查后再决定是否显式付费重做。
- 造型编辑只使匹配 `sceneId + characterId` 的分镜失效；身份编辑使该人物所有造型和关联分镜失效。场景名称/说明改变使该场景造型及分镜失效。旧版异步响应不能覆盖当前内容。
- `set_board_template` 只改变片段的 `boardTemplateId`，不调用模型、不撤销审核或素材版本。旧数据缺字段时读作 `classic-nine`；未知模板返回 `INVALID_INPUT`。正在导出同一片段时返回 `ACTIVE_JOB`。模板切换保留历史导出；`export_segment` 只复用明确带有当前 `templateId` 的最新快照，无模板标记或其他模板的旧快照不作当前交付证据。重新排版仅本地计算。
- 当前 `queued/running/unknown` 任务优先复用，即使传 `regenerate:true` 也不会绕过待核实任务。明确失败后可以再次显式调用生成；客户端不自动重试任何 POST。
- 单镜生成携带 `expectedVersion` 与 `reuseExisting`，服务端在锁内检查，避免 GET 与 POST 之间素材变更导致重复收费。审批携带 `reviewedVersion`，不匹配返回 `STALE_INPUT`。
- `legacy-shot` 批量图片/视频先检查整段现有素材版本，只对本次快照中的缺失且无当前任务的分镜逐镜提交；`segment-board` 图片生成只创建一个当前片段的 `storyboard` 任务。每次提交同样携带版本保护；遇到版本冲突或其他失败即停止后续提交，已经提交的任务仍保留；先调用 `get_jobs/get_project` 核对，再决定是否继续，不自动重试。单镜视频接口仍检查所属片段的全部镜头审核状态。
- `SUBMISSION_UNKNOWN`、网络中断或超时后先读 `get_jobs`；有可恢复任务时使用 `resume_job`。没有成功回执的图片提交仍可能需要供应商核实，不会通过重发 POST 猜测结果。
- `regenerate:true` 可能产生新的模型费用，并使旧审核/关联视频失效。批量工具只补缺失素材，不批量重做；已有陈旧或版本未知素材会返回 `STALE_ASSET`。
- 视频审批和提交始终分开，Agent 不会为付费生成自动审批素材。最终导出仍执行服务端的全部镜头齐备、审核与版本门禁；新片段模式不假定固定九镜。
- CLI/MCP 不提供删除项目、部署、修改凭据、执行任意 Shell 或上传任意外部 URL 的工具。

## 验证与官方依据

```powershell
node --test tests/agent.test.mjs tests/agent-looks.test.mjs tests/agent-templates.test.mjs tests/agent-transports.test.mjs
npm.cmd run check
```

测试包含外部地址/重定向拒绝、严格字段校验、秘密字段隐藏、版本审核、默认复用、未知提交不重发，以及真实子进程 CLI、正式 SDK 客户端的 `initialize → tools/list → tools/call`。这些接口测试使用本地测试项目，不调用付费模型；真实小说生图验收需另看项目的实测记录。

实现依据：[官方 TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)、安装包 README 与 `server/mcp.d.ts`、`server/stdio.d.ts`、`client/stdio.d.ts`。依赖版本已写入 lockfile。

## 内置改编与连续性指导

0.2.1 的 Agent 调用与桌面共用 server/providers.mjs 和 server/prompt-guidance.mjs。analyze_project 自动应用证据与揭示顺序、动作因果和有界前文上下文；generate_character / generate_look / generate_shot / generate_segment_images / generate_video 自动应用对应身份、片段妆造、三视图及同场接续规则。无需 Agent 另行传入原始 skill 文件或额外工具。相邻同场景且人物集合相同才使用前镜文字计划；跨场景不传，当前分镜和当前造型优先。前镜文字计划不是视觉审核证据。所有 approve 工具仍需真实人工检查和明确当前版本，不能因提示词含自检就自动批准。
