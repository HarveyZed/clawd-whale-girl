# 鲸鱼娘 Whale Girl — Clawd on Desk 主题

v1.5.0 · 11 个状态 + 5 组反应，共 17 个动态 WebP。

## 安装

**方式 A（推荐）**：把 `whale-girl` 整个文件夹复制到 Clawd 用户主题目录，重启后在「设置 → 主题」里选择：

    Windows: %APPDATA%\clawd-on-desk\themes\whale-girl
    macOS:   ~/Library/Application Support/clawd-on-desk/themes/whale-girl
    Linux:   $XDG_CONFIG_HOME/clawd-on-desk/themes/whale-girl

**方式 B**：设置 → 主题 → 导入主题 zip，选仓库根目录下的 `themes/whale-girl.zip`。

## 内容

- `theme.json` — 状态绑定、reactions、hitBoxes、viewBox/layout、`roamFlipAssets`
- `assets/` — 17 个动态 WebP

状态映射：`idle` `thinking` `working` `sleeping` `waking` `error` `attention` `notification` `juggling` `roam` `sweeping`。其中 `sweeping`（上下文压缩）目前复用 `thinking.webp`，还没有专门的「整理/清扫」姿势。

反应：拖拽（默认 / 左 / 右）、左键单击、右键单击、双击（恼火）。

## 版权与署名

- 角色美术来自 **vlln/whale-girl**（MIT License, Copyright (c) 2026 Sam Gao），经切片与格式转换。
- 该角色属社区二创；**再分发请保留上面这条署名**，商用前请自行确认原作者与素材来源的授权。
- 仓库根目录的 `LICENSE`（MIT）覆盖插件代码；本目录的素材版权沿用上游署名。

## 改造

换图只需覆盖 `assets/` 里的同名文件；增删状态要同步改 `theme.json` 的 `states` / `reactions`。改完用 Clawd on Desk 自带的校验脚本跑一遍：

    node <clawd-on-desk>/scripts/validate-theme.js <theme-dir>

眼球追踪未启用（素材是 WebP 动画而非 SVG），所以主题卡片不会显示 Tracked idle 徽章。
