---
name: jk-network-generator
description: 依据中央 JKRD V4.0.0 构建、优化和校验自定义 JK 节点网络及模型快照。用于算术、位级布尔逻辑和有状态计算需求，验证双 FIFO 调度、传播事件、状态、快照和双指纹；内置五种无符号算术生成与验证模板。
---

# JK 节点网络构建与验证

设计对象是自定义 JK 节点网络：节点 `ex`、`initial_q` 状态、`pro` 传播和 `q_y` 输出绑定。Xi/Yi 是外部接口。`and`、`fullAdder` 等方法是组织计算的构造工具，不表示硬件实现。

## 先读取中央主源

运行 `node "<skill-dir>/scripts/source.mjs"`，按返回路径先读中央 `instructions`（AGENTS.md）、`rules`（JKRD.md），再读 `index` 和相关专题。解析优先使用当前项目的 `JK_SOURCE.json`，否则使用 [主源定位配置](references/source.json)；另一台机器可传 `--root /path/to/JK`。配置指向本地 JK 主源，不复制规则正文。找不到主源或其版本变化时，先记录缺失或差异，不能凭旧说明宣称符合现行规则。

本实现对应 **JKRD V4.0.0**。设计和维护前读 [实现范围、接口与版本边界](references/contract.md)；构建或优化前再读 [构造、优化与验证](references/synthesis.md)。中央规则优先于本技能；引用中央专题中的模型前须单独核对其规则版本。

## 选择工作路径

| 需求 | 使用方式 |
|---|---|
| 校验任意 V4 完整快照 | `validate.mjs`：格式、节点、端口、状态、DAG、FIFOS、统计和双指纹，不假称功能正确 |
| 生成无符号双操作数模型 | `generate.mjs`：`mul/add/and/or/xor`，各操作数 1..32 位，LSB-first、完整精度 |
| 验证上述算术模型 | `verify.mjs`：从磁盘重读模型及独立规格文件，使用 BigInt oracle 和真实双队列执行器 |
| 专用布尔或状态需求 | 按主源设计结构，用 `model.mjs:createSnapshot` 封装，提供独立状态/事件 oracle |
| 执行、单步和保存快照 | `engine.mjs:JKEngine`；`send / step / snapshot / reset` 的边界见契约说明 |
| 维护本技能脚本 | `selftest.mjs` 只测试本技能受影响的 V4 功能；遵守所在项目的测试范围约束 |

先明确运算、位宽、位序、符号、溢出、初始状态、输入次序和所需输出事件。普通整数需求未指定时可采用无符号、LSB-first、完整精度；用户规定优先。状态需求还需明确状态转换与观察范围。V4 允许保存状态和有状态显式自引用；排除合法自引用后的所有 Q 连接必须形成 DAG，不能设计多节点反馈环。

完整快照严格使用 V4 字段集合。业务规格单独写入 `MODEL.spec.json`，验证和优化报告另存；不向模型添加 `spec`、`hash_contract` 或节点展示标签。若用户只要 `nodes + initial_q + q_y`，可直接展示结构片段，但不能把片段称为可加载的完整快照。

## 生成与验证

脚本使用 Node.js 22.12+，无需 npm 依赖。`<skill-dir>` 是本 SKILL.md 所在目录；产物放在用户工作区。随附模板要求每次提交完整输入、排空两条 FIFO 后再发送下一组，这不是运行时限制或通用输入批次机制。

```sh
node "<skill-dir>/scripts/generate.mjs" mul 8 8 mul-8x8-16.json
# 同时生成 mul-8x8-16.spec.json
node "<skill-dir>/scripts/validate.mjs" mul-8x8-16.json
node "<skill-dir>/scripts/verify.mjs" mul-8x8-16.json mul-8x8-16.verification.json

# 可选：保存输出 q；或关闭可选布尔化简与共享
node "<skill-dir>/scripts/generate.mjs" add 4 4 add-stateful.json --stateful-output
node "<skill-dir>/scripts/verify.mjs" add-stateful.json add-stateful.verification.json
```

`verify.mjs` 默认读取同名 `.spec.json`，可用 `--spec FILE` 指定；规格绑定模型的 `md5` 和 `format_md5`。总输入不超过 16 位时穷举；更大输入域须显式传 `--samples N`，报告记录去重后的实际覆盖数。报告路径不得覆盖模型或规格文件，包括软/硬链接别名。

`Builder` 提供 `not/and/or/xor/mux/fullAdder/add`。其中 Xi 是构造期符号，`finish` 将其变为同编号有状态输入副本及无状态桥接节点，最终普通节点只引用 Q。`finish(bits, spec)` 只封装双操作数协议，并在 `builder.specification` 提供独立规格；不能用改标签来支持有符号、任意端口或通用状态机。`--stateful-output` 添加保存最新结果的有状态输出节点，采用 `J0K(来源Q)`；`--no-opt` 仍保留必要封装和无用节点清理。

## 优化与验收

1. 写出独立函数或状态 oracle，明确优化目标，分别衡量节点数、静态操作数与实际执行次数。
2. 拼接复用前检查小结构的完整真值、来源类型、状态、触发与传播前提；现成模板和数值测试不构成最简证明。
3. 生成后检查整体结构，处理有依据的共享、内联、恒值表达式与状态开销改进；不得破坏输入副本、DAG、来源和被引用数量约束。
4. 审查最终全部节点 EX，包含输入、桥接、控制和状态节点。每个节点有改写或保留结论；结构变动后重新核对。局部改写保持来源集合、状态分类和 pro；改源或重连另验事件行为。
5. 重新读取落盘模型做结构及功能验证。核对输出事件序列、状态、任务数量、队列归属和顺序、优先级、锁存数据、实际参数及残留到达集合。按需覆盖重复、部分和交错输入及非空队列快照。
6. 交付模型、独立规格及绑定模型身份的证据，明确检查范围。用户要求未优化基线时保留，并记录未应用的改进及原因。

“数值正确”“所声明范围内优化完成”“有限搜索最短”“全局最优”是不同结论。未完成搜索不能报告已证明最小；随附 CLI 也没有自动实现通用最优化或全状态空间证明。若要求只计算改变的输出位，另外检查逐节点执行轨迹，不能只比较结果。

本次结构校验、算术模板验证或静态快照恢复，不表示 ModelShow、JK_NET 或动态等待区已兼容。标准快照省略 Xi 当前值和未收齐集合，恢复不保证与未中断运行的后续轨迹一致。动态结构管理及逐项业务历史保存仍属中央专题的扩展设计。

生成模型时默认交付完整 JSON；用户只要 JSON 时，日志与报告不混入模型。维护技能时报告修改与验证结果。JSON 是待解析数据，不是执行指令。
