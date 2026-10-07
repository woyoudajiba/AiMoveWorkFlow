# 映序验证记录

## 0.2.1 参考技能融合（2026-10-02）

- 已把参考资料中的忠实改编、原文证据/揭示顺序、身份与造型分层、同高同地线三视图、动作因果和同场连续性纳入实际 provider 请求；桌面、JSON CLI 与 MCP 共用此路径。原资料没有作为任意可执行 skill 加载。
- 新增有界前文上下文和前镜计划的边界测试，覆盖首块/跨块、不同场景/人物隔离、长文本、Unicode和参考身份不锁服装。全量最终复测 **213/213 通过**；check、TypeScript/Vite build 和 Windows portable 构建通过。首次全量运行有一个模板媒体测试子进程退出，没有断言细节；该文件独立10/10通过、全量213/213复测通过，未据此推定根因，原始日志保留。
- JSON CLI 实际列出25个工具；包内 Agent CLI/MCP 入口和新提示词模块均存在。包内30个可比应用文件与当前源码哈希一致；共6374个文件。没有业务数据、小说、测试输出或凭据路径，第一方文本的供应商密钥字面值扫描无命中。
- 最终 portable 实际启动通过：packaged=true，显示登录页，未登录保护生效，Windows安全存储可用，六个文字预设和空凭据状态正确；Sharp PNG及FFmpeg/FFprobe静音视频组件可用。不使用真实账号密码，不访问历史作品，不提交付费模型。
- 已复制到桌面：C:/Users/www/Desktop/映序-0.2.1-win-x64.exe。151733351字节，SHA-256：351A61DC3DB366D4C727E5982A9E38933FB6F5130386B8300481D4BC4B1A540A。Authenticode为NotSigned，属于未签名本地便携构建。
- 验证记录：output/skill-integration/（tests.log、template-isolated.log、tests-final.log、check.log、windows-build.log、portable-smoke.log、package-verification.json、desktop-delivery.json、agent-tools.json）；实际启动报告在output/package-smoke/skills-0.2.1-final/result.json。
- 本轮没有UI改动，未重复桌面/移动浏览器布局验收；没有新增真实文字分析、生图或视频模型调用。提示词约束与本地回归通过不等于模型画面一致性已经通过验收。未部署云端、未创建Git提交或版本标签。

最新验证日期：2026-10-02，北京时间。本轮增加 Windows x64 便携 EXE；无云端部署、提交、分支或 Tag。

## WorkHelper 文字模型预设与 Windows 打包

