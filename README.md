# DSH Desktop

**Windows 桌面版 DeepSeek Harness agent 工具。**

一个 Electron 壳，把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh web`）完整打包进单个可执行程序：双击打开，即得一个带原生窗口的 AI 编码 agent，无需安装 Node.js、pnpm，也不需要任何命令行操作。

> English summary below — see [English](#english).

---

## ✨ 特性

- **双击即用**：内置完整的 `dsh web` 后端与全部插件依赖，开箱即用
- **原生窗口**：Electron 窗口加载本地 Web GUI，支持缩放、全屏、剪贴板快捷键
- **零冲突启动**：每次启动由操作系统分配空闲端口，绝不与正在运行的 `dsh web` 冲突
- **数据互通**：会话、设置、profiles 与 CLI 共享同一个 `$DSH_HOME`（默认 `%USERPROFILE%\.dsh`）
- **优雅降级**：PowerShell 7 优先，自动回退 Windows PowerShell 5.1；外部链接在系统浏览器打开
- **启动画面**：冷启动初始化期间立即显示进度提示，不会"看起来卡死"
- **单实例**：重复双击只会唤起已有窗口

## 📦 使用

从 [Releases](https://github.com/HUSTforever/dsh-desktop/releases/latest) 下载：

| 方式 | 启动耗时 | 说明 |
|---|---|---|
| **安装包** `DeepSeek-Harness-Setup-*.exe` | 首次 ~20s，之后 ~2s | **推荐**。运行后自动安装完整的 dsh 后端到本机，并创建桌面/开始菜单快捷方式，装完双击图标即可使用 |
| 免安装目录 `win-unpacked/`（随源码构建） | ~2s | 复制整个文件夹到任意位置即可 |
| 便携版 `DeepSeek-Harness-*-portable.exe` | 每次 ~4–5 分钟 | 单文件便于分发；每次启动需自解压全部载荷 |

首次运行 SmartScreen 提示为未签名程序的正常现象：选择「更多信息 → 仍要运行」。

打开后在 **设置 → Models** 中配置模型与 API Key（或提前设置系统环境变量 `DEEPSEEK_API_KEY`），然后即可开始对话。

## 🚀 从源码构建

前置要求：Windows 10+、Node ≥ 22.19、pnpm，以及官方仓库源码位于同级目录 `../deepseek-harness`（或用 `DSH_REPO` 指向任意位置）且已构建 Web 前端：

```sh
# 1. 官方仓库：构建 Web 前端
cd ../deepseek-harness
pnpm install && pnpm run build:web

# 2. 本项目：构建桌面产物
cd ../desktop
pnpm install
pnpm run dist        # = tsdown 构建 + 后端准备 + electron-builder 打包
```

产物输出到 `release/`：

- `DeepSeek-Harness-<version>-portable.exe`
- `DeepSeek-Harness-Setup-<version>.exe`
- `win-unpacked/` — 免安装目录版

## 🏗️ 工作原理

```
┌──────────────────────────── Electron 主进程 ────────────────────────────┐
│  1. spawn 内置后端                                                       │
│     <engine> backend/lib/bin.js web --host 127.0.0.1 --port 0           │
│     · 打包版 engine = Electron 自带 Node（ELECTRON_RUN_AS_NODE）          │
│       并附加 --expose-internals 以启用 Loader 内部钩子（HMR/bare-import） │
│     · 开发模式 engine = 系统 node                                        │
│  2. 等待就绪行 "dsh web: http://127.0.0.1:<port>"                        │
│  3. 打开窗口加载该 URL；关闭窗口时 taskkill /T /F 结束后端进程树           │
└─────────────────────────────────────────────────────────────────────────┘
```

后端依赖树由 `scripts/prepare-backend.mjs` 从官方仓库生成：`pnpm deploy --legacy` 取得生产闭包后，将闭包内所有工作区与 registry 包**扁平化 hoist** 到顶层 `node_modules`（绕过 legacy deploy 跳过 `workspace:^` peer 的缺陷与 Electron Node 的 `preserveSymlinks` 限制），删除冗余 `.pnpm` 层，并在打包前用 Electron 引擎真实 boot `dsh web` 做冒烟验证。electron-builder 自身的文件复制无条件排除 `node_modules`，因此由 `scripts/after-pack.cjs` 在 afterPack 阶段把整棵后端树复制进 resources。

## 🔧 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_REPO` | 官方仓库根目录（默认同级 `../deepseek-harness`） |
| `DSH_DESKTOP_BACKEND` | 直接指定 CLI `lib/bin.js` 路径（开发/测试覆盖） |
| `DSH_DESKTOP_NODE` | 运行后端的 Node/Electron 二进制 |
| `DSH_DESKTOP_DEBUG=1` | 将后端输出镜像到控制台 |

后端日志每次运行都会写入 `%APPDATA%\DeepSeek Harness\backend.log`。

## 🧪 冒烟测试

无头验证构建产物（CI 友好，不保留窗口）：

```sh
electron . --smoke            # 拉起后端，打印 SMOKE_READY <url>，退出码 0
electron . --smoke-gui a.png  # 额外隐藏加载页面并截图，打印 SMOKE_GUI_OK
```

## ❓ 常见问题

- **SmartScreen 拦截**：产物未签名所致，选择「仍要运行」即可。
- **便携版很慢**：便携格式每次启动都要整体自解压（约 4–5 分钟），日常使用请选安装版或免安装目录版。
- **首次启动约 20 秒**：正在初始化 profile 与加载 120+ 插件，仅第一次；之后秒级。
- **想看后端日志**：`%APPDATA%\DeepSeek Harness\backend.log`。

## 📄 License & 致谢

[MIT](LICENSE) © 2026 CUGSakura

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）构建。打包产物包含 [Electron](https://www.electronjs.org/) 及其运行时依赖，相应许可文本随分发包附带于 `LICENSE.electron.txt` 与 `LICENSES.chromium.html`。

---

<a id="english"></a>
## English

**DSH Desktop** packages [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh web`) into a single double-clickable Windows desktop app: an Electron window over a fully bundled local backend — no Node.js, pnpm, or command line required.

- Download the installer from Releases and run it, or grab `win-unpacked/` for a no-install experience.
- Configure your model + API key in Settings → Models (or set `DEEPSEEK_API_KEY`).
- Sessions live in `%USERPROFILE%\.dsh`, shared with any dsh CLI install.

Build from source requires Node ≥ 22.19, pnpm, and the official repository at `../deepseek-harness` with its web frontend built (`pnpm run build:web`), then:

```sh
pnpm install && pnpm run dist
```

See the Chinese sections above for architecture details, environment variables, smoke-test modes, and troubleshooting.
