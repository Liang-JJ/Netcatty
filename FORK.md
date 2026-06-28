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
- **类**: `KeywordHighlighter` 在 `components/terminal/keywordHighlight.ts`，使用 xterm.js 的 `registerDecoration()` API 叠加颜色，不修改数据流。
- **规则定义**: `DEFAULT_KEYWORD_HIGHLIGHT_RULES` 在 `domain/models/terminal.ts`，含 6 个内置规则。用户可在 Settings > Terminal > Keyword Highlighting 全局配置，也可按 host 覆盖。
- **性能**: 200ms debounce + 50ms rAF 最小间隔 + 1200 条 LRU 缓存。
- **alternate buffer 行为**: **不要**在 alternate buffer 中禁用高亮。`less`/`more` 使用 alternate buffer 但不管理高亮，用户查看日志时需要 keyword highlight。vim/htop 的重绘由 debounce + rAF 节流削峰。

### 跨平台构建

**可用命令：**

```bash
npm run pack          # macOS (x64 + arm64)
npm run pack:mac      # macOS (x64 + arm64)
npm run pack:win      # Windows (x64 + arm64) — 仅限 Windows CI
npm run pack:win-x64  # Windows x64  — macOS 上可执行
npm run pack:linux    # Linux (AppImage + deb + rpm)
```

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

## 私有修改清单

> **维护规则**: 每次新增私有特性或同步上游主干后，都必须更新此清单。新增特性要写明涉及文件和关键符号；被上游吸收的特性要移除；rebase 基准 tag 要更新到最新。

> 每次 rebase 后运行 `git log --oneline v<upstream-tag>..HEAD` 查看需保留的提交。

### 当前 rebase 基准: v1.1.47

### 1. 一键登录 + 全键盘操作

**涉及文件**: `components/QuickConnectWizard.tsx`, `components/vault/VaultViewLayout.tsx`, `application/i18n/locales/{en,zh-CN}/vault.ts`

- QuickConnectWizard 第二步默认"从钥匙串选择"页签，选择 Identity 后跳过 auth 步骤
- ArrowUp/Down 切换协议选项，全局 Enter 进下一步，Tab focus trap
- 左右方向键在页签聚焦时切换"手动输入"/"从钥匙串选择"
- 切换到手动输入时清理自动填充的密码
- `VaultViewLayout.tsx` 传递 `identities` prop

### 2. 侧边栏 Pin 按钮

**涉及文件**: `components/TerminalLayer.tsx`, `components/terminalLayer/TerminalLayerSidePanelSection.tsx`, `components/terminalLayer/TerminalLayerTabBridge.tsx`, `components/terminalLayer/terminalLayerViewMemo.ts`, `infrastructure/config/storageKeys.ts`, `application/i18n/locales/{en,zh-CN,ru}/ai.ts`

- Pin/PinOff 按钮在侧面板头部，固定后切换标签页保持面板打开
- `STORAGE_KEY_SIDE_PANEL_PINNED` 持久化
- 关键符号: `handleTogglePin`, `isSidePanelPinned`, `useActiveTabId`
- **rebase 高频冲突**: `TerminalLayer.tsx` 上游频繁重构

### 3. less/more 中保留关键词高亮

**涉及文件**: `components/terminal/keywordHighlight.ts`

- 移除 `triggerRefresh` 和 `executeRefresh` 中 alternate buffer 禁用高亮的逻辑
- **rebase 高频冲突**: 上游 v1.1.45（#1619）重构了该文件，方法签名升级为 `triggerRefresh(mode, reason)`，但仍保留 alternate buffer 禁用。每次 rebase 都需要在上游新方法体中重新移除这两处 `buffer.active.type === 'alternate'` 检查，并保留私有注释说明 less/more 需要高亮

### 4. 跨平台构建兼容

**涉及文件**: `electron-builder.config.cjs`, `electron/bridges/terminalBridge.cjs`, `scripts/link-serialport-prebuilds.cjs`, `package.json`

