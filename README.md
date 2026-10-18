# 自动化豆包生图

驱动本机安装的 **豆包桌面版**（Chromium 内核，通过 DevTools 协议控制）按需求生成图片，
并且负责**监制**：自己决定画幅比例、自己写提示词、逐张看结果、不合格自动打回重做、
最后按规范命名归档。

> **除商业用途外，其他都允许。** 本仓库采用自定义的[非商业使用许可](LICENSE)：
> 你可以自由使用、复制、修改、分发甚至再许可，唯一的限制是**不得用于商业用途**。
> 因为限制商用，它不属于 OSI 认可的开源许可证，属于「源码可用（source-available）」。
> 需要商用授权请联系作者。

## 它解决什么问题

用豆包出图有三个反复踩的坑：

1. **比例不受控**——提示词里没有比例线索时，豆包一律返回 1:1。方形画布会把按钮、横幅、竖屏背景全毁掉。
2. **没人验收**——豆包一次给 3 张，好坏要人肉看。
3. **归档靠手**——下载、改名、找目录，每次都要重来。

这个 agent 把这三件事都接了过去。比例在出图前就定死，出图后校验实际尺寸；候选图逐张过审片清单；
不合格就打回，最多 3 轮；合格才归档，并留下可追溯的侧车 JSON。

## 实测数据

| 场景 | 结果 |
| --- | --- |
| `9:16` 竖版启动页 | 1520×2720，底部留白可用于按钮 |
| `3:1` 按钮素材 | 3536×1168，按钮横向铺满画布 |
| 不写比例 | 2048×2048（1:1，默认行为） |
| 一次生成耗时 | 30-60 秒，通常 3 张，偶尔 1 或 5 张 |

## 组成

```
engine/                引擎（零依赖，Node ≥ 22）
├─ run.cmd             双击入口（交互式向导）
├─ run.mjs             交互式：描述 → 选用途 → 确认 → 生成 → 挑图 → 归档
├─ agent.mjs           命令行（输出 JSON，供上层 agent 调用）
├─ config.json         exe / 端口 / 输出目录 / 命名模板
└─ lib/
   ├─ cdp.mjs          CDP 客户端（内置 WebSocket，无需 npm install）
   ├─ doubao.mjs       豆包驱动：启动、发消息、轮询、抓图
   └─ ratios.mjs       24 类用途的比例规范表

skill/SKILL.md         DSH 技能说明：提示词模板、审片清单、打回规则、命名规范
preset/                DSH agent 预设声明（把它做成可选的专职 agent）
```

## 安装

### 1. 引擎

把 `engine/` 复制到任意目录，改 `config.json` 里的 `exe` 为本机豆包路径，然后：

```powershell
node agent.mjs health     # 检查调试端口
node agent.mjs launch     # 冷启动：重启豆包并打开调试端口
node run.mjs              # 交互式使用
```

豆包 exe 一般在：
`C:\Users\<你>\AppData\Local\Doubao\Application\app\Doubao.exe`

### 2. 技能（可选）

把 `skill/` 放到 `%USERPROFILE%\.dsh\skills\doubao-image\`，技能会自动出现在 DSH 的技能目录里。

### 3. Agent 预设（可选）

把 `preset/preset-doubao-image.yml` 的内容追加到
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾，重启 DSH，
设置 → Agent 预设 里会出现「自动化豆包生图」。

## 用法

### 交互式

双击 `run.cmd`：

```
描述你要的图 → 选用途（决定比例）→ 确认提示词 → 等待生成 → 输入编号保留 / n 打回重做 → 起名归档
```

### 命令行

```powershell
node agent.mjs ratios                                   # 比例表（24 类用途）
node agent.mjs gen --prompt-file p.txt --title "按钮" --category ui-button
node agent.mjs gen --prompt-file p.txt --title "海报" --ratio 3:4
node agent.mjs gen --prompt-file fb.txt --title "按钮" --reuse   # 同一对话打回重做
node agent.mjs pick --stage <目录> --pick 1 --title "开始冒险按钮底图"
```

所有命令输出单个 JSON，字段里 `ratio` / `ratioSource` / `ratioOk` 说明比例是怎么定的、豆包有没有照做。

## 原理

豆包桌面版是 Chromium 应用，启动时加 `--remote-debugging-port=9333` 即可用 DevTools 协议精确操作：
点「新对话」、往 ProseMirror 输入框写提示词、轮询页面里的新图、在页面上下文里 fetch
带签名的 CDN 原图。全程不依赖截屏找坐标，因此对窗口大小、分辨率、缩放都不敏感。

几个实现上的关键点（都踩过）：

- 同一张图的缩略图与全图在不同 CDN 域名下，必须按图片哈希去重；
- 基线快照要在进入目标对话**之后**取，否则上一轮的图会被误算成本轮；
- 候选图是一张张出现的，必须等数量稳定才算完；
- 侧边栏存在与「新对话」同名的历史会话，必须精确匹配按钮节点。

## 已知限制

- 原图右下角有「豆包AI生成」水印，本工具不做去除（交给下游 PS 处理）。
- 单实例：豆包只有一个窗口，不要并发跑两个生成任务。
- `launch` 会关掉正在运行的豆包窗口（登录态保留）。