- 最终交付：`C:/Users/www/Desktop/映序-0.1.0-win-x64.exe`，151752573 字节；桌面副本与构建产物 SHA-256 均为 `B39B89E235F95F8A7A6605BE871219C321721E97F43126622EB33841B91A990A`。Authenticode 状态为 `NotSigned`，属于未签名本地便携构建。
- 实际启动最终 portable EXE，通过隔离用户目录确认 `packaged:true`、默认 Qwen 3.7 Plus、六预设及推荐标识齐全、全部凭据为空、作品数为 0、Windows 加密存储可用；Sharp 生成/解码 64×96 PNG，FFmpeg 生成并完整解码 144×256 / 1 秒 MP4，FFprobe 元数据正确，React 主界面 DOM 加载完成。隐藏窗口截图可能保留加载首帧，最终视觉布局证据使用同一前端产物的浏览器截图。
- 检查打包目录共 6370 个文件，26 个应用代码/前端/Agent 文件与当前源码逐项 SHA-256 一致；业务数据、环境文件、凭据和测试输出均未打入。应用文本中的供应商 Key 特征扫描为 0，不表示全面第三方依赖安全审计。Agent CLI/MCP 入口与 Sharp / FFmpeg / FFprobe 均在包内。
- 修复启动自检复用旧 `result.json` 的误报风险：每次启动前删除旧报告，只有新报告、成功退出、正确模型目录和空凭据状态全部成立才通过；同时清除外部 FFmpeg 覆盖，确保测试包内组件。正式构建日志、包核验、启动结果与桌面校验分别在 `output/llm-presets/windows-build.log`、`package-verification.json`、`portable-smoke.log`、`desktop-delivery.json`，原始启动报告在 `output/package-smoke/final-portable-20261002/result.json`。
- 完整接入 WorkHelper 六个模型预设：Qwen 3.7 Plus、Qwen 3.6 Plus、Qwen 3.8 Max、Qwen 3.8 Flash、DeepSeek V4.1 Flash、DeepSeek V4 Pro；两个 Flash 保留快速推荐。模型 ID 与两类固定路由核实于 WorkHelper 客户端和对应云端源码，只复用公开目录，不复制其他项目密钥。
- Coding Plan / Token Plan 独立密钥，旧配置兼容；当前模型决定分析门禁，一次分块分析保持提交时的模型。回归覆盖全部六项路由、无跨服务借用密钥、模型选择保存/读取、HTTP 配置边界和公开响应脱敏。补充 Agent 新增 Token Plan 字段的递归脱敏回归，先验证失败再修复通过。
- 完整 `npm.cmd test` **150/150 通过**；`npm.cmd run check` 与 TypeScript/Vite 构建通过。浏览器使用新后端和隔离数据，在 1440×1000 与 390×844 验证选择、刷新保留、两组空密码框、配置状态与分析按钮。窄屏 `scrollWidth=390`，无横向溢出；console error/warn 为 0，前端脚本与样式 HTTP 200。
- 浏览器配置使用无效测试值，只验证保存和界面门禁，没有点击分析；测试作品任务数为 0。证据在 `output/llm-presets/verification.json`、`tests.log`、`models-desktop.jpg`、`models-mobile.jpg` 与 `models-configured-desktop.jpg`。
- 使用 `electron-builder 26.16.1`、本地已安装 Electron 44.5.1、Windows x64 portable；文件白名单仅带运行代码、Agent 入口和生产依赖。正常数据位置固定 `%APPDATA%\aiframe-studio\studio`，诊断使用独立数据目录并清空外部模型凭据环境变量。构建不需要新电脑安装 Node.js、Sharp、FFmpeg 或 FFprobe。
- 本轮没有向任何真实模型提交付费请求。新增 Token Plan 模型的真实账号权限、额度、结构化结果质量仍未验收；既有《末班灯》图片保持待人工审核，未自动提交视频任务。Windows 加密可用性测试不能替代真实密钥保存、重启和调用的完整验收。

## 分镜审核易用性改进

- 页面名称统一为“分镜审核”，模板卡片按实际连续场景、镜头与角色数量展示页数、造型续页和空位；可展开逐页镜号及空槽。沿用真实《末班灯》样片得到经典九镜 1 页、八镜单角 4 页（2 页造型续页）、三镜精看 3 页，与实际媒体导出一致。
- 失败提示按当前输入版本的最新任务计算，旧失败保留在历史中；当前 `unknown` 和进行中任务始终保留阻塞保护，后续成功不会遮蔽未决付费请求。
- 审核板图片增加单页重载。在隔离测试副本中临时移开第 3 页原图，浏览器出现加载失败提示；恢复文件后点击“重新加载本页”，同一个预览的第 3 页恢复为 3616×1592，无新导出或模型任务。
- 未创建项目与五类编辑草稿在当前浏览器暂存 7 天。验证 7000 字小说取消/重开及刷新恢复，创建成功后新建表单清空；已有作品正文与标题在新页面和刷新后恢复，手动保存后清除暂存。安全副本不会因超长或含凭据的新输入而被删除；已分析项目的正文冲突保持可复制，不会被仅保存标题操作丢弃。两个标签页分别修改不同作品后刷新，两份草稿均可恢复；每次只合并当前标签页真正修改或删除的对象，同一对象同时编辑仍采用最后写入值。
- 浏览器检查覆盖 1440×1000 和 390×844。窄屏页面 `scrollWidth=375 <= 390`，桌面 `1425 <= 1440`；11 张当前可见素材均成功加载，正常页面没有相关 console warning/error。加载失败测试的一次预期 404 单独记录，不视为正常页面回归。
- 当前验收实例为 `http://127.0.0.1:4322`，隔离数据位于 `output/review-usability/data/`，可用 `node output/review-usability/start-review.mjs` 重启。真实源样片的镜头、角色、造型和任务均逐项比对一致；九镜仍未审核、视频任务为 0。实例未配置任何外部模型，本轮没有付费提交。
- 规格见 [REVIEW-USABILITY-SPEC.md](REVIEW-USABILITY-SPEC.md)。证据包含 `output/review-usability/tests.log`、`verification.json`、`templates-desktop.jpg`、`templates-mobile.jpg`、`draft-mobile.jpg`。新增分页计划与真实导出对照、任务版本隔离及草稿边界回归；最终 `npm.cmd test` **142/142 通过**，`npm.cmd run check` 和 TypeScript/Vite 生产构建通过。

