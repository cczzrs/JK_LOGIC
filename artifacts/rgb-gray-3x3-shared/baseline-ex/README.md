# 512 节点：循环复用的 RGB 灰度网络

九个 RGB 像素先保存到指定的 216 个状态节点，再轮流使用同一套 168 节点灰度核心。完整模型共 **512 个 JK 节点**，其中 **309 个有状态节点**；相对 4,339 节点的并行基线减少 3,827 个，约 **88.2%**。

灰度计算精确保持先前选定的整数公式：

```text
Gray = floor((77*R + 150*G + 29*B + 128) / 256)
```

每个颜色通道是无符号 8 位，最低位在前。该定点公式作用于输入的 RGB 字节，不做 gamma 解码；不等同于逐值精确计算十进制系数 0.299、0.587、0.114。

## 交付文件

- [指定 ID 的完整模型](rgb-gray-216-72.shared.json)：输入保存节点为 `Q0L1R0`～`Q215L9B7`，使用工作区已支持该语法的执行器。
- [数值 ID 兼容模型](rgb-gray-216-72.shared.modelshow.json)：仅把保存节点 ID 改为 `Q0..Q215`，原名称保存在 `spec.storage_name_aliases`，用于原版数值 ID 引擎。
- [主模型 FIFO 验证](rgb-gray-216-72.shared.verification.json) 与 [兼容模型 FIFO 验证](rgb-gray-216-72.shared.modelshow.verification.json)。
- [主模型核心数值穷举](rgb-gray-216-72.shared.truth-table.json) 与 [兼容模型核心数值穷举](rgb-gray-216-72.shared.modelshow.truth-table.json)：分别针对实际 JSON 中的共享核心穷举全部 16,777,216 种 RGB。
- [最终验证与压缩统计](verification-summary.json)：核对文件摘要、两模型的重命名对应、验证覆盖及基线指标。
- [示例输入](example-input.json)、[示例期望](example-expected.json) 与 [实际示例运行结果](example-run.json)。

并行版及其原报告保留在相邻的 `../rgb-gray-3x3/`，原生成命令默认仍生成并行版。

## 输入、输出与有效结果

```text
像素位置：   L1 L2 L3
             L4 L5 L6
             L7 L8 L9

p = 0..8，c = 0:R / 1:G / 2:B，b = 0..7
i = 24*p + 8*c + b
Xi → Q{i}L{p+1}{R/G/B}{b}
Y{8*p+b} = 第 p 个灰度像素的第 b 位
```

一帧中每个 `X0..X215` 恰好发送一次，允许分成互不重叠的多次发送，并在发送之间执行队列。缺少输入时，仅更新已收到的保存状态，不启动灰度运算；输出保持上一帧值，首次输出之前为 `null`。

**复用版在循环期间允许输出重复发布。必须在本帧全部 216 位输入均已发送、九轮运算结束且 FIFO 排空后，读取完整有效的 72 位结果。** 每个输出位每帧发布九次，但只在对应像素的轮次更新保存值，其余轮次保持。不能把首次输出事件或某个中间输出值当作整帧完成。

只有上一帧完成后才能开始下一帧。部分输入也可能令队列暂时为空，这不表示帧已完成；应补齐该帧缺位或复位放弃它。模型不保证帧内重复发送同一个 Xi、两帧重叠或外部修改运行状态的行为。

## 共享结构与有限循环

| 部分 | 节点数 |
|---|---:|
| 全部 RGB 输入保存 | 216 |
| 共享灰度核心 | 168 |
| 九个灰度结果的状态保存 | 72 |
| 共享 RGB 输入选择 | 24 |
| 像素选择状态 | 9 |
| 同步与有限令牌控制 | 23 |
| 总计 | 512 |

保存节点 `Q0..Q215` 使用 `J0K(Xi)` 覆盖保存输入。启动状态节点 `Q216` 直接等待全部 Xi；它的编号高于所有保存节点。因此最后一个 Xi 到达时，对应保存任务排在启动任务之前，已有保存任务也在其前，保证先保存完全部 216 位再运算。

`Q219..Q227` 为无状态令牌合并节点 M0..M8，`Q228..Q236` 为有状态令牌节点 T0..T8。每个 T 需要它自己的 M 事件与时钟 C（`Q218`）同时到齐；一个来源事件不能代替另一个来源。启动事件给九路 M 各提供一次初始令牌。T0..T7 的发布向后一位置提供下一轮令牌，T8 发布一次共享核心的 Tick。

第一轮九个 T 都可执行，第二轮只有 T1..T8 有令牌，之后每轮减少一个，直到第九轮仅 T8 执行。每轮核心完成、72 个结果状态均写回后，`Q511` 才发布完成事件，产生下一次 C。第九次完成后已没有 M 令牌可继续触发，所以反馈自然停止。这一停止机制由来源到齐与令牌消耗保证，不依赖 q 值变成零。

像素选择使用八个阈值状态 s1..s8 和一个临时状态：当前像素索引为 p 时，`s_k = 1` 当且仅当 `p >= k`。每次 Tick 先更新选择状态，再由 24 个多路选择节点读取当前像素的 RGB。循环的第 1～9 轮依次选择 L1～L9，帧末阈值状态均回到 1，下一帧可直接再次开始。

核心内部通过三节点全加器及纯组合 `ex` 内联减少节点。输入选择、核心、结果写回和下一轮启动都保留明确的到齐依赖。输入的 216 个 q 在循环中一直保存整帧 RGB，不用来暂存算术中间结果。

