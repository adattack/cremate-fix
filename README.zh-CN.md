# CREMATOR · 记忆焚化工

Compaction Reinvented, Erase Meaningless Agent Token Overhead Reversibly.

> **本仓库是 fork，不是上游项目。**
>
> - 原项目：**[zman406986/Agent-Memory-CREMATOR](https://github.com/zman406986/Agent-Memory-CREMATOR)**
> - 本 fork：[adattack/cremate-fix](https://github.com/adattack/cremate-fix)
>
> 内容取自上游 v0.1.2 的源码，另加了一批修复与新增（见下文「本 fork 的改动」）。
> npm 上的上游包未做任何改动：从 npm 安装 `cremator-dsh` 拿到的是上游发布版，不是本 fork。
> 改动清单之后的正文均为上游文档，保持原样。

CREMATOR 是一个 TypeScript 库，专门给编码智能体的上下文做减法。常见的压缩都等窗口快满了才动手：让模型把历史重写成一篇摘要，或者把最旧的消息截掉。CREMATOR 反着来，趁内容还新鲜就删掉那些已经没用的工具结果，原地只留一条短回执。删掉的字节全部记进账本，凭召回 id 随时逐字节还原。

项目还在早期。三个包都已发布到 npm：安装 `cremator-dsh` 或 `cremator-opencode`，`@cremator/core` 会作为依赖自动装好。core 和 dsh 适配器在真实 dsh 会话里跑过，离线示例能端到端跑通。OpenCode 适配器目前只有针对假宿主的功能测试，真实运行的证据已经撤回，接入前先读 [OpenCode README](packages/adapters/opencode/README.md)。这个库对回答质量的影响还没有得到证实。

[English](README.md) · [中文](README.zh-CN.md)

---

## 本 fork 的改动

相对上游 v0.1.2（`c8f1136`）。逐条写明原来错在哪、怎么验证；此清单之外没有改动。

**修复**

- **被替换的槽位保留它所占位置的序号。** dsh 每轮通过
  `surfaceOp: {op:'replace', …}` 重新发布 system 提示，该事件自带
  `(turn, step)`，却仍占用对话的第一个槽位。原先的折叠先读事件自带的序号，
  于是遍历倒退（`2:2` 之后是 `1:1`），core 拒绝该快照上的所有计划，报
  `adjacency-changed`，表现为 `Cremation failed: prune apply rejected:
  adjacency-changed`。现在由槽位决定，事件自带序号降为兜底。已在两个真实故障
  会话（3,617 与 7,870 事件）上验证：序号单调、core 的对话校验通过。
- **`close()` 之后账本文件可独立使用。** `SqliteLedger.close()` 在
  `db.close()` 之前执行 `PRAGMA wal_checkpoint(TRUNCATE)`（随后 `VACUUM`）。
  没有这一步时主文件只是 4 KiB 的空壳，schema 与数据都在 `-wal` 里；只备份
  `ledger.sqlite` 会读到 "no such table"，所有召回 id 静默失效。检查点失败
  不会让关闭失败。`checkpoint()` 是公开方法，供导出或复制前调用。
- **依赖下限与构建一致。** `cremator-dsh@0.1.2` 用到了
  `@cremator/core` 的 `isTwoVerdictGrammar`，却声明 `"^0.1.0"`；新装环境
  解析到 0.1.1，该版本没有这个导出，插件在 ESM 链接阶段就挂。下限已改为
  `^0.1.2`，并新增启动测试：构建两个包、通过发布入口 import，此类问题不会再
  发出去。
- **宿主靠探测，不靠假定。** `peerDependencies` 从 `>=0.0.0-0` 收紧到
  `>=0.2.1-rc.2 <0.3.0`，且 `apply()` 与每次 step 边界会校验 `session` 与
  `surfaceOp` 的形状，不符时拒绝挂载并指明字段。过去这种不符要等到某次 pass
  失败、拿到一个关于「计划」的裁决才暴露。

**配置**

- 打包配置不再写死 `contextWindowTokens: 400000`。深度触发的停手线是该值的
  75%，所以固定值只对测量时那个模型正确：在 1M 窗口的模型上配 400,000，
  会在 300,000 就停手，白白浪费 70 万。不写则通过宿主的
  `resolveModelInfo` 解析**路由到的模型**自己的窗口。

**性能**

- `surfaceTranscript` 只折叠日志尾部。它携带 `ordinalAt`、`stepAt`、
  call facts、运行中的序号，以及每个表面位置已完成的 item，因此边界只读新增
  日志位置并复用已构建的 item。在 9,600 事件 / 4,000 节点上：冷折叠 3.35ms
  → 单结果尾部读取 0.54ms（6.2 倍）。`beforeSeq` 切割绕过 carry；日志变短
  则整体重来。
- `port.setTranscript` 直接接管投影，不再整体深拷贝（1,707 个 item 上
  4.98ms → 0.001ms）。
- 去掉了每个 step 边界上一次冗余的 `syncPass`。

**新增运维命令**

- `/cremate gc` —— 保留最近活跃的 `gcRetainSessions` 个会话，其余删除；
  活跃挂载持有的会话永远保留。存储本身永不过期：归档字节会一直留到目录被删。
- `/cremate export <sessionId>` —— 把该会话的归档（core 自己的
  `LedgerArchive.bytes`，与 `hydrate` 读回的同一份字节）写到
  `<crematorStorageRoot>/<sessionId>.archive.json`。
- `/cremate stats` —— 汇总 journal 已记录的内容：ask 次数、计费 token、
  释放字节、净收益。没有 usage 读数的 ask 记为「成本未知」，绝不算作免费。

**文档**

- 发布用的 README 去掉了开发机路径与内部工单编号。

## 问题在哪

编码智能体的上下文里，占大头的是工具输出，而这些输出未必还有用。智能体可能用过一次就再也不读第二遍，宿主光看对话记录，判断不出哪些结果还需要留着。主流 harness（承载智能体的宿主程序）的路子都差不多：先全留着，等窗口快满了再缩——要么让智能体给自己的上下文写摘要，要么不打招呼截掉最旧的消息。三个毛病：有损；删了什么没账可查；时机不对，总在任务做到一半的时候触发。压掉的字节没有召回 id，原文找不回来；丢了哪条事实，只能重新读、重新跑，token 再付一遍。CREMATOR 反着来：删除可逆，账本可查。

## CREMATOR 做什么

一部分内容靠确定性证明就能断定没用；剩下的去留，交给智能体自己裁决。

- **候选只有工具结果。** 用户消息和智能体自己的输出永远不进候选，任何规则、裁决、询问都碰不到它们。这是机制划定的范围，不是安全保证。批量询问看 `barBytes` 这道门槛，默认 512 字节：工具结果达到或超过它，整个结果算一个单元（unit）。entry 询问是结果刚落地时的单条询问，默认一个结果问一次，也可以攒几条一起问；它有自己的 `floorBytes`，不配就查 per-model 表，表里没有按 512 兜底。低于门槛的结果照常落地。手动 forget 不设字节门槛，只看证据：请求格式要对，行范围落在同一个单元内，而且恰好命中一个非写入、命中该路径的结果；命中多个就按歧义拒绝。
- **能证明的，直接删，不问智能体。** 静止期是模型调用之间跑的检查，认两条读取证明：读取过期——后来的写入让这次读取作废；重读取代——后来一份同样字节的重读顶掉了它。prune 是批量清理，默认删三类：落空片段的正文、被重读顶掉的旧副本、字节完全相同的重复副本。另有两类可选证明，默认关闭：superseded-by-reread，后来的整文件读取盖住早先的读取；call-echo，结果只是把调用参数复述了一遍。这两类不做字节比较。删掉的结果整条离开，原地追加一条回执。
- **搜索落空，先封存。** 围绕一次搜索、没找到目标的一组调用，算一个落空片段。封存就是追加一条负面事实：记下什么目标在哪些文件里没找到。原文先留着，后面的 prune 再把这整段结果删掉，留回执。
- **证不出来的，进询问表，智能体裁决。** 只有没删掉的单元才进表。重复副本里保留的那份照常可以进表，其他排除规则照旧；entry 询问已经定了保留的不再列出。裁决时智能体要附一句短说明，落进回执的短标签里。
- **触发看用量。** 上一次已计费请求的 prompt 达到 `pruneThresholdTokens`，就触发一轮 pass（一次批量处理）。用量以宿主上报的数为准，滞后一步；在第一条用量行出现之前才退回本地估算。第一次达到就触发。之后想再触发，要么用量曾回落到阈值以下，要么比基线又涨了一个阈值。触发开关（latch）在每轮 pass 结束后重置——不论这轮成败——pass 后的头一笔读数就是新基线。宿主自己做了原生压缩的话，触发记录清空，下次达到阈值就触发。
- **询问表发在副本上，主对话不动。** 触发之后，适配器把主对话当前状态复制一份（fork），询问表接在副本尾巴上发出去。一张表一次模型调用，列出所有还没定论的单元。每行只带路径、总行数和几个行锚点，不带结果正文。裁决就两个动作：forgetall，整条忘掉；keeplines，只留指定的行。问答不写进主对话，裁决按下面说的方式生效。
- **拒答有次数上限。** 拒掉的行，下一张表再问一次；还拒，再给一次纠正机会。同一行最多问三次。某张表一个字都没返回，只是停掉询问循环：没定论的单元留到下次触发，已证明的确定性删除照常应用。
- **entry 询问走另一条通道。** 它在主对话上临时追加一问一答：正常两条消息，纠正成功四条，纠正失败什么都不追加。keepall（整条保留）和 forget 之后都回退这次交换。entry 的删除也走这条路：先回退问答，再落地带 shape 标记的 shaped 回合，不追加 [not retained] 回执。
- **整条删除要过存活检查。** prune 里的整条删除——确定性规则和 forgetall——都要过守卫和存活检查（survivor gate）。守卫在应用前校验整次应用，要么全过、要么全拒。内容存活规则只在同一内容有多份候选时才查：对保留的那份 forgetall，取消的是"自动删副本"那条规则，forget 本身照常生效。落空片段和 call-echo 的删除靠自身证据，不受内容存活约束。静止期的两条读取证明不走这道检查；keeplines、forgetlines（只删指定行）、手动 forget 和 entry 回答由守卫校验，不走存活检查。
- **应用是回退加追加，从不原地改。** 一次删除应用——不管是手动 forget、一批裁决、一轮 prune 的确定性删除，还是一次静止期删除——都先把对话倒回最早那条被删结果之前，再追加回执：删一条结果，留一条回执。原结果节点（对话里的一条消息）离开；裁决保下的行在替换内容里、回执之前重新写出。追加之前先规划：先试一次整段替换；只有当区间起点是工具结果、而且盖住不止一个节点时，才改走单节点替换，每个被删的节点各换一次。用户消息开头的跨节点区间仍走整段替换。整段替换按原顺序重写区间里没删的节点；单节点替换不动幸存节点。回退点之前的前缀不变，照样能命中缓存；换掉的后缀失效。
- **每次删除都可逆。** 删掉的字节全进垃圾账本：只追加，按召回 id 归档。dsh 和 OpenCode 适配器都用持久账本，重启后照样逐字节还原；离线示例用内存账本，不跨重启。召回 id 只在本次会话内有效。回执里路径和召回 id 总在；行范围和短标签可省。

下面截一段示意：表只列两行；回执来自 [`examples/core-offline/`](examples/core-offline/README.md)——那里的 forget 删的是整个结果，所以回执没有行范围。

```text
1. [Read] src/needle.ts (call #1) — line 1 of 3 ends with "first line" · line 3 of 3 ends with "third line" [3 lines]
2. [Read] config.ts (call #1) — line 60 of 201 ends with "retries: 3" · line 140 of 201 ends with "exit 1" [201 lines]

[not retained] src/needle.ts — about: auth retry path · necromancy recall:sha256:…
```

## 对 harness 的要求

四条接缝，缺一不可：结果拦截、历史重写或程序化回退、追加式注册工具、静止期钩子（模型调用之间跑的钩子）。缺任何一条的 harness 都不支持；CREMATOR 也不做 MCP 代理。没有让对话记录完全不动的模式：record-only（只记录、不应用）下，prune 和 forget 都不应用，但静止期两条读取证明触发的删除、负面事实照常应用；entry 询问若开启，裁决也照常生效。

## 安装

Node `>=22.13.0 <23.0.0 || >=23.4.0`（这些版本里 `node:sqlite` 不用加 flag）。

```sh
npm install cremator-dsh
# 或
npm install cremator-opencode
```

`@cremator/core` 会自动装好。想改源码，就克隆仓库后运行 `npm install` 和 `npm run build`。

第一次上手，最省事的是 [`examples/core-offline/`](examples/core-offline/README.md)，不用 dsh 就能跑：

```sh
node --experimental-strip-types examples/core-offline/offline.ts
```

预期输出里有一行 `recalled 34 bytes byte-exact: true`。

dsh 是本项目开发时用的编码智能体 harness。OpenCode 用适配器 `cremator-opencode`（`npm install cremator-opencode`），配置全见 [packages/adapters/opencode/README.md](packages/adapters/opencode/README.md)。其他 harness 要自己写适配器，四条接缝见前文。

有 dsh 的话，用 dsh 适配器：把下面这段存成文件，传给 `dsh --patch`。`name` 是 file:/// URL，指向构建出来的入口：

```yaml
- insert:
    - id: cremator-mount
      name: 'file:///path/to/Agent-Memory-CREMATOR/packages/adapters/dsh/dist/plugin.js'
      config:
        barBytes: 512
        enforcement: apply
        contextWindowTokens: 400000
        pruneThresholdTokens: 60000
        entryAskTrigger: { mode: 'off' }
        nativeCompactionBackstop: true
```

每个 `config` 键都可省，但有讲究：只写 `pruneThresholdTokens`、不写 `contextWindowTokens`，直接抛错，挂载失败；只写 `contextWindowTokens`，走已弃用的半窗路径；两个都省，自动 prune 不触发。示例配置用 `entryAskTrigger: { mode: 'off' }` 关掉 entry 询问（这个键只有 dsh 适配器有）；不写它，默认每个结果落地时问一次。这条通道留给手动或兼容场景用。config 键、存储布局、降级行为详见 [packages/adapters/dsh/README.md](packages/adapters/dsh/README.md)。不配存储时，垃圾账本落在 `<DSH_HOME>/storages/cremator`；DSH_HOME 没设，就是 `~/.dsh/storages/cremator`。把 URL 里的路径换成你本地克隆的绝对路径，指向 `packages/adapters/dsh/dist/plugin.js`；`file:///` 前缀保留，Windows 上写成 `file:///C:/...` 这种形式。

[`examples/dsh-mount/`](examples/dsh-mount/README.md) 有完整写法，启动命令（从仓库根执行）：`dsh --profile headless --patch examples/dsh-mount/patch.yml "your task"`。[`examples/core-offline/`](examples/core-offline/README.md) 只跑 core，不带适配器。

dsh 适配器也可以作为 dsh 插件包安装。把 profile 指向本地的包目录：

```sh
dsh plugin --profile <name> add link:<本仓库 packages/adapters/dsh 的路径>
```

安装后，dsh 的插件页会列出 CREMATOR，斜杠菜单里会多出 `/cremate`；直接输入 `/cremate` 也仍然能触发同一轮清理。

## 包

三个包都发布在 npm 上。用 `npm install <包名>` 安装；想改代码就从仓库构建。

| 包 | 内容 |
| --- | --- |
| [`@cremator/core`](packages/core/README.md) | 计量器（估算 prompt 的 token 数）、片段（episode，围绕一个目标归组的对话段）、规则、全有或全无的守卫、只追加的 SQLite 垃圾账本、回退规划器（core 定回退点与回执挂点，适配器写回保留行）、引擎。不导入任何 harness 代码。 |
| [`cremator-dsh`](packages/adapters/dsh/README.md) | dsh 适配器：接缝映射、挂载入口、`forget` 与 `necromancy` 两个工具。`necromancy` 按召回 id 把删掉的字节原样还原。 |
| [`cremator-opencode`](packages/adapters/opencode/README.md) | OpenCode 适配器，细节见其 README。 |

## 许可证

Apache-2.0，见 [LICENSE](LICENSE)。
