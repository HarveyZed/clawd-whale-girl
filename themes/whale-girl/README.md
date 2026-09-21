# 鲸鱼娘 Whale Girl — Clawd on Desk 主题

v1.6.0 · 11 个状态 + 5 组反应，共 24 个素材：12 个动画 WebP、3 个静态 WebP、2 个静态 PNG、7 个 SVG 运动层。

## 安装

**方式 A（推荐）**：把 `whale-girl` 整个文件夹复制到 Clawd 用户主题目录，重启后在「设置 → 主题」里选择：

    Windows: %APPDATA%\clawd-on-desk\themes\whale-girl
    macOS:   ~/Library/Application Support/clawd-on-desk/themes/whale-girl
    Linux:   $XDG_CONFIG_HOME/clawd-on-desk/themes/whale-girl

**方式 B**：设置 → 主题 → 导入主题 zip，选仓库根目录下的 `themes/whale-girl.zip`。

## 内容

- `theme.json` — 状态绑定、reactions、hitBoxes、viewBox/layout、`roamFlipAssets`、`timings`
- `assets/` — 24 个素材。画面本体是上游精灵图的裁切（无损 WebP/PNG）；其中 7 个 `*-follow.svg` 是**运动层**包装，内部用 `<image>` 引用同一张图，只加位移/旋转，不重采样像素。

状态映射：`idle` `thinking` `working` `sleeping` `waking` `error` `attention` `notification` `juggling` `roam` `sweeping`。
反应：拖拽（默认 / 左 / 右）、左键单击、右键单击、双击（恼火）。

## 动画与运动层

帧序与节奏取自上游 [vlln/whale-girl](https://github.com/vlln/whale-girl) 的 `lib/assets/manifest.json`（该文件是其客户端的权威配置）：

| 状态 | 帧 | 节奏 | 播放方式 |
|---|---|---|---|
| `idle` | 3 | 2600 / 300 / 300 ms | 常态停帧、偶尔眨眼 |
| `working` | 3 | 330 ms | 循环 |
| `attention` | 3 | 250 ms | 循环 |
| `juggling` | 3 | 250 ms | 循环 |
| `roam` | 4 | 170 ms | 1,2,3,2 往复 |
| `sleeping` | 2 | 1100 / 1500 ms | 循环（吸短呼长） |
| `waking` | 3 | 800 / 400 / 300 ms | 一次：睡姿 → 伸懒腰 → 揉眼 |
| `error` | 2 | 130 ms | 一次，之后持续抖动 |
| `notification` / `thinking` | 1 | — | 由运动层驱动 |
| `sweeping` | — | — | 借 `thinking` 姿势 + 运动层 |

**运动层**是本主题自己的设计：`idle` 呼吸、`thinking` 悬浮、`notification` 轻弹、`drag` 钟摆、`error` 抖动。Clawd 的实际显示尺寸约 137×153（源图 256），缩放约 0.68×，因此幅度按「屏幕上至少 2px 位移」标定——低于这个值肉眼几乎看不出来。

`sweeping`（上下文压缩）借用 `thinking` 的姿势：它的「?」气泡与 `working` 的灯泡天然可区分，上游也没有「整理/清扫」素材。

## 版权与署名

- 角色美术来自 **vlln/whale-girl**（MIT License, Copyright (c) 2026 Sam Gao），经切片与格式转换。
- 该角色属社区二创；**再分发请保留上面这条署名**，商用前请自行确认原作者与素材来源的授权。
- 仓库根目录的 `LICENSE`（MIT）覆盖插件代码；本目录的素材版权沿用上游署名。

## 改造

换图覆盖 `assets/` 里的同名文件即可；增删状态要同步改 `theme.json` 的 `states` / `reactions`。想调运动幅度只改对应 `*-follow.svg` 里的 `@keyframes`——底图像素不会被重采样。改完用 Clawd on Desk 自带的校验脚本跑一遍：

    node <clawd-on-desk>/scripts/validate-theme.js <theme-dir>

眼球追踪未启用：它要求 idle 变成「静态底图 + 矢量眼睛」，会牺牲现在明显的眨眼动画，而瞳孔在这个显示尺寸下只能移动约 1.7px，收益不划算。