## 初始化、空闲与执行次数

初值中只有八个阈值状态为 1，其他 301 个状态为 0。加载或 reset 后，Bootstrap 和 C 各执行一次，共 **2 次初始化执行**，不发布图像输出。

正常空闲时，九个 T 的缓存各保留一个值为 1 的 C 到达记录，其余到达缓存均为空。此记录用于等待下一帧的 M 令牌，因此空闲不要求所有缓存都为空。重新加载 JSON 是重新初始化，不是恢复已有队列或未完成帧。

一帧完整输入的固定执行次数为 **2,791**（不含初始化）：

```text
216 保存 + 1 启动 + 9 C + 45 M + 45 T + 9 Tick
+ 81 选择状态更新 + 216 RGB 选择 + 1512 灰度核心
+ 648 输出状态写回/发布 + 9 核心完成 = 2791
```

每个核心节点每帧执行九次。节点数、存储的 `ex` 操作量、实际执行操作量、队列峰值与耗时在报告中分别记录；节点减少 88.2% 不意味着硬件面积或耗时也减少 88.2%。

## 最终验收结果

两份最终落盘模型分别通过 **16,777,216 种 RGB 核心穷举**和 **10,940 帧完整 FIFO 验证**。每份包含 10,000 个随机帧以及黑白与彩色边界、全部 256 个等值灰阶、216 个单高位与 216 个单低位输入、重复帧、216 种缺位补齐、分批及逐位发送、复位和重载场景。完整输入向量去重后各为 10,920 个，重复测试用于检查跨帧行为。

每个完成帧均检查全部输入 q 保持、核心恰好九次执行、输出状态的条件更新、每位九次发布、最终灰度、有限令牌执行顺序和空闲缓存。加载后初始化为 2 次节点执行、7 个 J/K 操作；每帧为 2,791 次节点执行、20,405 个 J/K 操作。两模型仅节点引用名称不同，并已分别在支持指定 ID 的工作区引擎和原版数值 ID 引擎上通过验证。原版引擎文件与本次检查的 ModelShow 引擎 SHA-256 相同；未执行网页 UI 验证。

| 指标 | 保留的并行基线 | 共享版 |
|---|---:|---:|
| JK 节点数 | 4,339 | 512 |
| 有状态 q 位数 | 216 | 309 |
| 静态 `ex` 中 J/K 操作总数 | 13,449 | 2,887 |
| 每帧节点执行次数 | 4,339 | 2,791 |
| 每帧实际 J/K 操作次数 | 13,449 | 20,405 |
| 已测队列峰值 | 568 | 218 |

共享版减少节点，同时增加结果与控制状态；因核心反复执行，实际 J/K 操作次数高于并行版。共享版先完成初始化再发送示例时队列峰值为 217；完整验证还包含初始化未排空就发送输入的冷启动，峰值为 218。基线峰值来自保留的原报告，两者的测试调度范围不同，不能视为同条件性能基准。

生成器与结构防护的 6 项测试、技能的 15 项回归均通过，原并行核心也重新通过 RGB 穷举。生成器默认并行模式保持不变，新增 `--architecture shared` 选择共享版。

## 生成与验证

在工作区根目录使用 Node.js 22.12+：

```sh
node scripts/generate-rgb-gray.mjs --architecture shared
node scripts/verify-rgb-gray-shared.mjs artifacts/rgb-gray-3x3-shared/rgb-gray-216-72.shared.json artifacts/rgb-gray-3x3-shared/rgb-gray-216-72.shared.verification.json --samples 10000
node scripts/verify-rgb-gray-shared.mjs artifacts/rgb-gray-3x3-shared/rgb-gray-216-72.shared.modelshow.json artifacts/rgb-gray-3x3-shared/rgb-gray-216-72.shared.modelshow.verification.json --samples 10000 --engine /Users/cong/.codex/skills/jk-network-generator/scripts/engine.mjs
node scripts/verify-gray-truth-table.mjs artifacts/rgb-gray-3x3-shared/rgb-gray-216-72.shared.json artifacts/rgb-gray-3x3-shared/rgb-gray-216-72.shared.truth-table.json
node scripts/verify-gray-truth-table.mjs artifacts/rgb-gray-3x3-shared/rgb-gray-216-72.shared.modelshow.json artifacts/rgb-gray-3x3-shared/rgb-gray-216-72.shared.modelshow.truth-table.json
node scripts/run-rgb-gray-shared-example.mjs
node scripts/summarize-rgb-gray-shared.mjs
node --test scripts/rgb-gray-shared.test.mjs
node skills/jk-network-generator/scripts/selftest.mjs
```

本机 `node` 若不在 PATH，可使用 `/Users/cong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。`--engine` 指定实际测试的引擎文件，报告包含其 SHA-256；省略该参数时使用工作区执行器。

数值穷举针对共享的 24 位 RGB 算术核心。实际九次调用、状态、触发与终止由完整模型的 FIFO 验证另行检查，覆盖至少 10,000 个固定种子随机帧及边界、缺位、分批、重复和复位场景。报告绑定最终文件的 MD5、创建时间与 SHA-256，不宣称穷举 2^216 个整帧输入或所有状态轨迹，也不宣称全局最少节点。引擎验收与网页导入/显示验收是不同证据。
