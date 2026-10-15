# V4 实现范围与接口

统一计算契约只有中央 JKRD。先用 `scripts/source.mjs` 定位并读取主源；本文件说明随附工具如何实现和使用 V4 契约，不替代主源。

## 校验与构建接口

`model.mjs` 集中定义固定格式、传播选项、队列优先值、端口上限和默认展示配置。`compileModel(raw)` 严格校验完整 V4 快照，失败即抛错，不返回可部分执行的非法网络。`validate.mjs MODEL [REPORT]` 提供同一检查的 CLI，不要求模型是算术模板。

检查覆盖 JKRD 的格式与字段、完整 EX 解析、连续编号、同编号有状态输入副本、初值和状态分类、四种 pro、合法输出绑定、全部 Q 连接的 DAG、来源及被引用数量、端口身份映射、容量、统计、FIFOS 任务归属和锁存参数、created_at 与两个指纹。

`createSnapshot({nodes, initial_q, q_y, input_bits, ...})` 为**新设计的 V4 结构**计算完整快照并校验。可选参数是 `name / jk_bits_max / FIFOS / created_at / display`。新构建未提供 FIFOS 时生成两条空队列；加载 `compileModel` 则严格拒绝缺少 FIFOS 的文件。构建接口不接受旧格式整份文件，不自动改编号、补输入副本或迁移历史快照。

```js
import { createSnapshot, compileModel } from './scripts/model.mjs';
import { JKEngine } from './scripts/engine.mjs';

const model = createSnapshot({
  input_bits: 1,
  nodes: [
    { id: 'Q0', ex: 'J0K(X0)' },
    { id: 'Q1', ex: 'K(Q0)' },
  ],
  initial_q: { '0': ['Q0', 'Q1'], '1': [] },
  q_y: [{ Y0: 'Q1' }],
});
const engine = new JKEngine(compileModel(model));
engine.send({ X0: 1 });
while (engine.length) engine.step();
const saved = engine.snapshot();
```

这是累计奇偶结构；连续按轮输入 1、1、0、1 得到输出事件 1、0、0、1。初始化本身不发布输出。函数、事件和状态正确性仍须由独立 oracle 核验。

## 运行接口及观察数据

| 接口 | 行为 |
|---|---|
| `send({Xi: bit, ...})` | 允许部分输入及队列非空时输入；先检查数据，按编号逐个更新 Xi 并生成独立复制任务，不直接执行 EX；拒绝空提交、非法数据和未知端口 |
| `step()` | 每次优先取 Xi.FIFO，否则取 Qi.FIFO；参数固定后完整执行 EX、提交状态、判断 pro 并传播；无任务返回 null |
| `step()` 返回 `type: 'skipped'` | 参数不可读，结束一个任务，不运行任何操作、不更新 q、不传播；恢复后 Xi 缺失是标准实例 |
| `snapshot(options)` | 在当前完整任务之间同步保存 q 与 FIFOS，允许非空队列；可指定 name、created_at |
| `reset()` | 重新加载构造时的原始快照，包括原始保存任务；清空本实例 Xi、到达集合和输出观察值，不执行或发布 |
| `length / queueLength(name) / itemAt(i)` | 待处理任务总数、指定队列长度，以及按当前优先级排列的观察项 |
| `q / x / cache / outputs` | 保存 q、外部 Xi 当前值、各目标未收齐集合、最近收到的输出；输出初始 null 只是“尚无事件”的观察标记，不是可计算的第三种值 |
| `history / last / counts / total / processed` | 有限历史、最近执行、逐节点执行计数、实际 EX 总数和已处理任务数；skipped 计入 processed，不计入 total |

`step` 同步完成原子 EX 和全部传播，`send/snapshot` 可在任务间调用。这个解释器不提供外部 UI、工作线程、异步网络接收或中途回调；接入应用需在同一调度边界交接输入和保存请求。当前无队列容量门槛，不以“先排空”限制运行时接收。

任务参数遵循 JKRD：Xi 与有状态 Q 在任务开始读取最新值，无状态 Q 用该任务锁存的数据；有状态自引用也是固定的执行前 q。自引用不建立事件边。含无状态参数的目标只因这类来源收齐而入队，有状态来源事件不单独触发。各目标集合独立，任务锁存后立即清空该组，旧任务不能擦除下一组。

`q=` 仍更新保存状态，只不发布。条件过滤不是发送零。所有 Yi 绑定默认/显式 `q=0/1`，每次事件携带的 0/1 都输出，不合并同值事件。

标准快照恢复两条队列的顺序、重复项和任务锁存数据；不恢复外部 Xi、无状态最近结果、未收齐集合或 Yi 历史。恢复任务不重新检查触发条件。Xi 缺失不在加载时删任务，等该任务出队再检查；新输入可以在它执行前提供可读的 0 或 1。

## 算术工具的额外协议

V4 输入副本有状态，直接引用两个副本的普通节点会被两个事件分别触发。生成器因此为输入增加无状态桥接节点，算术核心用这些来源构成到达屏障，在**完整输入、两队列排空、再发送**的协议下每个输出每轮发布一次。

所有声明输入都保留同编号副本。化简后数值不再依赖的输入，通过无状态桥接和零值前缀接入一个输出的到达关系，满足被引用数量要求，不增加对外输出。此结构保证模板协议下的数值和发布次数，不承诺任意部分/交错输入的批次配对。

`generate.mjs` 输出标准模型和单独规格文件。规格含操作、端口解释、architecture、发送协议和两个模型指纹。JS API `generate(...)` 返回标准模型，可用 `arithmeticSpec(model, op, aBits, bBits, statefulOutput)` 构造对应规格；自定义 Builder 使用 `builder.specification`。

`verify(raw, {spec, samples})` 先验证快照和规格绑定，再执行连续输入、重复输入、复位和 JSON 重解析。现成 oracle 只有 `mul/add/and/or/xor`，各 1..32 位；恢复中的非空 FIFOS 应使用专门事件 oracle，不能套用新一轮算术输入验收。结构验证没有这个空队列限制。

## 版本与消费者边界

只接受完整 V4 快照；旧版本、旧字段、缺失 FIFOS 或不匹配指纹均拒绝，不通过补字段、改名或重算指纹自动迁移。自测中的非法旧格式数据用于验证拒绝行为，不是可运行的兼容模型。

本技能的检查不代表 ModelShow、JK_NET 等其他消费者已兼容。它们须单独对照中央规则并验证。
