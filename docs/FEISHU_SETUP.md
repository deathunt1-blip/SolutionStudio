# 飞书只读接入（Phase 0.2.1）

本版使用企业自建应用的 `tenant_access_token`，读取授权范围内的 Wiki、原生文档、云空间文件和电子表格。链接只提取资源标识；内容通过 `https://open.feishu.cn/open-apis` 获取，不抓取浏览器页面，也不把本地修改写回飞书。

## 1. 准备应用和资源授权

1. 在[飞书开发者后台](https://open.feishu.cn/app)创建企业自建应用，在「凭证与基础信息」找到 App ID 和 App Secret。
2. 在「权限管理」申请下表中需要使用的只读能力。创建并发布应用版本，由企业管理员审批生效。权限码以对应官方 API 页面的「所需权限」为准；若后台展示了更细粒度的等价权限，可按该 API 的要求选择。
3. 单独授权资料：将应用加入目标知识空间的成员/协作者；对独立表格、文档、文件添加应用的阅读权限。仅打开 API scope 不会让应用自动访问全部内部资料。Wiki 授权步骤见[官方知识库常见问题](https://open.feishu.cn/document/server-docs/docs/wiki-v2/wiki-qa)。
4. 在 Solution Studio「设置 → 资料来源」添加连接，在本机的密钥输入框保存 App ID 和 App Secret，再粘贴 Wiki 或 Sheets 链接测试连接。

无需手工申请或粘贴 Tenant Access Token；服务端自动获取、缓存、刷新。App Secret 不应放进 Git、普通来源配置或截图中。

| 能力 | 常用只读权限 | 官方接口说明 |
| --- | --- | --- |
| Wiki 根节点和子节点枚举 | `wiki:wiki:readonly` | [获取节点](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/get_node)、[子节点列表](https://open.feishu.cn/document/server-docs/docs/wiki-v2/space-node/list) |
| Docx 版本号及页内附件枚举 | `docx:document:readonly` | [获取文档基本信息](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/get)、[获取所有块](https://open.feishu.cn/document/server-docs/docs/docs/docx-v1/document/list) |
| 原生 Doc/Docx 导出 | `drive:export:readonly` | [创建导出任务](https://open.feishu.cn/document/server-docs/docs/drive-v1/export_task/create)、[查询结果](https://open.feishu.cn/document/server-docs/docs/drive-v1/export_task/get)、[下载导出产物](https://open.feishu.cn/document/server-docs/docs/drive-v1/export_task/download) |
| 云空间文件/PDF 下载 | `drive:file:readonly` | [下载文件](https://open.feishu.cn/document/server-docs/docs/drive-v1/file/download) |
| 文档内 File Block 附件下载 | 按素材下载 API 页面申请只读下载权限，并确保有父文档阅读权限 | [下载素材](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/download)、[素材权限说明](https://open.feishu.cn/document/server-docs/docs/drive-v1/media/introduction) |
| 电子表格读取 | `sheets:spreadsheet:readonly` | [表格信息](https://open.feishu.cn/document/server-docs/docs/sheets-v3/spreadsheet/get)、[工作表列表](https://open.feishu.cn/document/server-docs/docs/sheets-v3/spreadsheet-sheet/query)、[读取区域](https://open.feishu.cn/document/server-docs/docs/sheets-v3/data-operation/reading-a-single-range) |

仅导入表格时可只开表格权限；Wiki 内含 Docx、File、Sheet 时，需要对应的各项权限。导出任务只生成供下载的副本，不修改原文档。

## 2. 链接与同步行为

- Wiki：`https://企业.feishu.cn/wiki/节点token`，包含根节点，默认递归其可访问的子节点，保存完整路径。不支持的类型显示 `unsupported`，不阻断其他节点。
- Docx 页面内的文件附件通过官方块列表分页枚举并下载：支持 PDF、DOCX、XLSX、XLS、CSV、Markdown、TXT；PPTX、RAR 等保留为 `unsupported`。附件路径为「父页面路径/原文件名」，来源链接定位到父页面的文件块，保留父文档、块 ID 和素材 Token；同一块替换文件保持同一逻辑资料 ID。不会递归访问普通正文链接或将图片块另作资料。
- Sheets：`https://企业.feishu.cn/sheets/表格token?sheet=工作表id`，带 `sheet` 只选该工作表，不带则分别导入全部工作表。Wiki 中的 Sheet 节点同样分流到结构化数据集。
- URL 解析器也识别 Doc、Docx、File，P0 来源入口配置限定 Wiki 和 Sheets。
- Docx 使用官方 `revision_id` 判断版本，不依赖秒级修改时间。导出前后版本发生变化时，本次节点失败，后续重试读取完整版本。
- 旧 Doc 每次读取后比较稳定正文指纹，排除 ZIP 时间等导出元数据的影响。原导出文件仍按原始字节 SHA-256 保存；表格结构与图片内容变化会影响正文指纹。
- Sheet 按范围读取，保留中间空行的真实行号；范围间 revision 不一致则放弃本次数据集，防止混用新旧参数。原始值和每行链接进入结构化管线，不按长文章切分。
- 枚举失败、分页缺失、权限错误或达到保护上限时，列表为 `complete=false`，同步层不能据此判定旧资料已从远端删除。
- 本版本为手动只读同步；定时同步、Webhook、嵌套压缩包/复杂附件树、图片 Asset、OCR、多维表格和反向写入不在本期范围。页内附件只处理 Docx 的直接 File Block，旧 Doc 内嵌附件不单独枚举。

首次表格同步需要确认字段映射、产品主键和是否作为产品参数来源。飞书目录路径不会自动把资料提升为权威来源。

## 3. 边界和故障提示

默认每个适配器请求间隔 250 ms；HTTP 429 和 5xx 最多重试 3 次，指数退避并尊重有上限的 `Retry-After`。令牌失效只刷新重试一次。错误仅包含固定提示、HTTP 状态和数字业务码，绝不回显飞书响应正文、App Secret 或访问令牌。

JSON 响应上限 8 MiB，单文件上限 64 MiB；单工作表最多 5 万行、1024 列、200 万单元格。超过上限明确报错，不静默截断。读取块为 500 行 × 100 列，导出任务最多轮询 60 次。API 重定向被拒绝。自定义 API 地址仅能在代码构造器中注入本机 Mock 测试地址，不接受产品配置传入的 transport 地址。

| 现象 | 排查方式 |
| --- | --- |
| Token 获取失败 | 检查 App ID/Secret、应用启用状态和网络；不需查询 Kimi 余额 |
| HTTP 403 或 Wiki `131006` | 请知识库/文件所有者将应用加入可读成员；这通常是资源授权而非重复申请 Token |
| `99991672` 等 scope 错误 | 检查对应 API 权限是否已申请并发布审批生效 |
| 根节点能测试，但部分文档失败 | 检查失败子节点是否有单独权限，以及文档读取/导出 scopes |
| 表格或文档读取期间修改 | 停止编辑后再次手动同步；上一次成功本地版本仍保留 |
| 非 HTTPS、陌生域名或无法识别的链接 | 使用正常的 `*.feishu.cn/wiki/...` 或 `/sheets/...` 分享链接 |

## 4. 测试与官方协议依据

`npx vitest run tests/feishu-adapter.test.ts` 使用本机 Mock HTTP Server；不会调用真实公司飞书或 Kimi。覆盖 URL 安全、递归/分页/partial、合法空页、令牌单航班及刷新、重试、响应上限、禁止重定向、Doc/Docx 导出、文件 MIME/名称、稳定内容指纹、秒内修订变化、页内附件分页/素材下载/替换/不支持类型/部分失败保护，以及 Sheet 分页行来源及并发修订保护。

授权协议见[企业自建应用 tenant_access_token](https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal)。请求路径和响应字段另与官方 SDK 的 [Wiki](https://github.com/larksuite/node-sdk/blob/main/code-gen/projects/wiki.ts)、[Sheets](https://github.com/larksuite/node-sdk/blob/main/code-gen/projects/sheets.ts)、[Drive](https://github.com/larksuite/node-sdk/blob/main/code-gen/projects/drive.ts)、[Docx](https://github.com/larksuite/node-sdk/blob/main/code-gen/projects/docx.ts) 定义核对（2026-09-23）。

## 5. 可选：解密已授权的文档本地副本

仅对已获得文档密码和解密授权的资料启用此功能。支持 PDF 及加密 OOXML（DOCX/XLSX/PPTX）；格式是否可入库仍由解析器能力决定。配置后，同步服务将解密下载到本地的副本，用于解析和检索；飞书上的原文件、密码和权限均不修改。

- `PDF_PYTHON`：安装了 `pypdf`、`cryptography` 和 `msoffcrypto-tool` 的 Python 可执行文件路径。未设置时使用 `python`。在该 Python 环境运行 `python -m pip install pypdf cryptography msoffcrypto-tool` 安装依赖。
- `SOURCE_DOCUMENT_PASSWORD_REF`：文档密码在加密 Secret Store 中的引用标识。部署人员通过 `SecretStore.put()` 安全写入密码后，将返回的引用写入此环境变量；此处填写引用，不能填写明文密码。未设置时不尝试解密。

密码通过子进程标准输入传递，不放进命令行参数、普通日志或资料元数据。单次解密最多 30 秒，输入和输出文件均不超过 64 MiB；密码不正确或文件不支持时，节点单独报错，可修正配置后重试。非加密 PDF 和普通 ZIP 格式的 OOXML 保持原始字节和内容哈希。

加密原件与解密副本分别保存在本地对象存储中；元数据记录原件哈希及对象引用。资料详情显示「下载解密副本」和「下载加密原件」，历史版本保留解密标记和来源信息。不要将明文密码写入 `.env`、来源配置、Git 或截图。
