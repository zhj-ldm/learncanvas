# LearnCanvas

> 用户只负责提问，AI 负责把知识「画」出来、讲出来。

LearnCanvas 是一款基于 Electron 的桌面 AI 学习应用。它把「画布」的完全控制权交给 AI：模型在讲解的同时，实时在画布上生成公式、图表、示意图与可交互的教学组件，并通过语音把内容讲出来——像一位会板书、会演示、还能对话的老师。

> 本项目使用 TRAE 完成从架构设计、编码到调试的全过程开发，参加 TRAE 好应用大奖赛。

**下载安装（macOS · Apple Silicon）**：[Releases](https://github.com/zhj-ldm/learncanvas/releases/latest) 下载 `LearnCanvas-0.1.0-arm64.dmg` → 拖入「应用程序」→ 首次打开若提示未验证开发者，右键「打开」或执行 `xattr -cr /Applications/LearnCanvas.app`。

## 核心特色

- **AI 掌舵画布**：不是「聊天 + 富文本」，而是 AI 通过结构化指令增删改画布内容。
- **可操控的交互教学**：AI 生成 HTML 教学小部件，并逐步下发 `canvas_control` 指令，实时驱动动画 / 实验进度，实现「用户问一句、演示走一步」。
- **多形态内容**：Markdown + LaTeX 公式、Mermaid 流程图 / 思维导图、内联 SVG、可交互 HTML 组件。
- **全离线语音**：内置 sherpa-onnx 语音识别；TTS 支持 Edge 在线、Kokoro / Melo 本地神经网络、macOS 系统语音多级兜底。
- **语音输入 / 朗读独立开关**：可以只听不说、只说只听，互不干扰；开启朗读后每轮强制播报，画面与讲解同步。
- **不止会讲，还会做**：AI 可读写本地文件、执行命令、联网搜索。
- **开放模型**：任意 OpenAI 兼容接口（DeepSeek、OpenAI 等），模型、成本、数据自己掌握。

## 快速开始

环境要求：Node.js ≥ 18，macOS（语音识别与系统语音兜底目前针对 macOS 适配）。

```bash
npm install
npm start
```

首次使用请在「设置」中填写：

| 配置项 | 说明 |
| --- | --- |
| 接口地址 | OpenAI 兼容的 Base URL，例如 `https://api.deepseek.com/v1` |
| API Key | 对应服务的密钥 |
| 模型 | 例如 `deepseek-chat` |

## 语音功能

- **语音输入**：点击顶栏麦克风按钮开启后，按住空格说话，松开后自动识别并填入输入框。
- **语音朗读**：点击顶栏喇叭按钮开启后，AI 每轮回答都会朗读。
- **语音引擎**（设置 → 语音）：
  - `Edge 在线语音`：最自然、响应最快（默认，需要联网）
  - `Kokoro 本地语音`：离线，多中文音色
  - `Melo 本地语音`：离线
  - `系统语音`：macOS 内置语音兜底
- 本地模型约 180–350 MB，可在设置中一键下载，存放在 `用户数据目录/models`。

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面容器 | Electron |
| 渲染层 | 原生 JavaScript + 自研 Canvas 视图（`renderer/`） |
| 内容渲染 | marked、KaTeX、Mermaid、内联 SVG / HTML |
| 语音识别 | sherpa-onnx（Paraformer 中文模型，int8） |
| 语音合成 | Edge TTS 协议（WebSocket）、sherpa-onnx Kokoro / MeloTTS、macOS `say` |
| AI 能力 | OpenAI 兼容 Chat Completions + 工具调用（文件、命令、搜索、画布、朗读） |

## 项目结构

```
main.js               Electron 主进程：窗口、API 请求、文件工具、IPC
preload.js            contextBridge 安全桥
voice.js              语音服务：模型下载、ASR 推理、TTS 调度与兜底
voice-tts-server.js   TTS 独立子进程（sherpa-onnx 本地合成）
edge-drm.js           Edge TTS 鉴权 token 生成
renderer/
  index.html          界面结构
  app.js              对话、工具调用解析、语音播放、设置
  canvas.js           画布视图（块渲染、iframe 交互、指令转发）
  styles.css          样式
bin/aggrsearch        联网搜索聚合工具
```

## 工作原理

1. 用户提问后，主进程携带「画布现状 + 工具规范」请求模型。
2. 模型输出 ```` ```tool ```` 代码块来调用工具（画布操作、文件、搜索、朗读等）。
3. 渲染层解析并执行工具，把结果回灌给模型，继续下一轮。
4. 画布块支持 `markdown / mermaid / svg / html / image`；HTML 块通过 `postMessage` 协议接受 `canvas_control` 指令并回报状态，从而支持分步演示。

## 开发

```bash
npm start          # 开发运行
```

打包 macOS 应用：

```bash
npm install
npx electron-packager . LearnCanvas --platform=darwin --arch=arm64 --out=dist
```

## License

ISC
