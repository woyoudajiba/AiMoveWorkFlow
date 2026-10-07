# 文字模型预设与 Windows EXE

## 目标

把 WorkHelper 的六个文字模型预设完整接入映序，让小说分析可以选择模型；提供可直接在 Windows 运行的 EXE 到当前用户桌面。

## 模型契约

- 核实来源：`D:\A_Electron\WorkHelper\app\main\model-presets.js` 提供六预设及推荐标识；`D:\wsf_main\cloud_server\src\lib\tdl-models.ts` 提供 Coding Plan / Token Plan 固定路由。仅复用公开预设和路由，不复用 WorkHelper 账号或密钥。
- 保留 `qwen3.7-plus` 默认值，并提供 `qwen3.6-plus`、`qwen3.8-max`、`qwen3.8-flash`、`deepseek-v4.1-flash`、`deepseek-v4-pro`。两个 Flash 预设标记快速推荐，介绍改为小说分析场景。
- 与 WorkHelper 一致区分 Coding Plan 和 Token Plan。旧 `llmKey` 继续仅表示 Coding Plan；Token Plan 使用独立 `tokenPlanKey`。已保存密钥兼容读取，空字段保留原配置。模型切换不调用外部服务。
- 后端固定模型目录和路由。前端不能提交 Base URL，密钥不进入公开目录；`llmConfigured` 表示当前所选模型的凭据状态。分析使用实际选择的模型和对应服务，不隐式回退。
- 用户界面显示六个模型、推荐标识、所属服务和配置状态；分析门禁使用当前模型配置。保留图片、视频、人工审核和 Agent 工作流。

## 打包约束

- 桌面交付 Windows x64 EXE，优先单文件便携版。打包仅允许应用前端产物、服务端、桌面入口及运行依赖；排除小说数据、输出素材、凭据、环境文件和测试记录。
- 用户项目与加密凭据继续存储在用户数据目录，不能写入临时解包目录或 EXE 同级目录。FFmpeg、FFprobe、Sharp 与应用一起交付，不依赖目标机器的 Node.js。
- 启动时仍为沙箱渲染进程和本地回环服务。无证书时明确为未签名本地构建，不声明正式签名发布。

## 实施与验收

1. 核实 WorkHelper 预设与服务路由；实现目录、独立配置和供应商选择，回归测试六模型路径、密钥隔离、保存恢复与未知模型拒绝。
2. 实现界面选择和配置提示；桌面与窄屏验证选择、保存和刷新。无真实付费模型测试。
3. 建立 Windows 打包配置；验证产物仅含允许文件、无用户数据或凭据，启动隔离数据目录检查配置目录、原生图片处理及 FFmpeg。
4. 复制最终 EXE 到桌面，核对文件大小、SHA-256 和签名状态，保存构建与验收记录。