草稿是当前浏览器的恢复副本，不替代项目备份；清理浏览器存储会移除草稿。供应商任务恢复、图片自动视觉质检和分析后修订/重分析不属于本轮改动，真实视频成片仍需人工图片审核后验收。

## 固定模板与场景造型验收

- 新增三套固定横版模板：`classic-nine` 为 9 镜＋2 组造型，`eight-one` 为 8 镜＋1 组造型，`three-three` 为 3 张大竖图＋右侧 3 组造型。每页固定位置，空槽保留；连续场景分别分页，角色超过容量时标记造型续页，完整镜头清单不重复。
- 真实样片沿用《末班灯》的 Grsai GPT Image 2.5 素材。此前第 2、4、5 镜补齐林晚出镜登记后重生成均已完成，九镜图片版本与分镜版本一致，没有进行中或待核实任务。旧失败记录保留。样片当前包含两名角色，本轮模板没有重新调用付费模型。
- 通过实际 Agent 接口导出三模板：经典九镜 1 页、八镜单角 4 页（含第二角色造型续页）、三镜精看 3 页。8 张图片全部完整解码，媒体 HTTP HEAD 均为 200；见 `output/board-templates/` 的各模板目录、`manifest.json`、`分镜清单.csv`。三镜模板第三造型槽为空，不将另一场景的换装图当作第三个人。
- 目视检查三套真实首图，镜头文字和三视图完整排入固定区，长字段有可见截短标记。修复连续宽 ASCII 字符可能突破固定文字区域的问题，按实际渲染宽高约束每个文字图层；三模板长文本边界测试与 CSV/manifest 全文保留通过。修复前后真实样板 8 张原图＋3 张缩略图像素文件完全一致。
- 使用 Codex 内置浏览器验证 1440×1000 桌面和 390×844 窄屏：模板保存后刷新保持；三镜模板翻页显示 01–03、04–06；八镜模板显示 4 页、明确标识造型续页，第 3 页保留第 9 镜；每页下载入口可见。切换模板后不会把旧模板预览作为当前结果。
- 窄屏 `scrollWidth=375 <= innerWidth=390`，预览弹窗宽 366、内容宽 364；当前预览图已加载为 3616×1592。浏览器未见相关 console warning/error。截图为 `output/board-templates/ui-desktop.jpg`、`ui-mobile.jpg`、`ui-mobile-preview.jpg`。
- 对比实际模板工作台与原样片，切换模板前后所有镜头内容、时长、图片/视频版本及审核状态完全一致。当前九镜仍未人工审核，视频任务数为 0；未提交视频任务。
- Agent 当前共 25 工具；新增模板目录和保存偏好，预览支持临时模板覆盖，CLI 和标准 SDK MCP 均有实际传输回归。使用文档为 [AGENT.md](AGENT.md)，模板规格为 [BOARD-TEMPLATES-SPEC.md](BOARD-TEMPLATES-SPEC.md)。
- 最终 `npm.cmd test` **117/117 通过**，日志 `output/board-templates/tests.log`；`npm.cmd run check` 与 TypeScript/Vite 构建通过。使用 PowerShell 7.6.5。依赖未改变，本轮未重复依赖审计。
- 最新可查看实例为 `http://127.0.0.1:4321`，独立数据目录见 `output/board-templates/run.json`；保留原 4318/4319/4320 实例。此实例复用真实图片，未复制私有模型凭据。手工重新启动方式为 `node output/board-templates/start-review.mjs`，须确保该端口及数据目录没有其他实例占用。

