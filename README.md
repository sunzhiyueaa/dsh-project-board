# dsh-project-board

一个**只读**的项目进度面板：把 `projects.yaml` 和你机器上已有的证据——DSH 会话记录、
git 提交、文件改动时间、任务看板卡片——折叠成一张按**「最久没动」排在前面**的红黄绿清单。

它不统计百分比，不做甘特图，不在面板里编辑任何东西。它只回答两个问题：

1. **我现在该推进哪个？**
2. **哪个已经被我忘了？**

## 为什么不用任务看板

任务看板管的是「一件事」，它没有项目这个实体，而且**没有卡就什么都不显示**。
这个面板管的是「一个项目」，所以一张卡都没有的项目照样出现。

两者是上下层：面板读看板的未完成卡数当证据，不替代它。

## 装

```powershell
dsh plugin --profile web add link:D:\work\portfolio
```

profile 配了 `patchReload: live`，改代码后热重载；改 `cordis.patch.yml` 或 `package.json`
可能需要重启 GUI。

## 看

- `http://127.0.0.1:3080/project-board` —— 面板页面
- `http://127.0.0.1:3080/project-board/data.json` —— 同一份数据的 JSON

## 改

只改 `projects.yaml`。人只写三个字段：

| 字段 | 谁写 | 含义 |
|---|---|---|
| `intent` | 人 | 这个项目现在为了什么（一句话） |
| `next` | 人 | 下一个具体动作（一句话） |
| `status` | 人 | 阶段，词表按 `kind` 分两套 |
| `stage` | 人（可选） | 自由文本，比如「粗剪」 |

其余（最后动静、红黄绿、未完成卡数）**全部机器算**，你不用维护。

状态词表：

- `kind: code` → `building` / `blocked` / `paused` / `shelved` / `shipped`
- `kind: material` → `collecting` / `editing` / `paused` / `shelved` / `exported`

`paused` 是「先停下，还会回来」，`shelved` 是「这事我不做了」。`shelved` 不删除记录——
它照样出现在面板上，只是不再是你的负担。

## 红黄绿怎么来的

`最后动静 = max(最后会话时间, 最后 git 提交, 目录内最新文件改动, 最后一张卡的执行时间)`

- `staleDays`（默认 5）天没动静 → 🟡
- `zombieDays`（默认 14）天 → 🔴

这个判定**和人写的 `status` 完全无关**。所以你不会因为「忘了更新状态」而看不到真相。

## 自检

```powershell
node scripts/check.mjs
```

不开 DSH 也能跑：校验 YAML 结构、状态词表、插件契约、路由响应。

## 边界

- v1 是**网页**，不是原生侧边栏插槽组件。升级成原生面板需要 `tsdown` 构建链，属 v2。
- 不做百分比、甘特图、面板内编辑、token 成本统计、自动扫盘发现项目。
