# 3×3 RGB 输入保存与灰度输出

输入 216 bit，先保存到 216 个有状态 JK 节点，再把对应的 9 个像素转为 72 bit 灰度。计算固定为：

```text
Gray = floor((77*R + 150*G + 29*B + 128) / 256)
```

这是针对输入 RGB 字节的整数加权近似，恰好半整数时向上取整，不进行 gamma 解码。中间最大值为 65,408，用 16 位保存算术结果；选取第 8～15 位得到灰度 0～255。每个像素独立计算，空间位置保持不变。

## 模型与端口

- `rgb-gray-216-72.json` 是主模型，216 个保存节点使用用户指定的 `Q{i}L{1–9}{R/G/B}{0–7}` 真实 ID。
- `rgb-gray-216-72.modelshow.json` 是数值 ID 兼容模型，保存节点改为 `Q0..Q215`，`spec.storage_name_aliases` 保留原名称映射。它用于只接受数值 ID 的原版引擎；不保证该应用会显示这些附加名称。
- 两份模型都是完整 JSON，各自包含 `nodes / initial_q / q_y / inputs / outputs / spec / md5 / created_at`。执行规则相同，但 ID 和模型摘要不同。
- `rgb-gray-216-72.verification.json` 与 `rgb-gray-216-72.modelshow.verification.json` 是分别绑定对应模型的 FIFO、状态与功能验收报告。
- `rgb-gray-216-72.truth-table.json` 独立记录单像素算术的 16,777,216 组 RGB 穷举及九个算术子图的同构检查；不替代 FIFO/状态验证。
- `verification-summary.json` 汇总最终验收结果，并检查报告绑定的文件摘要、两模型仅节点名称重映射，以及当前 ModelShow 引擎与兼容版实测引擎的一致性。

像素从左到右、从上到下编号：

```text
L1 L2 L3
L4 L5 L6
L7 L8 L9
```

设像素索引 `p=0..8`，通道 `c=0:R、1:G、2:B`，位编号 `b=0..7`（最低位为 0）：

```text
i = 24*p + 8*c + b
输入 Xi → 保存节点 Q{i}L{p+1}{R/G/B}{b}
输出 Y{8*p+b} → 第 p 个灰度像素的第 b 位
```

例如 `X0→Q0L1R0`、`X8→Q8L1G0`、`X16→Q16L1B0`、`X215→Q215L9B7`。全部保存状态初值为 0。节点执行 `J0K(Xi)`，覆盖保存本次输入的一位，随后保持至下次该输入事件或复位。**216 是保存输入的状态节点数，不是总节点数。**

当前模型共 **4,339 个 JK 节点**：216 个保存节点、216 个完成节点、1 个屏障、216 个快照节点、3,690 个灰度计算节点。除保存节点外，其余均无状态。每个像素的计算子图经常量简化和表达式共享，从比较基线的 433 个节点减为 410 个；总操作 token 数为 13,449，单节点最多 219 个 token，最多等待 216 个不同来源。

## 执行顺序与帧协议

1. 216 个保存节点各收到本帧对应输入后，写回自己的 q。输入可以一次发送，也可以分成互不重叠的多次发送；发送之间允许执行队列项。
2. 保存节点各触发一个无状态完成节点。完成节点的值固定为 1，仍保留对保存节点的事件依赖。`Q432` 等待全部 216 个完成来源到齐后，才发布一次完成事件。
3. `Q433..Q648` 等到完成事件，才读取全部保存的 q 并分别发布快照。后续九个无状态灰度计算子图只读取快照及其下游结果。
4. 每个 `Y0..Y71` 本帧各发布一次。等所有 72 位完成发布且 FIFO 排空后，整帧结果才完整有效；72 个输出并非原子同时更新。

每帧每个 `Xi` 必须恰好发送一次。下一帧必须等待本帧 216 位已齐、72 位输出已全部新发布且 FIFO 已排空。帧内重复发送同一个 `Xi` 或两帧重叠不属于此模型保证的协议。完全相同的完整帧可以连续发送，每次都会重新保存并输出。

缺少任意一位时，不启动本帧快照或灰度计算，不发布本帧输出；已发送输入保存在 q 中，未发送的 q 保持原值。此时即使 FIFO 为空也不表示帧完成，屏障中仍保留到达记录。应补齐缺失位，或复位放弃该帧。上一完整帧的输出值会继续保留；初始化后的输出为 `null`，不是有效零值。

本模型没有反馈环。规定协议下，每个保存节点、完成节点、屏障、快照和算术节点每帧各执行一次，节点数就是完整一帧的执行次数。这一推导依赖保存完成引用未被删减，不能把 `J0` 之前看似不影响数值的引用消去。

## 生成、运行与验收

在工作区根目录运行（Node.js 22.12+）：

```sh
node scripts/generate-rgb-gray.mjs
node scripts/verify-rgb-gray.mjs artifacts/rgb-gray-3x3/rgb-gray-216-72.json artifacts/rgb-gray-3x3/rgb-gray-216-72.verification.json --samples 10000
node scripts/verify-rgb-gray.mjs artifacts/rgb-gray-3x3/rgb-gray-216-72.modelshow.json artifacts/rgb-gray-3x3/rgb-gray-216-72.modelshow.verification.json --samples 10000 --engine /Users/cong/.codex/skills/jk-network-generator/scripts/engine.mjs
node scripts/verify-gray-truth-table.mjs artifacts/rgb-gray-3x3/rgb-gray-216-72.json artifacts/rgb-gray-3x3/rgb-gray-216-72.truth-table.json
node skills/jk-network-generator/scripts/selftest.mjs
```

本机若 `node` 不在 PATH，可用 `/Users/cong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`。

兼容版命令显式使用本机安装目录中的原版执行器，SHA-256 为 `c94bfe1cfc2b8e274066e0b26e34c367182076d6c62ba8c8ffbfc79f1dec238c`。本次也重新读取并确认当前 `ModelShow/src/engine.js` 的内容摘要相同。其他环境可以把 `--engine` 改为对应原版执行器路径；省略该选项则使用支持新 ID 的工作区执行器。

`example-input.json` 可以作为一次完整输入发送；对应的 RGB 与灰度矩阵见 `example-expected.json`，灰度结果为：

```text
  0 255  77
149  29 128
226 178 106
```

当前工作区的 `skills/jk-network-generator/scripts/engine.mjs` 支持命名主模型与数值兼容模型。用户全局安装的 skill 和外部 ModelShow 没有随此任务自动修改；它们若仍只接受数字 Q ID，应先使用兼容模型。兼容版在原版 FIFO 引擎中的验证与网页导入/显示验证是不同证据，报告只声明实际执行的检查。

验收报告绑定模型摘要、创建时间和实际文件 SHA-256。整帧功能/事件检查为边界、单比特、连续帧及固定种子抽样；单像素数值穷举另列。没有宣称穷举 2^216 个输入、任意帧交错或所有状态轨迹，也不宣称节点数达到全局最小。重新生成模型后须重读新文件并重新验收，旧报告不能代表新文件。

当前交付已通过：每份模型各 **10,938 个完整测试帧**（含 10,000 个固定种子随机帧），各 **47,460,196 次实际 FIFO 执行**，队列峰值 568；216 种各缺少一位的场景均先不输出、补齐后正确输出。单像素 **16,777,216** 组 RGB 数值穷举全部通过，并核对九份算术子图同构。节点 ID 扩展的完整技能回归为 **15/15 通过**。