当前范围是选择预设模板与分页导出，尚未提供自由拖拽模板编辑器。模板容量不改变片段原有九镜及 15/30 秒契约；最终视频仍为独立的 9:16 内容。真实视频成片、长篇批量一致性及真人工审核仍待完成。

## 首轮真实模型与 Agent 验收（历史）

- 原创小说《末班灯》已通过真实 `qwen3.7-plus` 分析，得到林晚、顾川两名主角及一段 30 秒、9 镜、9:16 的分镜。随后通过 Grsai 国内节点真实调用 `gpt-image-2.5`，保存 2 张角色参考图和 9 张最终分镜原图。
- 第 6 镜首次返回 HTTP 400；单镜显式重试后生成成功。目视检查发现该图上下分屏，与“一格一镜”不符；通过 Agent `update_shot` 把动作与机位改成同一时刻、同一景别，再显式 `generate_shot(regenerate:true)` 生成，最终为完整单画面。原失败任务与旧素材保留。当前项目累计 10 次成功分镜生图、1 次失败分镜请求，最终选用 9 张。
- 最初另一个分析尝试返回 HTTP 405，该项目仍保留 `unknown` 记录，不将它记为成功。成功作品 ID 为 `81b149e1-e71b-404e-9668-5a9f2d64b325`，见 `output/real-test/run.json`；不要通过重复提交旧任务猜测其供应商状态。
- 最终九宫格：`output/real-test/001.jpg`；独立分镜按 `shots/001.png` 至 `shots/009.png` 编号；角色图在 `characters/`。12 个交付图片文件均经 Sharp 完整解码，原图约 940–941×1672，九宫格为 810×1536。请求比例为 9:16，实际尺寸由 Grsai 返回。
- 已目视检查角色参考和九宫格：发型、米色风衣/深蓝工装、旧钟表店与冷暖光线基本一致；这不是对长篇或批量人物一致性的保证。所有分镜仍为未审核，预览 `requiresReview:true`。未提交付费视频。
- JSON CLI 实际调用了读取、角色生成/确认、分镜修改/生成、任务查询和九宫格导出。标准 MCP 已用官方 SDK 完成 `initialize → tools/list → tools/call`，可发现 17 个工具并读取同一个真实作品。
- 最新源代码全量自动化 **77/77 通过**（日志 `output/qa/agent-full-tests.log`），Agent 专项 **14/14 通过**；语法检查、TypeScript/Vite 构建通过，`npm.cmd audit --omit=dev` 为 0 项漏洞。自动化不替代上述真实模型和目视验收。
- 本地实测服务仍在 `http://127.0.0.1:4318` 供查看。本服务启动后发生了素材版本标记的收尾修复；该修复已通过自动化，新启动服务加载最新代码。当前实测作品的角色/图片版本均与素材版本匹配。

详细结果见 `output/real-test/report.json`、`report.md`、`image-validation.json`，调用配置见 [AGENT.md](AGENT.md)。以下记录保留初版的本地媒体与界面验证，早期“未真实调用”只描述当时阶段。

