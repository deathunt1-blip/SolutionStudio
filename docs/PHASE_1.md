# Phase 1：自动技术方案（v0.3.0）

本阶段将项目资料、SceneLab 工程结果、企业知识和权威结构化产品参数组织成一份可编辑、可追溯、可导出 DOCX 的标准技术方案。现有知识库、解析器、对象存储、Kimi Provider、PostgreSQL / PGlite 和审计模块继续复用。

## 使用流程

1. 打开项目方案入口，新建项目，填写项目名、客户名和简要说明。
2. 导入客户需求书、技术协议或说明，支持 DOCX、PDF、XLSX、XLS、CSV、Markdown、TXT，也可手工补充文本。扫描 PDF 需要先提供可提取文字，本版不做 OCR。
3. 可选导入 SceneLab 导出的 `.scenelab-report` 工程报告包。
4. 核对“项目理解”：摘要、客户要求、产品型号、锁定事实、缺失信息和要求与工程结果的冲突。修正后保存并确认；没有依据的参数保持待确认。
5. 选择“标准技术方案 · 光学动作捕捉”，创建方案并确认目录。模板有工程报告时包含 25 个章节条目；没有工程报告时省略部署、覆盖、理论精度三个分析条目，保留 22 个。条目包括一级标题及其子章节。
6. 生成全部或选定章节。后台任务最多并行生成三章，每章完成后独立保存结果；可以查看进度和错误，重试未完成的章节。
7. 在章节编辑器修改段落、标题、列表、表格和已有项目图片。右侧可查看来源、项目事实与校验结果，也可重新生成、缩写、扩写、调整正式程度、强化技术表达或按指定来源重写。
8. 保存人工修改，检查校验问题，设置输出样式并导出 DOCX。存在未完成章节或事实错误时，界面允许在提示后导出草稿供继续审阅。

AI 操作前须先保存当前修改。已人工编辑的章节需要明确确认覆盖；请求同时携带方案或章节版本号，过期提交返回冲突，避免覆盖后续修改。重试是新的生成任务，继续记录费用预留；只有显式启用额度限制时才因预算不足停止。

## 项目资料与上下文

项目导入的原文件、解析片段和工程图片属于该项目。文档记录使用 `scope=project` 和 `project_id`；全局资料库搜索、全局去重以及其他项目的检索不会选入这些片段。项目导入不会自动把客户资料沉淀到全局知识库。

客户材料先通过现有解析器拆分，再提取为有来源的结构化要求。每项要求保留输入文件、可用时的片段 ID、证据原文、置信度和人工确认状态。本地规则提取不调用模型；显式选择 AI 提取时，模型只补充材料中能逐字核验的要求。默认关闭人工额度限制，按模型窗口分批处理本项目全部可提取 `document` / `text` 输入，不仅选择前 12 份或前 24,000 字节；SceneLab 工程数据继续由 Adapter 处理。每批仍保留原输入和片段的来源关系。

客户目标、工程理论能力和人工修正分别保留来源。上下文包括摘要、要求、工程数据、锁定事实、产品选型、图片、冲突与待明确事项。确认允许保留待明确事项，但不会把缺失参数自动补成已知事实，也不会把客户指标转为产品能力。

每次新资料导入或事实修改都会使确认失效。创建方案需要当前上下文已确认，并保存以下快照：

- 项目上下文及其输入修订号。
- 文档模板及其版本。
- 已确认选型对应的有效、权威结构化产品事实。

已有方案不会悄悄换成新事实。项目资料或上下文变化后，旧方案显示过期，停止继续生成；应重新确认项目理解并创建使用新快照的方案。校验还会检查权威产品参数是否已更新或移除。已有人工正文保留在原方案中，不会自动迁移到新方案。

