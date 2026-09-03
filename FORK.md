# FORK.md

本文件是 [binaricat/Netcatty](https://github.com/binaricat/Netcatty) fork (Liang-JJ/Netcatty) 的私有补充文档。包含两大部分：

1. **架构补充** — 上游未覆盖但对本 fork 重要的架构知识
2. **私有修改清单** — 每次 rebase 上游后需要重新验证/应用的修改

---

## 架构补充

### 额外命令

```bash
# TypeScript type check (no emit)
npx tsc --noEmit

# Package for Windows x64 (macOS 上可执行)
npm run pack:win-x64
```

### Zmodem File Transfer (v1.1.40 起已由上游提供)

> 此功能已在上游 v1.1.40 合并，不再属于私有修改。以下架构说明供参考。
- **Sentry pattern**: `electron/bridges/zmodemHelper.cjs` exports `createZmodemSentry(opts)` — wraps a session's data stream, detects ZMODEM headers, and routes bytes to the protocol handler or back to the terminal.
- Transfers run entirely in the main process; the renderer only receives lightweight progress IPC events (`netcatty:zmodem:detect | progress | complete | error`).
- **Upload flow**: `handleUpload()` opens a file dialog → sends files via `zmodem.js`. For drag-and-drop upload, the renderer sets pending file paths via `setPendingZmodemUpload(sessionId, paths)` IPC, then writes `rz -E\r` to the session. `handleUpload` checks `opts.pendingFilePaths` and skips the dialog when files are pre-set.
- **Close timeout**: Some `rz` builds don't respond to ZFIN, so `zsession.close()` is wrapped with a 5-second timeout; on failure the remote process is killed via CAN bytes + Ctrl+C.
- **UI**: `useZmodemTransfer(sessionId)` hook in `components/terminal/hooks/useZmodemTransfer.ts` manages transfer state; `ZmodemProgressIndicator.tsx` renders the floating progress panel.

### i18n
- Translations live in `application/i18n/locales/{en,zh-CN,ru}/`, split by domain: `terminal.ts`, `vault.ts`, `ai.ts`, etc.
- Each domain exports a `Messages` object keyed by dotted path strings.
- Components use `const { t } = useI18n()` to translate. When adding new UI text, add keys to at least `en/` and `zh-CN/`.

### Keyword Highlight（关键词高亮）
- **类**: `KeywordHighlighter` 在 `components/terminal/keywordHighlight.ts`，直接重着色 xterm.js buffer cell 的前景色，不修改数据流。
- **规则定义**: `DEFAULT_KEYWORD_HIGHLIGHT_RULES` 在 `domain/models/terminal.ts`，含 6 个内置规则。用户可在 Settings > Terminal > Keyword Highlighting 全局配置，也可按 host 覆盖。
- **性能**: 基于上游 v1.1.82 的 buffer cell 前景色重着色引擎，普通写入仅处理受影响的逻辑行，大批量输出通过写入压力检测和 quiet catch-up 合并扫描；`scripts/xterm-keyword-highlight-{performance,throughput}.live.test.cjs` 覆盖真实 Electron/WebGL 写入与吞吐压力。
- **alternate buffer 行为**: **不要**在 alternate buffer 中禁用高亮。`less`/`more` 使用 alternate buffer 但不管理高亮，fork 使用 220ms quiet refresh 在输出稳定后扫描当前视口，避免 vim/htop 连续重绘时逐写入执行正则匹配。

### 跨平台构建

**可用命令：**

```bash
npm run pack          # macOS (x64 + arm64)
npm run pack:mac      # macOS (x64 + arm64)
npm run pack:win      # Windows (x64 + arm64) — 仅限 Windows CI
npm run pack:win-x64  # Windows x64  — macOS 上可执行
npm run pack:linux    # Linux (AppImage + deb + rpm)
```

从 macOS 交叉构建 v1.1.81+ 的 Windows 包时，上游新增的 Windows Hello helper 以及 patched node-pty ConPTY runtime 无法在本机通过 MSVC 编译。先从相同上游 tag 的官方 Windows x64 包提取这些文件，再显式指定：

```bash
NETCATTY_WINDOWS_HELLO_HELPER=/path/to/NetcattyWindowsHello.exe \
NETCATTY_NODE_PTY_PREBUILD_DIR=/path/to/node-pty/build/Release \
NETCATTY_WINDOWS_NATIVE_PREBUILD_DIR=/path/to/native-prebuilds \
npm run pack:win-x64
```

`NETCATTY_WINDOWS_NATIVE_PREBUILD_DIR` 下应包含 `serialport/bindings.node`、`windows-process-tree/windows_process_tree.node` 和 `sqlite3/node_sqlite3.node`。构建脚本会逐一校验所有文件的 PE machine 与目标架构一致，并写入目标 Electron ABI 标记后才复制；未设置变量时仍沿用上游的 Windows 本机 MSVC 编译流程。

**版本号约定：** 私有 fork 默认构建版本号使用 `<原tag>-fork` 格式，例如基于上游 `v1.1.82` 构建时，`package.json` 中版本号应为 `1.1.82-fork`，生成产物也沿用该版本号。

**工作原理：** `electron-builder.config.cjs` 读取 `npm_config_arch` 环境变量动态决定构建的 arch：

- 未设置 `npm_config_arch`：构建所有平台默认 arch（mac: `['arm64', 'x64']`, win: `['x64', 'arm64']`），这在 **macOS 上构建 Windows 目标会失败**，因为 arm64 native 模块无法交叉编译
- `npm_config_arch=x64`：只构建 x64，macOS 上构建 Windows 可用 `npm run pack:win-x64`
- 所有 `pack:*-x64` / `pack:*-arm64` 单架构脚本通过 `cross-env` 设置 `npm_config_arch`

**跨平台陷阱：**

1. **`serialport` native 模块在 Windows 上会闪退** — `electron/bridges/terminalBridge.cjs` 使用 try-catch 懒加载 `serialport`，加载失败时 `SerialPort` 设为 `null`，不会崩溃。
2. **Windows 构建中的 native 模块** — `@electron/rebuild` 会在打包时重编译，`npm_config_arch` 让它只处理目标 arch。
3. **`@serialport/bindings-cpp` 跨平台预编译** — 该模块使用非标准 prebuild 文件命名（`@serialport+bindings-cpp.node`），`@electron/rebuild` 的 prebuildify 检测器无法识别，会回退到 node-gyp 源码编译从而在交叉编译时报错。`scripts/link-serialport-prebuilds.cjs` 在 prebuild 阶段为每个平台创建 `node.napi.node` 软链接指向对应的预编译文件，让 `@electron/rebuild` 能正确识别并跳过不必要的源码编译。
4. **新增 native 依赖后** — 检查 ESM/ts 文件中的顶层 import，到 `electron/bridges/*.cjs` 中确认用 try-catch 懒加载。

### Testing
- Bridge tests (`electron/bridges/*.test.cjs`) run alongside their source files in CommonJS.
- Renderer/domain tests (`*.test.ts`) use `node --test --import tsx path/to/file.test.ts`.
- Tests that import `electron` fail outside an Electron runtime — those are CI-only.

### Review Boundaries (from AGENTS.md)
- `electron/cli/*`, `netcatty-tool-cli`, the CLI discovery file, and the local TCP bridge are **internal integration surfaces** — do not assume they must support third-party callers or manual launches.
- Do not review those surfaces as public APIs by default.

---

## 上游补丁暂存（tag 未发布前回移）

### #3156 CJK IME 零宽字符输入过滤（上游 issue #3138）

**来源**: 上游 `b27aef1cd` + `08044ee98`（2026-08-29 合入 main，晚于本 fork 的 v1.1.82 同步点 2026-08-27；上游尚未发布包含它的新 tag）。cherry-pick 时按上游 main 最终版补齐了测试断言（全角问号应保留）。

**涉及文件**: `components/terminal/runtime/terminalInputSanitize.ts`、`terminalInputSanitize.test.ts`、`createXTermRuntime.ts`（onData / IME remap / Kitty 组合路径接线）

- CJK IME（微软拼音/搜狗）切换组合模式时会偶发注入零宽 Unicode 字符（U+200B/U+FEFF/U+00AD/U+2060-64/方向标记），渲染宽度为 0 —— 命令行「隐藏字符」问题族（#3138）。ZWNJ/ZWJ 有语义，保留不过滤。
- **rebase 处理**: rebase 到包含 #3156 的 tag 时，这两个提交会因 patch 等价被自动跳过；若产生空提交/冲突，直接丢弃 fork 副本即可。

---

## 私有修改清单

> **维护规则**: 每次新增私有特性或同步上游主干后，都必须更新此清单。新增特性要写明涉及文件和关键符号；被上游吸收的特性要移除；rebase 基准 tag 要更新到最新。

> 每次 rebase 后运行 `git log --oneline v<upstream-tag>..HEAD` 查看需保留的提交。

### 当前 rebase 基准: v1.1.82

### 0. 终端回显丢弃诊断（echo-loss diagnostics）

**涉及文件**: `components/terminal/runtime/terminalEchoLossDiagnostics.ts`（+ `.test.ts`）、`terminalOutputPipeline.ts`、`terminalSessionAttachment.ts`、`terminalWriteQueue.ts`、`terminalWriteCoalescer.ts`、`terminalUserPaste.ts`、`electron/preload/terminalDataBacklog.cjs`、`electron/terminalWorker/runtime.cjs`

- 定位「打字字符已送达远端但终端不显示」类问题的可选日志：覆盖显示管线全部主动丢弃点（interrupt display gate 各分支、写队列/合并器 abort、backlog 64KB 裁剪、preload session 丢弃、worker generation 丢弃、paste 残留 ESC[K 注入）。
- 开关：`localStorage.setItem("netcatty.debug.echoLoss", "1")` 后重载窗口；终端 worker（utility process）用环境变量 `NETCATTY_ECHO_LOSS=1`。日志前缀 `[echo-loss]`，含 reason/session/字节数/被丢文本摘要。
- 默认关闭零开销；复现时日志有输出→管线丢弃点，静默→渲染层（如 WebGL 字形空白）。
- **rebase 注意**: 纯增量埋点（每处 1-3 行 + import），冲突时以上游实现为准、重新补埋点即可。

### 0b. App 恢复时清理 WebGL 纹理图集

**涉及文件**: `components/terminal/useTerminalEffects.ts`、`components/terminal/appResumeWebglRecovery.test.ts`

- `recoverWebglRendererOnAppResume` 原先只有 `ensureWebglRenderer()`；系统休眠/长时间最小化可能丢弃 GPU drawing buffer 而不触发 `webglcontextlost`，此时强制重绘会使用陈旧图集画出空白/花字形。补 `clearTextureAtlas()`，与 tab-reveal 恢复路径（#1063）一致。
- 测试以源码断言锁定顺序（ensure → clear atlas）。
- **rebase 注意**: 若上游重写 app resume 恢复逻辑，保留 clearTextureAtlas 调用即可。

### 1. 一键登录 + 全键盘操作

**涉及文件**: `components/QuickConnectWizard.tsx`, `components/ui/combobox.tsx`, `components/VaultView.tsx`, `components/vault/VaultViewLayout.tsx`, `domain/host.ts`, `domain/host.test.ts`, `application/i18n/locales/{en,zh-CN}/vault.ts`

- QuickConnectWizard 保留社区协议首屏的“凭据预设”选择器，并在用户名步骤提供 fork 的“凭据预设/用户名”页签；存在 Identity 时默认打开凭据页签
- QuickConnect 保存主机时按 host/port/auth（含 Keychain Identity 解析后的认证信息）去重；命中已有主机时复用原 host id，未命中时创建新主机，避免相同连接重复创建导致 AI 对话历史等 host 绑定能力失效
- 首屏凭据选择器支持 Enter、F4、Alt+ArrowUp/Down、Home/End、Escape；第二步页签支持方向键、Home/End、Enter/Space，凭据列表支持 ArrowUp/Down、Home/End、Enter/Space
- 进入用户名步骤或切回“凭据预设”页签时，焦点直接落到已选凭据或第一项；Tab/Shift+Tab 在当前面板和向导操作按钮间遍历并保持在向导内循环
- 所有 QuickConnect 完成入口（预设凭据、手工密码、密钥、按钮与 Enter）都先保存或复用主机再建立会话，不保留绕过主机列表的临时连接入口
- `VaultViewLayout.tsx` 传递 `identities` prop

### 2. 侧边栏 Pin 按钮

**涉及文件**: `components/TerminalLayer.tsx`, `components/terminalLayer/TerminalLayerSidePanelSection.tsx`, `components/terminalLayer/TerminalLayerTabBridge.tsx`, `components/terminalLayer/terminalLayerViewMemo.ts`, `infrastructure/config/storageKeys.ts`, `application/i18n/locales/{en,zh-CN,ru}/ai.ts`

- Pin/PinOff 按钮在侧面板头部，固定后切换标签页保持面板打开
- `STORAGE_KEY_SIDE_PANEL_PINNED` 持久化
- 关键符号: `handleTogglePin`, `isSidePanelPinned`, `useActiveTabId`
- **rebase 高频冲突**: `TerminalLayer.tsx` 上游频繁重构

### 3. less/more 中保留关键词高亮

**涉及文件**: `components/terminal/keywordHighlight.ts`, `components/terminal/keywordHighlight.test.ts`

- 在上游 v1.1.82 的 cell 重着色引擎上允许 `recolorVisible` / `recolorRange` 处理 alternate buffer
- alternate buffer 写入采用独立的 220ms quiet refresh，保留 less/more 高亮能力，同时避免翻页/全屏重绘持续抢占
- normal buffer 的 tail -f / 持续日志继续使用上游的 output-pressure bypass、逻辑行局部重着色和 quiet catch-up，不恢复旧 decoration/全屏扫描实现
- 序列化、clear/reset 和规则变更需要恢复 normal/alternate 两套 buffer 的原始前景色，避免高亮颜色泄漏
- **rebase 高频冲突**: 上游持续优化该文件的写入和 catch-up 路径。每次 rebase 都需要保留 less/more alternate buffer 的 quiet refresh，同时优先沿用上游最新 normal-buffer 性能实现

### 4. 跨平台构建兼容

**涉及文件**: `electron-builder.config.cjs`, `electron/bridges/terminalBridge.cjs`, `scripts/link-serialport-prebuilds.cjs`, `package.json`

- `electron-builder.config.cjs`: `npmConfigArch` / `macArchs` / `winArchs` 变量，读取 `npm_config_arch`
- `electron-builder.config.cjs`: Windows `zip` target 不显式设置 `arch`，让它跟随 `--x64` / `--arm64` CLI 参数，避免 x64 构建误产 arm64 zip
- `terminalBridge.cjs`: serialport try-catch 懒加载
- `scripts/link-serialport-prebuilds.cjs`: 为 `@serialport/bindings-cpp` 的非标准 prebuild 文件创建 `node.napi.node` 软链接，使 `@electron/rebuild` 能在交叉编译时识别预编译文件
- `package.json`: prebuild 脚本追加 `link-serialport-prebuilds.cjs`；默认构建版本号维护为 `<原tag>-fork`
- `npm run pack:win-x64` 只构建 x64
- **rebase 注意**: `electron-builder.config.cjs` 上游可能新增排除规则，合并时保留我们的 arch 变量

### 5. Codex 实时模型列表

> AI HTTP 代理（off/system/custom 三态、`proxyRuntime.cjs` 独立会话分区）已在上游 v1.1.82 吸收（`httpNetworkProxyAgent.cjs` app 级代理 + `streamRequest` idle/total 超时管理），fork 实现于 rebase 到 v1.1.82 时移除。

**涉及文件**: `electron/bridges/aiBridge/sdk/codexDriver.cjs`, `electron/bridges/aiBridge/sdk/index.cjs`, `electron/bridges/aiBridge/sdk/sdkStreamHandlers.cjs`, `electron/bridges/aiBridge/sdk/codexDriver.test.cjs`, `electron/bridges/aiBridge/sdk/index.test.cjs`, `infrastructure/ai/types.ts`

- Codex 的模型列表不再依赖硬编码预设，而是直接调用 `codex debug models` 读取实时 JSON 目录。
- 解析逻辑只保留 `visibility === "list"` 的模型，并把 `slug / display_name / supported_reasoning_levels` 映射到下拉可用的数据结构，和 Codex 当前可见模型保持一致。
- `sdkStreamHandlers.cjs` 继续保留失败降级路径，实时查询失败时再回退到保守的 Codex 预设；`infrastructure/ai/types.ts` 里的 fallback 也收敛为 `GPT-5.5 / GPT-5.4 / GPT-5.4-Mini`。

### 6. 主机密钥弹窗自动聚焦 + 终端连接后强制聚焦

**涉及文件**: `components/terminal/TerminalHostKeyVerification.tsx`, `components/Terminal.tsx`

- `TerminalHostKeyVerification.tsx`: 自动聚焦 "Add and Continue" / "Update and Continue" 按钮，添加 Enter 键触发 `onAddAndContinue`
- `Terminal.tsx`: SSH 连接建立后 (status === "connected") 延迟 150ms 自动聚焦 xterm textarea

### Rebase 操作备忘

当前基准: **v1.1.82**

```bash
git fetch origin --tags
# 确认当前基准 tag，然后 rebase
git rebase v<new-tag>
# 按本文件私有修改清单逐项验证
npm run lint && npm t
npm run pack:mac && npm run pack:win-x64
```