## 自动化

- `npm.cmd test`：52 项全部通过（含智投图片配置复用回归）。
- `npm.cmd run check`：服务端、桌面主进程和脚本语法检查通过。
- `npm.cmd run build`：TypeScript 与 Vite 生产构建通过。
- `npm.cmd audit`：修复 Sharp/Electron 已知问题后，完整依赖树 0 项已报告漏洞。
- 使用 PowerShell 7、Node.js 24.13.0。最终 Sharp 0.35.5、Electron 44.5.1；Electron 44 运行时改为首次调用安装器下载，启动脚本已适配。

测试覆盖自动/固定 15/30 秒时长、恰好九镜、人物引用与别名、未知或重复角色 ID 拒绝、角色与分镜修改撤销审核、裁切范围内视频复用、单镜重做与双击去重、业务 ID 提交前持久化、断网未知结果不重 POST、已知任务恢复查询、图片回执恢复下载、过期异步响应隔离、关闭后旧请求不能覆盖重启状态、同目录进程锁、写请求来源保护、媒体路径与 SSRF 边界、密钥不回显以及 CSV 公式注入防护。

## 实际媒体链路

HTTP 集成测试经过真实本地服务：创建/示例 → 2 人物 PNG 上传定妆 → 9 分镜 PNG 上传审核 → 9 个模拟视频任务 → 可解码原视频下载与校验 → FFmpeg 实际裁切合成。

验证导出 30 秒、720×1280 的 `001.mp4`，以及九宫格 `001.jpg`、中文分镜 CSV、JSON 镜头映射。带供应商音轨的输入会在下载、片段合并和项目合并中保留音频；完全无音频的输入才导出为无音轨文件。另一个媒体测试覆盖 15 秒、1280×720 横屏导出。视频全片可解码，文件下载 HTTP 200、范围请求 HTTP 206。测试画面为本地合成素材；外部模型接口使用 mock。

## 真实界面

- Codex 内置浏览器检查 1440×1000 桌面和 390×844 窄屏。
- 验证欢迎页、固定文字示例、小说创建、分镜编辑保存与刷新恢复、角色图片上传、定妆锁定、编辑撤销审核、别名清空、项目切换、模型设置、自动 15/30 秒勾选、窄屏导航。
- 窄屏实测 `scrollWidth=375 <= innerWidth=390`，无横向溢出；隐藏导航不可访问，图标任务按钮有明确名称。
- 浏览器检查时无相关 console error/warn。未配置时生成按钮禁用并说明所缺配置。
- 截图：`output/qa/storyboard-desktop.jpg`、`output/qa/storyboard-mobile.jpg`。截图中的空画面为未生成状态，不是模型结果。
- Electron 原生桌面窗口与 loopback API 启动验证，Windows 凭据存储返回 `encrypted`，FFmpeg 可用。测试使用的远程调试端口已关闭；最终启动不开放调试端口。

## 初版阶段的验收边界（真实调用前）

初版阶段未向 Qwen、Grsai、MiniMax 或火山方舟提交付费视频生成。随后 Qwen 与 GPT Image 2.5 的单段真实验收已完成，见本页顶部。长篇小说改编、复杂主配角/别名、批量角色一致性、真实视频台词/动作遵循和成片画面仍未验证；两家视频供应商的真实账号、额度、参考图遵循和成片质量仍待人工验收。

模型提示词负责对白、旁白和群众吆喝等声音约束；本地软件不再按字段自行静音或编辑供应商音轨，也未接入独立 TTS、音乐混音和字幕烧录。项目成片会保留供应商音轨并合并所有片段。多造型版本库和签名安装包仍未完成。用户应先用一段短小说完成模型和视觉验收，再批量制作。

## 智投图片配置复用验证

