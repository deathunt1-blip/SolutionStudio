# Phase 0.1 — 分类质量评测

本阶段提供可复现的评测工具，重点检查“错误却自动通过”。不会自动修改生产 Prompt、规则或阈值，也不扩展文档生成功能。

## 当前交付与边界

- 独立数据集清单、文件 SHA-256 和人工标注页面。
- 复用生产 Parser、PostgreSQL 全文检索确认样例、Classifier、证据校验及 Review Gate。
- 每次运行记录实际发送的指纹、提示词、引用样例、规则/模型判断、版本、模型参数、用量及耗时。
- 准确率、逐类 Precision/Recall、文档类型/Authority 混淆矩阵、置信度分桶、高风险错误、阈值模拟、A/B 对比和重复运行稳定性。
- JSON / Markdown / CSV 报告、断点恢复、隔离数据库、请求预算及合成测试。

**尚未进行正式人工标注和真实 AI 准确率验收。** 已有入库测试结果不是 Ground Truth。本阶段准备的真实清单有 60 份文件，人工答案初始为空；未标注的准确率必须显示不可计算，不能显示为 0% 或 100%。生成工具和离线自检不消耗 Kimi token。

## 一次完整的操作

1. 准备数据集。指定一个新输出目录；命令不会覆盖已有清单和人工答案。

```powershell
npm run eval:manifest -- --root "D:\Knowledge" --limit 60 --dataset-id internal_phase01_v1 --library-url http://127.0.0.1:4310 --output evaluation-data/manifest.json
```

`--library-url` 只读取本机工作台的词表和确认样例快照，不导入或编辑生产资料。省略它可使用初始词表及空样例；需要测 Few-shot 效果时应提供真实快照。`--source-manifest` 可复用本地导入脚本产生的路径数组。资料路径及真实正文只留在本机，`evaluation-data/` 和 `output/` 均被 Git 忽略。

2. 打开人工标注页。

```powershell
npm run eval:label
```

访问 `http://127.0.0.1:4312`。先填写标注人，查看标题、摘要、正文及必要的原文件，再选择文档类型和权威级别。答案没有 AI 默认值；不能明确时可选 `unknown` 或跳过。保存只更新评测用 `labels.json`，不会改变生产分类或生成生产确认样例。Application / Topic / Product 仅在勾选“完整标注”后计入相应指标，留空不等于已确认无标签。

3. 可先免费验证整条流程。

```powershell
npm run eval:run -- --provider rules --allow-unlabeled --output output/phase01-offline.json
```

这是本地规则和工程流程验证，不是 AI 准确率验收。正式评测默认要求选中资料已有人工标签；`--allow-unlabeled` 必须显式指定。

4. 标注完后，先用小批量做一次真实基线。

```powershell
npm run eval:run -- --provider kimi --limit 10 --budget-cny 5 --examples without --temperature 0.6 --output output/baseline-no-examples.json
npm run eval:run -- --provider kimi --limit 10 --budget-cny 5 --examples with --temperature 0.6 --output output/experiment-with-examples.json
npm run eval:compare -- --baseline output/baseline-no-examples.json --experiment output/experiment-with-examples.json --output output/examples-comparison.json
```

正式扩大到 50–100 份时保持同一数据集、标签、模型参数和程序版本，并给出明确预算。预算不足会保存 `budget_stopped`，不能把未完成运行当作正式结果。生产 `.env` 的 Key 只在显式指定 `--provider kimi` 时用于请求；报告不保存 Key。

5. 稳定性和温度实验使用不同输出文件。

```powershell
# 10 份资料 × 3 次，预算按最多 30 次分类的重试上限保守预留
npm run eval:run -- --provider kimi --limit 10 --repeat 3 --budget-cny 12 --temperature 0.6 --output output/stability-t06.json
# 对比温度时，其余配置保持一致
npm run eval:run -- --provider kimi --limit 10 --repeat 3 --budget-cny 12 --temperature 0 --output output/stability-t00.json
npm run eval:compare -- --baseline output/stability-t06.json --experiment output/stability-t00.json --output output/temperature-comparison.json
```

这些命令会调用付费模型；本次开发没有执行它们。重复运行仅用于分析漂移，主准确率不会把同一文件的三次运行视为三个独立样本。

## 指标如何理解

