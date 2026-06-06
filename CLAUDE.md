# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start dev server (runs lint first, then Vite + Electron concurrently)
npm run dev

# Lint
npm run lint
npm run lint:fix

# Run all tests
npm test

# Run a single test file
node --test --import tsx path/to/file.test.ts

# Build renderer
npm run build

# Package for current platform
npm run pack

# Package for specific platforms
npm run pack:mac
npm run pack:win
npm run pack:linux
```

## Architecture

Netcatty is an Electron + React desktop app (SSH manager, terminal, SFTP browser). It has two runtimes:

### Electron Main Process (`electron/`)
- **`main.cjs`** — entry point; wires crash logging, process error guards, and delegates to `main/registerBridges.cjs`
- **`bridges/`** — one `.cjs` file per capability domain (sshBridge, sftpBridge, terminalBridge, portForwardingBridge, aiBridge, etc.). Each bridge exposes IPC handlers via `ipcMain`. Tests live alongside the bridge file (`*.test.cjs`).
- **`preload.cjs`** — exposes a typed `window.electron` API to the renderer via `contextBridge`. Uses `preload/api.cjs` for the generated API surface.
- **`cli/`** — `netcatty-tool-cli.cjs` is a separate internal binary for tool/MCP integration; treat as internal surface only.

### Renderer Process (React + Vite)
Three-layer architecture (see `AGENTS.md` for full detail):

- **`domain/`** — pure TypeScript logic, no side effects. Models (`models.ts`), host helpers, workspace tree operations.
- **`application/state/`** — React hooks that own state and persistence boundaries. Key hooks: `useVaultState` (hosts/keys/snippets), `useSessionState` (terminal sessions/workspace), `useSettingsState` (theme/config).
- **`infrastructure/`** — external edges: `persistence/localStorageAdapter.ts` for storage, `services/` for network calls (Gemini AI, GitHub Gist sync), `config/` for defaults, storage keys, and terminal themes.
- **`components/`** — presentation only. `App.tsx` wires hooks to components; no business logic in components.

### IPC Pattern
UI calls `window.electron.*` (preload API) → IPC → bridge handler in main process. Never call `ipcRenderer` directly from components.

### Zmodem File Transfer
- **Sentry pattern**: `electron/bridges/zmodemHelper.cjs` exports `createZmodemSentry(opts)` — wraps a session's data stream, detects ZMODEM headers, and routes bytes to the protocol handler or back to the terminal.
- Transfers run entirely in the main process; the renderer only receives lightweight progress IPC events (`netcatty:zmodem:detect | progress | complete | error`).
- **Upload flow**: `handleUpload()` opens a file dialog → sends files via `zmodem.js`. For drag-and-drop upload, the renderer sets pending file paths via `setPendingZmodemUpload(sessionId, paths)` IPC, then writes `rz -E\r` to the session. `handleUpload` checks `opts.pendingFilePaths` and skips the dialog when files are pre-set.
- **Close timeout**: Some `rz` builds don't respond to ZFIN, so `zsession.close()` is wrapped with a 5-second timeout; on failure the remote process is killed via CAN bytes + Ctrl+C.
- **UI**: `useZmodemTransfer(sessionId)` hook in `components/terminal/hooks/useZmodemTransfer.ts` manages transfer state; `ZmodemProgressIndicator.tsx` renders the floating progress panel.

### Testing
- Bridge tests (`electron/bridges/*.test.cjs`) run alongside their source files in CommonJS.
- Renderer/domain tests (`*.test.ts`) use `node --test --import tsx path/to/file.test.ts`.
- Tests that import `electron` fail outside an Electron runtime — those are CI-only.

### Windows Packaging on macOS
- `npm run pack:win-x64` fails on macOS because `@electron/rebuild` tries to cross-compile arm64 native modules. Workaround:
  ```bash
  npm run build && npm_config_arch=x64 NODE_OPTIONS=--disable-warning=DEP0190 \
    npx electron-builder --config electron-builder.config.cjs --win --x64 --publish=never --config.npmRebuild=false
  ```

### Review Boundaries (from AGENTS.md)
- `electron/cli/*`, `netcatty-tool-cli`, the CLI discovery file, and the local TCP bridge are **internal integration surfaces** — do not assume they must support third-party callers or manual launches.
- Do not review those surfaces as public APIs by default.

### Key Conventions
- All storage reads/writes go through `localStorageAdapter`; storage keys are in `infrastructure/config/storageKeys.ts`.
- Temporary files must use `tempDirBridge.getTempFilePath(fileName)` — never `os.tmpdir()` directly.
- Aside panels (VaultView subpages) use the shared design system in `components/ui/aside-panel.tsx` — see `AGENTS.md` for usage patterns.
- Renderer code is TypeScript/ESM; Electron main/bridges are CommonJS (`.cjs`).
- Path alias `@/` resolves to the repo root (configured in `vite.config.ts` and `tsconfig.json`).