本版面向默认组织和工作区的本机使用；项目数据隔离不是完整登录、RBAC 或多租户访问控制。网络部署边界见 [README 数据与配置](../README.md#数据与配置)。

## SceneLab 报告接口

`SceneLabReportAdapter` 当前只接受 `format=scenelab-report`、`format_version=1.0` 的 ZIP 包。格式版本独立于 SceneLab 软件版本。真实生产端是 [SceneLab](https://github.com/deathunt1-blip/SceneLab) 的“技术报告 → 导出技术报告包”，格式定义见 [SceneLab 报告包规范](https://github.com/deathunt1-blip/SceneLab/blob/main/docs/REPORT_PACKAGE_FORMAT.md)，导出入口见 [ReportPackageButton.tsx](https://github.com/deathunt1-blip/SceneLab/blob/main/src/reportPackage/ReportPackageButton.tsx)。测试夹具不是生产端协议的替代品。

Adapter 读取 `manifest.json`、`project.json`、`analysis.json` 和清单列出的 PNG。它校验方案与分析的修订号、场地尺寸、位置单位 m、精度单位 mm、相机标识及启用状态、指标范围、图片尺寸和 PNG 完整性，并在解压前限制 ZIP 条目与大小、拒绝不安全路径。导入不把 ZIP 直接解压到磁盘目录。

启用相机的型号和数量来自工程快照。覆盖率、平均视点数、平均误差、P90/P95 和误差阈值比例来自分析数据。常规六张工程图片按角色插入相应章节：部署透视图、覆盖俯视图、覆盖透视图、理论精度透视图、前视图和侧视图。报告若包含可选相机视图，也会作为项目图片保留；内部诊断不纳入客户正文。

这些结果属于理论工程分析，不代表实测结果或验收承诺。存在客户指标与工程结果差异时，方案应保留差异与确认事项。

## 生成、来源与校验

处理链如下：

```text
Project Inputs → Requirement Parser / SceneLabReportAdapter
               → ProjectContext → 人工确认 → 上下文快照
               → DocumentTemplate → 章节上下文
               → Canonical Retrieval + Structured Facts
               → Kimi / 程序表格与图片 → Validation
               → Section Editor → DOCX
```

`DocumentRetriever` 复用全局知识检索器，只检索主资料的当前有效版本，并遵守已确认重复组抑制；同时读取当前项目自己的有效片段。来源保留引用证据与版本标识。结构化产品事实按已确认的型号精确匹配，不使用型号子串查询。风格参考不能作为参数依据。

正文由模型按章节生成，默认以内容质量和依据完整性为先，不为节省 Token 强制短写。客户要求表、设备表、产品参数表、工程结果表及工程图片由程序组织。生成返回的事实、知识和图片引用必须属于本次上下文；来源证据由服务端维护，编辑内容不能伪造引用。固定正文和程序表、图片不需要额外模型生成。

同一任务最多三章并行；各章使用独立构建的上下文，并共享不可变的项目快照。每次模型请求仍先在事务中完成预算预留，启用限制后不会绕过任务或累计额度。单章失败保留其他章节结果；生成期间的编辑互斥、保存时的事实与章节版本检查、覆盖人工正文的二次确认继续生效。

校验按指标、单位、型号、事实优先级和来源角色检查数字与能力表述，区分客户要求和工程能力，识别部分参数不一致、无依据断言、未解决冲突、缺失来源、缺失章节、外部图片及过期快照。它也检查人工编辑后的内容，不把“程序生成”标志作为免检依据。

**校验是规则审查，不保证语义完整性。** 未发现错误不表示所有技术陈述正确、所有要求都已覆盖，更不构成对真实工程性能的认证；交付前仍需审阅正文、来源与工程口径。

## 模型设置与可选限制

Phase 1 的生成配置独立于知识分类任务，默认使用 `https://api.moonshot.cn/v1` 的 `kimi-k3`，不会沿用旧分类配置中的模型。K3 始终启用思考；`reasoningEffort` 可选 `low`、`high`、`max`，默认 `max`。温度由模型固定为 `1`，Provider 不向 K3 发送 `temperature` 参数，界面也不提供温度调节。K3 的总上下文窗口为 1M（1,048,576）token，默认输出上限为 131,072 token，参数依据见 [Kimi K3 官方指南](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)。

界面仍可显式选择 `kimi-k2.6`，使用非思考模式和固定温度 `0.6`；其总窗口为 256K，默认输出上限为 32,768 token，依据见 [Kimi K2.6 官方指南](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)。已有任务保留创建时的模型、温度、推理强度和费用记录，不会改写成 K3。

新生成请求默认 `config.limitsEnabled=false`。界面的“启用生成额度限制”默认不勾选，并隐藏自设 Token 与预算输入；默认不会因 10 元任务预算或 250 元累计预留而停止。费用估算和保守预留仍然记录。模型本身的技术上限、来源隔离和事实约束继续生效。

K3 默认模式为模型输出保留 131,072 token，为消息封装保留 1,024 token，因此章节输入使用 `1048576 - 131072 - 1024 = 916480` 的保守 UTF-8 字节上界。K3 每次 Provider 请求超时为 600 秒（10 分钟），最多三次尝试；超时和模型技术上限仍可能导致章节失败，可以单独重试。显式选择 K2.6 时，输入上界仍为 228,352 字节，单次请求超时为 180 秒。

| 参数 | 默认不限额度模式 | 显式启用 `limitsEnabled=true` |
| --- | --- | --- |
| 模型 | 中国区 `kimi-k3`；可显式选择 `kimi-k2.6` | 相同 |
| `reasoningEffort` | K3 默认 `max`，可选 `low` / `high` / `max` | 相同；K2.6 不启用思考 |
| `temperature` | K3 固定 `1` 且不向模型发送该参数；K2.6 固定 `0.6` | 相同 |
| `maxTokens` | K3 使用 `131072`；K2.6 使用 `32768` | 未指定时 `3000`；当前 UI `512–6000`，API 另检查所选模型的窗口 |
| `maxContextTokens` | K3 使用 `916480`；K2.6 使用 `228352` | 未指定时 `12000`；当前 UI `4000–12000`，API 另检查所选模型的窗口 |
| `budgetCny` | 不启用任务金额停止条件 | 未指定时 `10` 元；大于 0、最多 `100` 元，UI 最低 `0.01` 元 |
| 章节生成累计预留 | 记录，不按金额停止 | 同一数据库累计 `250` 元停止条件 |

只有勾选开关后，自设的 `maxTokens`、`maxContextTokens` 和 `budgetCny` 才参与限制。关掉开关会恢复模型技术上限，不把保留在表单里的 `3000`、`12000` 或 `10` 当作活动限额。新任务持久化保存明确的 `true` 或 `false`；旧任务没有该字段时，继续按旧有限模式解释，进度中保留原预算信息。

上下文计数采用 UTF-8 字节数作为 token 数的保守上界，不是 tokenizer 的精确计数。相关资料按剩余模型窗口选入；必需事实超过当前有效上限时，在发送模型请求前失败，不静默截断锁定事实。缩写或扩写使用的旧正文可能在空间不足时省略。

章节生成每次请求前，按实际组装的系统指令与上下文字节上界、本次有效输出上限及所选模型的费率，预留最多三次 Provider 尝试的费用。输入与输出单价的单位均为元 / 百万 token。K3 官方未缓存输入单价为 20、5 分钟缓存写入为 20、输出为 100；实现保守地把未缓存输入与一次 5 分钟缓存写入相加，采用输入 `40`、输出 `100` 估算。K2.6 采用输入 `6.5`、输出 `27`。这些是估算口径，不等同于供应商实际扣费账单；缓存命中、缓存时长及实际计费状态不由本地估算还原。费率依据见 [Kimi 官方定价](https://platform.kimi.com/docs/pricing/chat)。

```text
单次预留（元） = 3 × ((实际组装输入字节上界 + 1024) × 模型输入单价 + maxTokens × 模型输出单价) / 1,000,000
K3 单次预留（元） = 3 × ((实际组装输入字节上界 + 1024) × 40 + maxTokens × 100) / 1,000,000
```

预留随本次输入大小变化，不按整个配置窗口一律计费。默认不限额度时，记录预留后继续请求；显式启用限制时，任务预算或累计额度不足会停止发送剩余模型请求，已完成章节保留。固定正文、纯表格和图片章节不占模型请求预留。跨方案预留使用持久化记录和串行保护，关闭限制也不会删除已有费用记录。

项目 AI 需求提取与章节生成分别记录用量。提取请求默认也独立使用 K3、`max` 推理强度；顶层 `limitsEnabled` 默认 `false`，使用 916,480 UTF-8 字节输入窗口分批处理全部可提取文档与文本，每批输出上限 131,072 token、请求超时 600 秒。25 元累计额度不会停止这些默认请求。提取 API 可通过顶层 `model: "kimi-k2.6"` 显式选择旧模型，采用其 228,352 字节窗口、32,768 token 输出和 180 秒超时。显式启用提取限制时，保留前 12 份来源的单批处理、24,000 字节输入、4,000 token 输出和 25 元累计预算约束。每批按实际输入加 1,024 封装预留、有效输出上限、所选模型费率和三次尝试记录费用，并合计所有批次。两项额度彼此独立；Phase 1 开关不改变知识分类、智能整理或批量导入的独立设置。

费用记录不查询共享账户余额；实际响应 token 与估算费用另外记录。请求失败、结果格式错误、服务中断或者实际返回较少 token，都不会释放原预留。中断时保留已完成章节，运行中的任务标记中断，未知结果的付费请求不会自动重放；继续操作作为新任务记录新预留。预留用于保守估算和可选限额判断，不等同于供应商实际扣费账单，价格改变后需要同步调整实现。

## DOCX 输出

DOCX 导出使用已保存的正文和项目资产，不再调用 AI。输出包含 A4 页面、封面、标题层级、Word 目录字段与章节链接、按章节编号的图表、参数表、已有工程图片、页眉、页脚及页码。常规报告提供六张工程图时，模板会将它们放入对应章节；导出不会生成缺失工程图片。

每份方案有独立 `OutputProfile`：公司名称、可选封面 Logo、正文字体和字号、标题字体、页边距、页眉与页脚。`coverLogoAssetId` 默认未设置，封面不显示 Logo；输出设置可从当前项目的 PNG/JPEG 资产中选择，也可选择“不显示 Logo”清空。此项只引用已有项目资产，不接受外部 URL 或新增上传。默认正文字体宋体、11 磅，标题字体黑体，页边距 25 mm；字号可设 8–18 磅，页边距可设 15–35 mm。输出设置不修改全局模型配置。

导出会先重新校验，但校验问题不会自动禁止草稿下载。文档目录和页码需要由实际 Word 兼容排版程序计算，打开后可更新目录字段。

当前 DOCX 已通过 Open XML 包结构、关系、表格、图片和样式等结构测试。现有 bundled Windows 运行时缺少 LibreOffice，未完成将 DOCX 渲染为逐页图片的视觉 QA，不能宣称每一页的分页、字体替代和图表排版都已验证。真实 UI 浏览器验收与 DOCX 结构测试是不同检查，不互相替代。

## 模块与接口

| 模块 | 职责 |
| --- | --- |
| `packages/projects/src/service.ts` | 项目、输入、资产、上下文修订与人工确认 |
| `packages/projects/src/requirements.ts` | 本地规则提取、显式 AI 提取与来源核验 |
| `packages/projects/src/scenelab.ts` | SceneLab 1.0 报告适配 |
| `packages/document-engine/src/templates.ts` | 标准技术方案模板 |
| `packages/document-engine/src/context.ts` | 章节上下文和复用检索器 |
| `packages/document-engine/src/service.ts` | 任务队列、版本保护、预算预留和审计 |
| `packages/document-engine/src/blocks.ts` | 内容块清洗、模型返回解析及程序表格 |
| `packages/document-engine/src/validation.ts` | 指标、单位、型号及来源规则检查 |
| `packages/document-engine/src/export.ts` | 无模型 DOCX 导出 |
| `apps/web/src/Projects.tsx` / `DocumentEditor.tsx` | 项目工作流、目录、编辑器、来源和校验面板 |

主要 HTTP 入口如下，项目与方案 ID 均由创建接口返回：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/projects`、`POST /api/projects` | 列出、新建项目 |
| `GET /api/projects/:id`、`PATCH /api/projects/:id` | 查看、更新项目 |
| `POST /api/projects/:id/inputs` | multipart 导入项目文件 |
| `POST /api/projects/:id/text` | 手工补充文本 |
| `GET /api/projects/:id/context` | 获取当前上下文 |
| `POST /api/projects/:id/parse-context` | 重建上下文；仅 `useAI: true` 调用 AI 提取；顶层 `limitsEnabled` 默认 `false` |
| `PATCH /api/projects/:id/context` | 带 `revision` 保存修正 |
| `POST /api/projects/:id/confirm-context` | 带 `revision` 确认当前上下文 |
| `GET /api/document-templates` | 获取模板 |
| `GET /api/projects/:id/documents`、`POST /api/projects/:id/documents` | 列出、新建方案 |
| `GET /api/generated-documents/:id`、`PATCH /api/generated-documents/:id` | 查看方案、更新标题和输出设置 |
| `PATCH /api/generated-documents/:id/plan` | 带 `revision` 更新目录 |
| `PATCH /api/generated-documents/:id/sections/:sectionId` | 带章节 `revision` 保存内容块 |
| `POST /api/generated-documents/:id/generate` | 提交生成，返回 HTTP 202 与任务 |
| `GET /api/generated-documents/:id/jobs` | 查询生成任务 |
| `POST /api/generated-documents/:id/validate` | 重新校验 |
| `GET /api/generated-documents/:id/export.docx` | 下载 DOCX；`X-Validation-Issues` 返回问题数 |

生成请求可包含 `sectionIds`、`expectedRevision`、`mode`、`sourceIds`、`overwriteEdited` 与 `config`。`config.model` 默认 `kimi-k3`，`config.reasoningEffort` 默认 `max`；`config.limitsEnabled` 默认 `false`，明确传入 `true` 才启用自设 Token 与预算限制。`mode` 支持 `regenerate`、`shorten`、`expand`、`formal`、`technical`、`rewrite`。指定来源仍须符合项目隔离、当前有效版本与模型上下文空间，不会越权扩展检索范围。

## 验证与当前边界

离线测试覆盖项目隔离、上下文修订、SceneLab 协议与图片校验、章节版本保护、模型输出与引用约束、费用预留、规则校验和 DOCX 结构。真实模型、真实项目和浏览器验收结果应分别记录，不以 Mock 测试替代真实调用，也不以生成成功替代人工技术审阅。

真实客户资料、报告包、数据库、模型响应、导出文件和密钥不提交到 Git。本指南不包含私有项目名、报告文件名、客户内容或真实资源 ID。

本期只有标准技术方案；测试报告、验收报告、实施方案、SOP、投标文件、报价/BOM 和多人协作不在本版范围。后续文档类型可复用 `DocumentTemplate`、`GeneratedDocument` 和 `ProjectContext`，但当前界面与模板不宣称已支持这些输出。