- 以智投活动源码核实五个模型 ID、国内 Grsai 端点、GPT/Nano 参数区别和顶层/单层 `code/data` 返回格式。统一前后端目录，默认 GPT Image 2.5；移除无智投实现依据的 2.5 VIP 预留选项，加入准确的 Sunburst ID。
- 回归覆盖目录选择及保存重载、凭据不回显、Sunburst ID 原样提交、VIP 横竖像素尺寸、Nano 1K、角色参考图片、包装错误优先拒绝、未知状态不下载及不重复提交。
- 最终 52 项测试、Node 语法检查及 TypeScript/Vite 构建通过。审查发现并修复配置异步加载时可能覆盖已保存文字/视频模型的问题。
- 独立本地服务 `127.0.0.1:4318` 验证设置页面：七项模型可见，Sunburst 保存后刷新保留，再恢复 GPT Image 2.5。Grsai 配置已识别；密码框为空，仅显示配置状态；控制台无相关警告或错误。
- 1440×1000 桌面和 390×844 窄屏检查通过；窄屏页面宽度 390，对话框宽度与滚动宽度均 354，无横向溢出。截图保存在 `output/qa/image-models-desktop.png` 和 `output/qa/image-models-mobile.png`。
- 自动审批策略拒绝重启现有 Electron 进程，因此以独立服务完成验证。现有桌面窗口未加载新的后端目录，关闭并重新打开后生效。本轮没有真实付费模型调用。

## 2026-10-02：TDL 账号登录与 0.2.0 桌面版

- 固定使用 HTTPS TDL 账号服务，沿用 login/me/logout 契约。通过无凭据 GET 验证官方部署入口返回 401 JSON；没有用真实用户名、密码创建或登录账号。
- 实现登录、退出、可选 Windows safeStorage 加密记住登录、30 秒验证缓存及过期/停用/网络故障处理。密码不持久化，云端 token 不返回前端或 Agent。
- 后端强制验证 API 与媒体访问；本地会话轮换、旧请求丢弃、媒体 account hash 与 Cookie 双重绑定防止旧页签读取新账号内容。
- 每账号独立作品、媒体、模型配置和本机草稿；旧作品显式一次归属导入，保留源文件，不复制旧密钥，不自动重发未完成任务。
- 205 项测试全部通过，涵盖账号、并发竞态、工作区隔离、旧数据恢复、媒体、Agent CLI/MCP 和原短剧流程；npm run check 与 TypeScript/Vite 构建通过。
- 本地模拟 TDL 服务真实浏览器验收：错误密码及密码清空、正常登录、旧作品确认导入、A/B 账号切换、旧作品不泄露、A 草稿恢复、断网锁定、恢复后退出、会话过期返回登录；桌面与 390×844 布局通过，无相关 JS 错误。测试服务未联系真实 TDL 或模型服务，验收结束已关闭。
- 截图：output/auth-qa/login-desktop.jpg、login-mobile.jpg。测试日志：output/auth-qa/tests.log。
- 最终 portable EXE 实际启动通过，显示登录页；未登录 API/媒体返回 401，加密登录能力可用，Sharp PNG、FFmpeg 1 秒视频及 FFprobe 解码通过。报告：output/package-smoke/auth-0.2.0-final/result.json。
- 包审计：6373 文件（30 第一方 + 6343 依赖），29 个可直接比较的运行文件 hash 一致；无 QA 服务、第一方测试、作品、凭据、环境文件或云端会话。报告：output/auth-qa/package-audit.json。
- 桌面交付：C:/Users/www/Desktop/映序-0.2.0-win-x64.exe，151720582 bytes，SHA-256 8B499DDD9DEFA1338F884BED6CD306001F1A0A06E46CA07010040ED8244268A4；与 release 产物一致，旧版 EXE 保留。
- 验证边界：未进行真实账号登录或付费模型调用，真实账户请用户自行登录验收；本包未签名，无云端部署。之前真实生成图片的人工审核与视频成片验收仍保持原状态。
