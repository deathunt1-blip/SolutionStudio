# Solution Studio

面向企业技术资料的知识管理工具。Phase 0 专注 **上传 → 解析 → 分类 → 待确认 → 人工纠正 → 全文检索**，为后续文档生产提供可追溯的知识基础。

React + TypeScript / Fastify / PostgreSQL。默认使用本地持久化的 PGlite（嵌入式 PostgreSQL），无需先安装 Docker；设置 `DATABASE_URL` 即可使用独立 PostgreSQL。

## 启动

需要 Node.js 24 LTS（最低 22.13）。

```powershell
npm ci
Copy-Item .env.example .env
# 在 .env 填写 LLM_API_KEY（也可稍后在「分类设置」配置）
npm run dev
```

打开 <http://127.0.0.1:4311>。API 默认监听 `127.0.0.1:4310`。

生产构建和单进程本地运行：

```powershell
npm run build
npm start
```

打开 <http://127.0.0.1:4310>。Windows 也可双击 `启动 Solution Studio.cmd`。

没有模型密钥时仍能解析、保存原文件和进行本地规则分类；界面会显示降级说明，不确定的关键字段进入待确认。启用 Kimi 后，模型收到有长度限制的文档指纹和相关人工确认样例，不会默认提交整份长文档。

## 使用

1. **知识收件箱**：批量拖入 DOCX、PDF、XLSX、XLS、CSV、Markdown 或 TXT。上传完成后队列后台处理，可以离开当前页面。
2. **待确认**：只处理文档类型、权威级别等关键不确定项。人工选择记为置信度 100%，保存为后续分类可检索的确认样例。
3. **资料库**：按关键词、文档类型、应用、主题、产品、权威级别、来源和状态筛选；查看命中的原文片段、版本和来源，下载原始文件。
4. **分类设置**：维护开放分类词表、别名、阈值和模型配置。密钥不回传浏览器；留空表示保留已有密钥。

重复文件默认跳过，也可作为独立文档导入。同一来源路径更新或从详情上传新版本时保留历史版本，并对新内容重新分类；旧确认仍保留在历史与样例中。重建同一版本从原文件重新解析并保留人工修正。归档只移出默认检索，原文件和历史仍保留。

PDF 无可提取文字、加密或损坏时会显示失败/警告；本阶段不提供 OCR。解析失败的原文件同样保留。应用/主题/产品的低置信度不会让用户逐项确认。

## 批量导入本地文件夹

先启动服务，再运行：

```powershell
# 只生成本地抽样清单，不上传、不调用模型
npm run import:folder -- "D:\Project" --limit 60 --sample --dry-run

# 按产品、方案、测试、验收、说明、规范、杂项交叉抽样
npm run import:folder -- "D:\Project" --limit 60 --sample

# 使用上次清单重现导入
npm run import:folder -- "D:\Project" --manifest output/import-manifest.json --limit 60

# Kimi CN K2.6：逐份等待完成并检查账户余额，预留 2 元后停止
npm run import:folder -- "D:\Project" --limit 60 --sample --budget-cny 10
```

脚本只读源目录，跳过临时文件、符号链接和超过 40 MiB 的文件；清单与结果只写到被 Git 忽略的 `output/`。文件仍经同一上传和入库流程处理。预算保护依据账户余额变化，可能包含其他应用的同时使用与结算延迟；真实测试的 token 用量另见验收记录。

## 数据与配置

| 配置 | 默认值 / 用途 |
| --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `4310` |
| `DATA_DIR` | `./data`，保存数据库、原文件和本地配置 |
| `DATABASE_URL` | 留空用 PGlite；填写 PostgreSQL 连接串后用服务器 |
| `LLM_BASE_URL` | `https://api.moonshot.cn/v1` |
| `LLM_API_KEY` | 仅在本机 `.env` 或设置页填写 |
| `LLM_MODEL` | `kimi-k2.6`，请以账号实际可用模型为准 |
| `LLM_TEMPERATURE` / `LLM_MAX_TOKENS` | `0.6` / `3000` |

API key、真实资料、解析内容、本地数据库、日志及测试输出都不进入 Git。迁移机器时需要备份整个 `DATA_DIR` 和 `.env`，不能只复制源码。PGlite 仅允许一个服务进程使用同一个数据目录；备份前停止服务。不要同时启动 `npm start` 和 `npm run dev` 的 API。

独立 PostgreSQL 示例：

```powershell
$env:POSTGRES_PASSWORD = "自行设置强密码"
docker compose up -d db
# 在 .env 填写 DATABASE_URL=postgresql://studio:你的密码@127.0.0.1:5432/solution_studio
npm start
```

应用启动时执行幂等迁移。切换数据库不会自动搬迁原有数据；原文件对象存储目录也需要一并保留。

当前版本面向本机/单组织内部使用，无完整登录和 RBAC。默认仅绑定回环地址。部署到团队网络时应在反向代理层配置登录、TLS 和访问控制后再开放。组织、工作区、项目作用域已经进入数据模型，本版服务固定在默认组织和工作区。

## 验证

```powershell
npm run check
npm test
npm run build
npm audit
npx tsx scripts/check-llm.ts
```

基础测试覆盖解析、置信度、结构切块、存储边界以及上传/确认/检索/版本/去重的集成流程。真实资料验收的统计另见 `docs/VALIDATION.md`，测试资料本身不会提交到仓库。

## 本版范围

已实现 P0 核心知识入库闭环。Feishu 仅有完整接口和显式 Mock Adapter，无真实授权或同步；pgvector/语义检索和自动冲突抽取留待 P0.5。向量服务、检索器和事实溯源的扩展边界已预留。当前搜索是 PostgreSQL 全文搜索，中文先分词，排序结合相关度、权威级别和时间。

不包含文档生成、正文编辑器、报价/BOM、项目管理或多租户管理后台。

架构与扩展说明见 [ARCHITECTURE.md](ARCHITECTURE.md)，HTTP 接口见 [API_CONTRACT.md](API_CONTRACT.md)。