- `electron-builder.config.cjs`: `npmConfigArch` / `macArchs` / `winArchs` 变量，读取 `npm_config_arch`
- `terminalBridge.cjs`: serialport try-catch 懒加载
- `scripts/link-serialport-prebuilds.cjs`: 为 `@serialport/bindings-cpp` 的非标准 prebuild 文件创建 `node.napi.node` 软链接，使 `@electron/rebuild` 能在交叉编译时识别预编译文件
- `package.json`: prebuild 脚本追加 `link-serialport-prebuilds.cjs`
- `npm run pack:win-x64` 只构建 x64
- **rebase 注意**: `electron-builder.config.cjs` 上游可能新增排除规则，合并时保留我们的 arch 变量

### 5. AI 功能代理与 Codex 实时模型列表

**涉及文件**: `application/state/useAIState.ts`, `application/state/useAISettingsState.ts`, `components/settings/tabs/ai/HttpProxySettings.tsx`, `electron/bridges/aiBridge/proxyRuntime.cjs`, `electron/bridges/aiBridge.cjs`, `electron/preload/api.cjs`, `types/global/netcatty-bridge-ai.d.ts`, `infrastructure/ai/types.ts`

- AI 代理新增 `off / system / custom` 三种模式，设置页由 `HttpProxySettings.tsx` 负责编辑，状态通过 `useAISettingsState.ts` 和 `useAIState.ts` 统一持久化到 `STORAGE_KEY_AI_HTTP_PROXY`。
- 主进程的 `proxyRuntime.cjs` 维护独立的 AI 会话分区，按配置切换直连、系统代理或自定义代理；自定义代理会通过 Electron `login` 事件仅对 AI 请求注入凭据，并保留 `localhost/127.0.0.1/::1` 直连白名单。
- `electron/preload/api.cjs` 和 `types/global/netcatty-bridge-ai.d.ts` 增加了 AI 代理同步 IPC，保证前端改动能实时传到主进程。

**涉及文件**: `electron/bridges/aiBridge/sdk/codexDriver.cjs`, `electron/bridges/aiBridge/sdk/index.cjs`, `electron/bridges/aiBridge/sdk/sdkStreamHandlers.cjs`, `electron/bridges/aiBridge/sdk/codexDriver.test.cjs`, `electron/bridges/aiBridge/sdk/index.test.cjs`, `infrastructure/ai/types.ts`

- Codex 的模型列表不再依赖硬编码预设，而是直接调用 `codex debug models` 读取实时 JSON 目录。
- 解析逻辑只保留 `visibility === "list"` 的模型，并把 `slug / display_name / supported_reasoning_levels` 映射到下拉可用的数据结构，和 Codex 当前可见模型保持一致。
- `sdkStreamHandlers.cjs` 继续保留失败降级路径，实时查询失败时再回退到保守的 Codex 预设；`infrastructure/ai/types.ts` 里的 fallback 也收敛为 `GPT-5.5 / GPT-5.4 / GPT-5.4-Mini`。

### 6. 主机密钥弹窗自动聚焦 + 终端连接后强制聚焦

**涉及文件**: `components/terminal/TerminalHostKeyVerification.tsx`, `components/Terminal.tsx`

- `TerminalHostKeyVerification.tsx`: 自动聚焦 "Add and Continue" / "Update and Continue" 按钮，添加 Enter 键触发 `onAddAndContinue`
- `Terminal.tsx`: SSH 连接建立后 (status === "connected") 延迟 150ms 自动聚焦 xterm textarea

### Rebase 操作备忘

当前基准: **v1.1.47**

```bash
git fetch origin --tags
# 确认当前基准 tag，然后 rebase
git rebase v<new-tag>
# 按本文件私有修改清单逐项验证
npm run lint && npm t
npm run pack:mac && npm run pack:win-x64
```
