"use strict";

/* global process, __dirname, console */

if (!process.versions.electron) {
  const test = require("node:test");
  test("xterm keeps dense keyword-style decorations responsive", {
    skip: "run with Electron so the real DOM renderer is available",
  }, () => {});
} else {
  const assert = require("node:assert/strict");
  const fs = require("node:fs");
  const path = require("node:path");
  const electron = require("electron");
  const esbuild = require("esbuild");
  const tempDirBridge = require("../electron/bridges/tempDirBridge.cjs");

  const appRoot = path.resolve(__dirname, "..");
  const showWindow = process.env.NETCATTY_TERMINAL_PERF_SHOW_WINDOW === "1";
  const userData = fs.mkdtempSync(`${tempDirBridge.getTempFilePath("xterm-decoration-perf")}-`);
  electron.app.setPath("userData", userData);
  electron.app.on("window-all-closed", () => {});
  let window = null;

  const cleanup = (exitCode) => {
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
    try {
      fs.rmSync(userData, { recursive: true, force: true });
    } catch (error) {
      console.warn("Unable to remove xterm performance test data:", error);
    } finally {
      electron.app.exit(exitCode);
    }
  };

  void electron.app.whenReady().then(async () => {
    window = new electron.BrowserWindow({
      show: showWindow,
      width: 900,
      height: 560,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
    });
    await window.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(
        "<!doctype html><style>html,body{margin:0}#terminal,#tail{width:800px;height:480px}</style><div id=terminal></div><div id=tail></div>",
      ),
    );

    const xtermPath = require.resolve("@xterm/xterm", { paths: [appRoot] });
    const keywordHighlighterPath = path.join(appRoot, "components/terminal/keywordHighlight.ts");
    const keywordHighlighterBundle = esbuild.buildSync({
      entryPoints: [keywordHighlighterPath],
      bundle: true,
      format: "cjs",
      platform: "browser",
      target: "chrome142",
      write: false,
    }).outputFiles[0].text;
    const result = await window.webContents.executeJavaScript(`(async () => {
      const { Terminal } = require(${JSON.stringify(xtermPath)});
      const highlighterModule = { exports: {} };
      ((module, exports) => {
        ${keywordHighlighterBundle}
      })(highlighterModule, highlighterModule.exports);
      const { KeywordHighlighter } = highlighterModule.exports;
      const term = new Terminal({
        allowProposedApi: true,
        cols: 80,
        cursorBlink: false,
        rendererType: "dom",
        rows: 30,
        scrollback: 1000,
      });
      term.open(document.getElementById("terminal"));

      const waitForPaint = () => new Promise(resolve => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      });
      const waitForRender = (trigger, label) => new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const timeout = setTimeout(() => {
          disposable.dispose();
          reject(new Error("timed out waiting for terminal render: " + label));
        }, 15000);
        const disposable = term.onRender(() => {
          disposable.dispose();
          waitForPaint().then(() => {
            clearTimeout(timeout);
            resolve(performance.now() - startedAt);
          }, reject);
        });
        trigger();
      });
      const writeAndWait = data => new Promise(resolve => term.write(data, resolve));
      const waitForCondition = async (condition, label) => {
        const deadline = performance.now() + 15000;
        while (!condition()) {
          if (performance.now() >= deadline) {
            throw new Error("timed out waiting for " + label);
          }
          await waitForPaint();
        }
      };

      let history = "";
      for (let line = 0; line < 500; line += 1) {
        history += "INFO WARN ERROR SUCCESS DEBUG completed failed critical\\r\\n";
      }
      await writeAndWait(history);

      const highlighter = new KeywordHighlighter(term);
      highlighter.setRules([
        { enabled: true, patterns: ["INFO"], color: "#60a5fa" },
        { enabled: true, patterns: ["WARN"], color: "#fbbf24" },
        { enabled: true, patterns: ["ERROR"], color: "#f87171" },
        { enabled: true, patterns: ["SUCCESS"], color: "#4ade80" },
        { enabled: true, patterns: ["DEBUG"], color: "#a78bfa" },
        { enabled: true, patterns: ["completed"], color: "#2dd4bf" },
        { enabled: true, patterns: ["failed"], color: "#fb7185" },
        { enabled: true, patterns: ["critical"], color: "#f43f5e" },
      ], true);
      const countNetcattyDecorations = () => Array.from(highlighter.lineDecorations.values())
        .reduce((count, state) => count + state.decorations.length, 0);
      await waitForCondition(
        () => countNetcattyDecorations() >= term.rows * 8,
        "Netcatty keyword decorations",
      );
      const netcattyDecorationCount = countNetcattyDecorations();
      const netcattyRefreshMs = await waitForRender(
        () => term.refresh(0, term.rows - 1),
        "Netcatty keyword highlight paint",
      );
      highlighter.dispose();
      await waitForPaint();

      const cursorLine = term.buffer.normal.baseY + term.buffer.normal.cursorY;
      const markers = [];
      const decorations = [];
      for (let line = term.buffer.normal.length - 500; line < term.buffer.normal.length; line += 1) {
        const marker = term.registerMarker(line - cursorLine);
        if (!marker) continue;
        markers.push(marker);
        for (let x = 0; x < term.cols; x += 2) {
          const decoration = term.registerDecoration({
            marker,
            x,
            width: 1,
            foregroundColor: "#f87171",
          });
          if (decoration) decorations.push(decoration);
        }
      }

      const registrationPaintMs = await waitForRender(
        () => term.refresh(0, term.rows - 1),
        "registration paint",
      );
      const refreshMs = [];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        refreshMs.push(await waitForRender(
          () => term.refresh(0, term.rows - 1),
          "measured refresh " + iteration,
        ));
      }

      const state = {
        decorationCount: decorations.length,
        markerCount: markers.length,
        netcattyDecorationCount,
        netcattyRefreshMs,
        registrationPaintMs,
        refreshMs,
        worstRefreshMs: Math.max(...refreshMs),
      };
      decorations.forEach(decoration => decoration.dispose());
      markers.forEach(marker => marker.dispose());
      term.dispose();

      const tailTerm = new Terminal({
        allowProposedApi: true,
        cols: 160,
        cursorBlink: false,
        rendererType: "dom",
        rows: 30,
        scrollback: 3000,
      });
      tailTerm.open(document.getElementById("tail"));
      const tailHighlighter = new KeywordHighlighter(tailTerm);
      tailHighlighter.setRules([
        { enabled: true, patterns: ["INFO"], color: "#60a5fa" },
        { enabled: true, patterns: ["WARN"], color: "#fbbf24" },
        { enabled: true, patterns: ["ERROR"], color: "#f87171" },
        { enabled: true, patterns: ["SUCCESS"], color: "#4ade80" },
        { enabled: true, patterns: ["DEBUG"], color: "#a78bfa" },
        { enabled: true, patterns: ["request_id=[a-z0-9-]+"], color: "#2dd4bf" },
        { enabled: true, patterns: ["latency=\\d+ms"], color: "#fb7185" },
        { enabled: true, patterns: ["status=5\\d\\d"], color: "#f43f5e" },
        { enabled: true, patterns: ["user=[A-Za-z0-9_]+"], color: "#38bdf8" },
        { enabled: true, patterns: ["(?:completed|failed|critical)"], color: "#f97316" },
      ], true);

      const tailWriteLatencies = [];
      let heartbeatAt = performance.now();
      let maxEventLoopLagMs = 0;
      const heartbeat = setInterval(() => {
        const now = performance.now();
        maxEventLoopLagMs = Math.max(maxEventLoopLagMs, now - heartbeatAt - 16);
        heartbeatAt = now;
      }, 16);
      const tailStartedAt = performance.now();
      for (let batch = 0; batch < 20; batch += 1) {
        let chunk = "";
        for (let line = 0; line < 100; line += 1) {
          const id = batch * 100 + line;
          chunk += "INFO WARN ERROR SUCCESS DEBUG request_id=req-" + id
            + " latency=" + (id % 900) + "ms status=500 user=user" + (id % 32)
            + " completed failed critical payload=" + id + "\\r\\n";
        }
        const submittedAt = performance.now();
        await new Promise(resolve => {
          tailTerm.write(chunk, () => {
            tailWriteLatencies.push(performance.now() - submittedAt);
            resolve();
          });
        });
        if (batch < 19) await new Promise(resolve => setTimeout(resolve, 140));
      }
      const tailStreamMs = performance.now() - tailStartedAt;
      await new Promise(resolve => setTimeout(resolve, 700));
      clearInterval(heartbeat);

      const tailDecorationCount = Array.from(tailHighlighter.lineDecorations.values())
        .reduce((count, lineState) => count + lineState.decorations.length, 0);
      const tailRefreshMs = await new Promise((resolve, reject) => {
        const startedAt = performance.now();
        const timeout = setTimeout(() => {
          disposable.dispose();
          reject(new Error("timed out waiting for tail refresh"));
        }, 15000);
        const disposable = tailTerm.onRender(() => {
          disposable.dispose();
          waitForPaint().then(() => {
            clearTimeout(timeout);
            resolve(performance.now() - startedAt);
          }, reject);
        });
        tailTerm.refresh(0, tailTerm.rows - 1);
      });
      state.tail = {
        decorationCount: tailDecorationCount,
        streamMs: tailStreamMs,
        writeWorkMs: tailWriteLatencies.reduce((sum, value) => sum + value, 0),
        maxWriteLatencyMs: Math.max(...tailWriteLatencies),
        maxEventLoopLagMs,
        refreshMs: tailRefreshMs,
      };
      tailHighlighter.dispose();
      tailTerm.dispose();
      return state;
    })()`);

    assert.equal(result.markerCount, 500, JSON.stringify(result));
    assert.equal(result.decorationCount, 20000, JSON.stringify(result));
    assert.ok(result.netcattyDecorationCount >= 240, JSON.stringify(result));
    assert.ok(
      result.netcattyRefreshMs < 150,
      `Netcatty keyword highlighting blocked terminal paint: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.worstRefreshMs < 150,
      `dense keyword-style decorations blocked terminal repaint: ${JSON.stringify(result)}`,
    );
    assert.ok(result.tail.decorationCount >= 280, JSON.stringify(result));
    assert.ok(
      result.tail.writeWorkMs < 2000,
      `10-rule tail output consumed too much write time: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.tail.maxWriteLatencyMs < 250,
      `10-rule tail output stalled a write batch: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.tail.maxEventLoopLagMs < 250,
      `10-rule tail output blocked the renderer: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.tail.refreshMs < 150,
      `10-rule tail highlighting blocked terminal repaint: ${JSON.stringify(result)}`,
    );
    process.stdout.write(`XTERM_DECORATION_PERFORMANCE_OK ${JSON.stringify(result)}\n`);
    cleanup(0);
  }).catch((error) => {
    console.error(error);
    cleanup(1);
  });
}
