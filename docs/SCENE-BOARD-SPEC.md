# 场景造型与横版分镜设定板

## 已确认的目标

先根据小说确定每个连续场景中的角色造型，生成正面、侧面、背面三视图，人工确认后以该场景造型生成九个分镜。角色身份固定，服装、配饰、发型状态可随剧情改变。交付为可选固定模板的横版设定板：左侧分镜附镜号、时长、景别、动作和台词；右侧排列该页实际使用的角色三视图与造型说明。提供 9 镜＋2 组造型、8 镜＋1 组造型、3 镜＋3 组造型，容量不足自动分页，具体契约见 [BOARD-TEMPLATES-SPEC.md](BOARD-TEMPLATES-SPEC.md)。单格及新作品最终视频固定 9:16；整板仅供检查，不送入视频模型。

## 数据与接口契约

- 新工作流 `workflowVersion:2`。`project.scenes = [{id,name,description}]`，一个 scene 表示连续时空与造型状态；同一地点换装可另建 scene。`project.looks = [{id,sceneId,characterId,name,appearance,reference:null|string,referenceVersion?:number,approved:boolean,version:number}]`。同一 scene+character 唯一。
- `Character` 保留人物身份资料和基础身份参考。基础身份生成/确认在先；场景 look 的三视图以基础参考锁定脸、年龄、体型，不复制其旧服装。每次 look 只生成一张横向三视图（正/侧/背），该图不是三名不同人物。
- `Shot` 增加 `sceneId`，`characterIds` 维持不变；所用造型唯一解析为相应 sceneId+characterId 的 look。服务端要求该 look 三视图为当前版本且已确认，然后才能生图或确认/生成视频。
- 编辑/重做某个 look 仅使引用该 scene+character 的分镜版本、审核和视频失效；编辑人物身份使其所有 look 和关联分镜失效。角色身份与造型不能通过前端/Agent 绕过校验。旧版异步结果不能回写当前素材。
- 旧作品保留原图、任务和文字；缺场景时可建立每段一个待检查的场景和造型草稿，绝不能把旧单人肖像当作三视图或自动审核。迁移后原分镜须显示为旧版、重新生成才具备当前造型依据。无场景旧格式在纯媒体导出中仍可读，显示待完善造型，不伪造三视图。
- HTTP：`POST /api/projects/:id/scenes {name,description?}`；`PATCH .../scenes/:sceneId {name?,description?}`；`POST .../looks {sceneId,characterId,name,appearance}`；`PATCH .../looks/:lookId {name?,appearance?}`；`POST .../looks/:lookId/{generate|upload|approve}`。操作结果均为 Project。generate 支持 expectedVersion/reuseExisting，approve 支持 reviewedVersion。`PATCH .../shots/:shotId` 支持 sceneId。
- Provider 新增 `generateLook(project,look,businessId)->relative media URL`；`look` 为任务 kind，沿用业务 ID、回执恢复、未知提交不重 POST、版本保护。
- Agent 增加 create_scene/update_scene/create_look/update_look/generate_look/approve_look，并允许 update_shot.patch.sceneId；复用现有防重复付费与版本审核。凭据不进入 Agent。
- 模型分析输出同名 scenes/looks/shot.sceneId；多块输入应规范化所有引用。缺完整新字段时只创建未审核的造型草稿，不能静默沿用已审核旧衣服。明确不存在的 ID 拒绝。

## 设定板

共享本地排版用于预览和最终视频附图。左侧 9:16 原画面保持完整，按模板将文字固定排在图片右侧或下侧；镜号和时长保持一行，景别、动作、台词允许多行。右侧取当前连续场景实际引用的 scene+character 造型，每种模板固定一列及固定槽位数量。不同连续场景另起一页，角色超过槽位数时增加造型续页并重复对应分镜，不能静默漏角色。图片中的文字使用本机可用中文字体排版，转义特殊字符，完整描述保存于 CSV/manifest，长文本在板上明确截短。整板宽大于高，画布受有限像素/尺寸预算约束。未使用的槽位保留；已引用但缺三视图时显示缺图说明并 requiresReview。

manifest 保留逐镜素材/版本/文字/场景及 look 映射，输出布局字段；审核标记同时检查角色、look、分镜。最终视频只接收独立分镜原图，不包含文字、三视图或边框。

## 实施与验收

1. 场景/造型模型、迁移、服务端校验、失效与任务恢复，回归验证跨场景不会串衣服。
2. 分析提示词、造型三视图、按场景选参考图；用供应商 mock 捕获请求证明不引用另一场景衣服，并完成受控实图验证。
3. 本地横版设定板排版及 manifest/CSV，检查可解码性、布局、中文、安全转义和全部角色映射。
4. 角色造型界面、分镜场景选择、设定板预览导出，桌面与窄屏实测。
5. Agent 新工具、文档、全量测试、check/build、代码审查；真实验证沿用小说《末班灯》，另加换装场景的隔离证据。用户审核前不提交真实视频，不部署/提交/发布。

## 当前取舍

场景需要用户检查，小说未交代的服装标为待确认设定。三视图由模型生成仍可能出现视角偏差，成功状态不等于已审核。已有横屏作品保持可读与旧视频参数，新作品使用竖屏；横版指设定板排版。
