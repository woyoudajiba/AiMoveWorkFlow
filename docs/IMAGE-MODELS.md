# 智投图片模型配置复用

## 目标与范围

从 `D:\auto_liu` 的实际源码复用 Grsai 模型目录、默认模型与生成参数，供映序的角色定妆和分镜生成统一使用。模型选择界面、后端校验和请求适配器使用同一份目录；不复制智投的商品业务提示词、计费规则或生产配置文件，不改动文字和视频服务。

## 配置契约

- 智投确认的模型：`gpt-image-2.5`（默认）、`gpt-image-2.5-sunburst`、`gpt-image-2`、`gpt-image-2-vip`、`nano-banana-pro`。映序继续提供已有的 `nano-banana-fast` 和 `nano-banana-2`。
- 删除首版按名称预留、未在智投实现中找到依据的 `gpt-image-2.5-vip`；不把它当作 Sunburst 的别名。
- 使用国内节点 `https://grsai.dakka.com.cn/v1/api/generate`，Bearer 凭据只在本地后端使用，从现有 `GRSAI_API_KEY` 或桌面加密配置读取。
- GPT 模型不发送 `imageSize`。`gpt-image-2.5`、Sunburst 和 GPT Image 2 使用作品比例；GPT Image 2 VIP 继续按 Grsai 技能接口文档发送对应像素尺寸（竖屏 `720x1280`，横屏 `1280x720`）。
- Nano Banana 继续使用 `imageSize: 1K` 草稿设定。智投商品图默认 2K 不直接套用于短剧的多镜头预览。
- 映序继续使用已实现的 `replyType: json` 和成功回执恢复；智投的异步队列不在此次配置迁移范围。失败后不静默更换模型或重复付费提交。
- `GET /api/config` 返回公开的 `imageModels: [{id,label,description}]`，前端从该目录渲染。凭据不包含在目录或公共响应中。

## 验证计划

用配置与供应商契约测试验证模型选择、GPT/Nano 参数差异、参考图顺序、响应解析和密钥不回显；执行全量测试、语法检查及前端构建，并在真实浏览器验证选择与保存。此次不提交真实付费生图，账号可用性及人物一致性仍需实际模型验收。

## 来源

- `D:\auto_liu\backend\src\MainImageController.java`：默认模型、允许列表及 Grsai 请求。
- `D:\auto_liu\main-image-workspaces.js` 与 `D:\auto_liu\BrowserExtension\popup.html`：用户可选模型。
- `D:\auto_liu\backend\src\PortraitImageProcessor.java` 与 `MainImagePosterProcessor.java`：GPT Image 2 VIP 使用像素尺寸。
- `C:\Users\www\.codex\skills\grsai-imagegen\references\api-reference.md`：JSON 返回方式、VIP 像素尺寸和 Nano Banana 分辨率字段。
