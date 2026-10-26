# 项目进度看板 · dsh-project-board

DSH Web 侧边栏里的**原生**项目看板：五列按状态分，**天数只读机器时间**，拖动改状态直接写回
`projects.yaml`，单击就进那个项目继续开发。

![项目进度看板](docs/board.png)

[English](README.en.md) · 中文

---

## 它解决什么

任务看板管的是「一件事」，没有卡就什么都不显示。这里管的是「一个项目」：

- **项目永远在**，哪怕它一张卡都没有。
- **不用你维护时间**。天数是算出来的，取四个证据里最新的那个：
  DSH 会话记录 · git 提交（含未提交改动的文件 mtime）· 目录里最新文件改动 · 任务看板卡片执行时间。
- **首屏永远是最该动的那个**。按「最久没动」排序，不是按你上次想改的顺序。

它不统计百分比，不做甘特图，也不在面板里写 `intent` / `next`——那两句是你和 agent 说话时改的。

## 装

前置：`dsh web` 已经能跑，用 `web` profile。

```powershell
git clone https://github.com/sunzhiyueaa/dsh-project-board.git D:\work\portfolio
cd D:\work\portfolio
copy projects.example.yaml projects.yaml     # 然后填你自己的项目
dsh plugin --profile web add link:D:\work\portfolio
```

**装完要重启 `dsh web`**：客户端插件清单每个进程只扫一次，不重启侧边栏不会出现这一行。
之后改 `lib/client.js` 只需刷新页面；改 `package.json` 的 `dsh.client` 才需要再重启。

侧边栏出现「项目进度」，点它就是这张板。

## 怎么用（三件事）

### 1. 拖 → 改状态

把卡片拖到另一列，松手即写回 `projects.yaml`，4 秒内可撤销。

![拖动改状态](docs/drag.png)

落哪一列决定写哪个词：代码型拖到「在做」是 `building`，素材型拖到「在做」是 `editing`。
拖动过程不碰文件；松手才写。

### 2. 单击 → 进这个项目

打开它最后一次会话继续干活；没有会话就新建一个工作区 + 会话。

![单击进入项目](docs/enter.png)

### 3. 新增项目

右上角「+ 新增项目」。名称和「要干的内容」必填，其余可以以后补。
描述可以口语气，点「让 AI 改写」压成一句。

![新增项目](docs/create.png)

- **类型**：代码 / 素材——决定状态词表和素材往哪放。
- **素材**：多选文件，落到 `<项目路径>/素材/`（没有路径时落到插件的 `materials/<id>/`）。
- **路径**：给了路径才算得出「多久没动」。

## 数据文件

只有一份：`projects.yaml`，放在插件目录下。

```yaml
settings:
  staleDays: 5       # 超过这么多天没动静 → 黄
  zombieDays: 14     # 超过这么多天 → 红
  wipSoftLimit: 3    # 「在做」超过这个数，列头变黄提醒（只是提醒）

projects:
  - id: dsh-project-board
    name: dsh-project-board
    path: D:\work\portfolio
    kind: code            # code | material
    status: building
    intent: 一句话说清这个项目现在为了什么
    next: 下一个具体动作，一句话
```

人只写三样：`intent`、`next`、`status`（可选 `stage` 自由文本）。**不要手写时间戳**——那是机器算的。

状态词表故意按 `kind` 分两套：

| kind | 列 | 状态 |
|---|---|---|
| `code` | 在做 / 卡住 / 搁置 / 已完成 / 认账不做 | `building` / `blocked` / `paused` / `shipped` / `shelved` |
| `material` | 在做 / 卡住 / 搁置 / 已完成 / 认账不做 | `editing` / `blocked` / `paused` / `exported` / `shelved` |

`paused` 是「先停下，还会回来」；`shelved` 是「这事我不做了」。`shelved` 不删记录，
它照样在板上，只是不再是你的负担。

## 红黄绿怎么来的

```
最后动静 = max(最后会话时间, 最后 git 提交, 目录内最新文件改动, 最后一张卡的执行时间)
```

- 超过 `staleDays`（默认 5 天）→ 黄
- 超过 `zombieDays`（默认 14 天）→ 红
- 卡在 14 天那根红刻度上，一条 0–30 天的微条告诉你「离被忘掉还有多久」

这个判定**和你写的 `status` 完全无关**。所以你不会因为「忘了更新状态」而看不到真相。

## 几个设计取舍

- **颜色只编码时间，不编码状态**。状态已经写在列名上了，再染一遍颜色等于说两遍。
- **不做百分比**。项目进度没有分母，百分比只是让人安心的装饰。
- **面板只读，除了状态**。`intent` / `next` 由你和 agent 对话时改——那是需要思考的两句话，
  不该在输入框里顺手敲。
- **打开不等人**：宿主持有 15 秒缓存并在后台补算，客户端把上次结果存在 `localStorage` 先画出来。
  实测点开到第一张卡 41 ms。

## 目录结构

```
lib/host/index.js     路由、缓存、stale-while-revalidate、预热
lib/host/evidence.js  证据折叠：会话索引 / git / 文件 mtime / 看板卡片
lib/host/edit.js      yaml 行级改写（保留注释）、新建项目、素材落盘
lib/host/ai.js        描述改写（一次 llm 调用，45 秒超时）
lib/host/page.js      v1 的独立网页（/project-board 仍可直接打开）
lib/client.js         面板本体，手写 bundle，无构建链
cordis.patch.yml      把插件插进 profile 的一行
docs/                 截图
进度交接.md            设计与踩坑记录（中文，比较长）
scripts/check.mjs     离线自检：yaml 合法 + 路由能响应
```

## 已知限制

- 客户端插件清单**每个 `dsh web` 进程只扫一次**，新装或改 `dsh.client` 必须重启。
- Windows 上起 git 子进程很贵，所以 git 结果按路径缓存 20 秒，并行折叠。
- 写完 yaml 后面板自己刷新；外部改文件最多等 15 秒（或者点「刷新」）。
- 面板不写 `intent` / `next`，这是故意的。

## License

MIT