| 指标 | 分母与解释 |
| --- | --- |
| 类型 / Authority 准确率 | 有人工标签且可解析的文件；解析失败另计 |
| 自动接受率 / Review Rate | 可解析文件 |
| False Auto-Accept Rate | 错误自动通过数 / 有人工标签的自动通过数 |
| False Auto-Accept / Labeled Readable | 同一错误数 / 有人工标签的可解析文件，同时提供以免混淆 |
| Optional Field Precision / Recall | 仅使用明确完整标注的字段；未标注不参与 |
| Confidence Buckets | 分桶内真实正确率与平均模型置信度，不是训练后的校准模型 |

`HIGH RISK ERRORS` 单独列出类型或 Authority 错误且自动通过的资料；错误但进入 Review 的样本分开统计。错误归因是启发式候选，需人工结合原文、实际指纹和引用样例判断，不能当作已证实原因。Product 报告保留原文支撑与归一化问题，不引入复杂产品 ID 系统。

生产基线目前用 **reviewThreshold（默认 0.60）** 决定 `active / needs_review`；`autoAcceptThreshold（默认 0.85）` 只添加低置信度提示。评测原样保留此行为，明确记录 `gatePolicy=production-review-threshold`。0.80 / 0.85 / 0.90 / 0.95 及 Authority 单独阈值的表格仅是离线模拟，不能理解为已经修改生产设置。

样本数很小时，观察到零误放行也不能证明总体误放行率低于 1% 或 2%。必须结合样本覆盖、置信区间和高风险错误逐条检查，再决定是否进入下一阶段。

## 隔离、复现与成本

评测使用独立临时 PGlite，使用与生产完全相同的 SQL 召回确认样例。当前文件本身及同内容副本的样例始终排除；默认 `--isolate-evaluation true` 还会排除整个评测集的样例。不要将人工标签重新导入确认样例池再评测自己。

每次报告记录 Classification / Prompt / Rule 版本和代码摘要，以及数据集、标签、上下文及参数的指纹。`--resume` 必须带相同参数，已完成文件不会重新调用模型；文件、标签、代码或配置改变会拒绝混接旧结果。恢复时必须确保标注页面没有正在修改答案。异常退出留下的 `.lock` 只可在确认对应进程已停止后手动移除。

预算只约束该次评测启动的请求，**不查询共享账户余额**。Kimi K2.6 按每次最多 7,900 输入 / 3,000 输出 tokens、最多三次尝试，以非缓存单价预留约 0.39705 元/文件；这是保守上限，不是实际扣款。未知结果的中断请求仍保留预留额。报告另列真实返回用量、估算费用、平均每份及 100/1000 份外推。单价参考 [Kimi 官方价格](https://platform.kimi.com/docs/pricing/chat)，变更后应更新预算配置。

分类参数可用 `CLASSIFICATION_MODEL`、`CLASSIFICATION_TEMPERATURE`、`CLASSIFICATION_MAX_TOKENS`、`CLASSIFICATION_BASE_URL` 配置，也可由 CLI 覆盖；未设置时继承 `LLM_*`。当前预算适配仅支持 Moonshot CN 的 `kimi-k2.6`。

只重新生成报告不调用模型：

```powershell
npm run eval:report -- --input output/baseline-no-examples.json
```

## 验证记录

2026-09-22 在 Windows / Node.js 24 上验证：

- `npm test`：**11 个测试文件、68 项测试全部通过**；`npm run build` 通过。
- 60 份真实文件的规则模式离线运行完成：38 success、21 partial、1 扫描 PDF failed；59 份可解析资料完成分类。
- 人工标签为 0，类型和 Authority 准确率均为 `null / 未评估`；Kimi 请求及 token 费用为 0。
- JSON、Markdown、两类混淆矩阵 CSV 已生成，独立 `eval:report` 命令验证通过。
- 浏览器验证了原文预览、空白默认答案、文件切换及标注进度；没有保存虚假的人工答案。
- 正式资料库前后 64 份记录、当前版本和人工确认均未改变（时间戳按同一时刻比较，排除 JSON 毫秒格式差异）。

CI 仅运行合成单元/集成测试，使用假模型或本地规则；不配置真实 Key、不调用 Kimi。测试覆盖指标分母、误放行、混淆矩阵、阈值、置信度、重复运行、恢复、样例泄漏、人工保存和原文件版本一致性。

真实标签完成后，再填写独立的正式结果报告并检查：至少 50 份真实文件、误放行可接受、常见类型无明显系统性误判、Authority 风险可控，且确认样例没有明显负作用。在此之前不宣称达到 90% 准确率或进入下一产品阶段。
