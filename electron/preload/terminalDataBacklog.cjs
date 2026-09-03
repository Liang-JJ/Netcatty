"use strict";

const { mergeTerminalDataMeta } = require("./terminalDataMeta.cjs");

function hasPluginPipelineIngress(meta) {
  return Number.isFinite(meta?.pluginPipelineIngressBytes)
    && Number(meta.pluginPipelineIngressBytes) > 0;
}

function hasPluginPipelineIngressMarker(meta) {
  return Number.isFinite(meta?.pluginPipelineIngressBytes)
    && Number(meta.pluginPipelineIngressBytes) >= 0;
}

// Fork echo-loss diagnostics (see components/terminal/runtime/terminalEchoLossDiagnostics.ts).
// Enable with localStorage.setItem("netcatty.debug.echoLoss", "1") + reload.
function echoLossLog(where, detail) {
  try {
    if (
      typeof window === "undefined"
      || !window.localStorage
      || window.localStorage.getItem("netcatty.debug.echoLoss") !== "1"
    ) {
      return;
    }
    console.info(`[echo-loss] ${where}: ${detail || ""}`);
  } catch {
    // Diagnostics must never affect the data path.
  }
}

function createTerminalDataBacklog(options = {}) {
  const maxBytesPerSession = options.maxBytesPerSession ?? 64 * 1024;
  const pendingBySession = new Map();

  function trimToLimit(sessionId, value) {
    if (value.length <= maxBytesPerSession) return value;
    const dropped = value.length - maxBytesPerSession;
    echoLossLog("backlog-trim", `session=${sessionId} ${dropped}B (oldest)`);
    return value.slice(value.length - maxBytesPerSession);
  }

  function append(sessionId, data, meta) {
    if (!sessionId || (!data && !hasPluginPipelineIngressMarker(meta))) return;
    const previous = pendingBySession.get(sessionId) || { data: "", meta: undefined };
    const nextData = trimToLimit(sessionId, previous.data + data);
    const preserveTerminalPerf = previous.data.length === 0 && nextData === data;
    let previousMeta = previous.meta;
    let nextChunkMeta = meta;
    const previousHasIngress = Number.isFinite(previousMeta?.pluginPipelineIngressBytes);
    const nextChunkHasIngress = Number.isFinite(nextChunkMeta?.pluginPipelineIngressBytes);
    // Once one merged chunk carries explicit original-ingress accounting, the
    // metadata must cover every raw flow unit in the same replay entry. Flow
    // control is intentionally charged in JavaScript string length, not UTF-8
    // bytes, throughout the terminal renderer/worker path. Otherwise a
    // processed chunk followed or preceded by ordinary output would cause the
    // renderer to acknowledge only the annotated subset.
    if (previousHasIngress && !nextChunkHasIngress && data) {
      nextChunkMeta = {
        ...(nextChunkMeta || {}),
        pluginPipelineIngressBytes: data.length,
      };
    } else if (!previousHasIngress && nextChunkHasIngress && previous.data) {
      previousMeta = {
        ...(previousMeta || {}),
        pluginPipelineIngressBytes: previous.data.length,
      };
    }
    const nextMeta = mergeTerminalDataMeta(previousMeta, nextChunkMeta, { preserveTerminalPerf });
    pendingBySession.set(sessionId, {
      data: nextData,
      meta: nextMeta,
    });
  }

  function takeEntry(sessionId) {
    const entry = pendingBySession.get(sessionId) || { data: "", meta: undefined };
    pendingBySession.delete(sessionId);
    return entry;
  }

  function take(sessionId) {
    return takeEntry(sessionId).data;
  }

  function clear(sessionId) {
    pendingBySession.delete(sessionId);
  }

  function size(sessionId) {
    return pendingBySession.get(sessionId)?.data.length ?? 0;
  }

  return {
    append,
    take,
    takeEntry,
    clear,
    size,
  };
}

function hasSessionListeners(listenersBySession, sessionId) {
  return (listenersBySession.get(sessionId)?.size ?? 0) > 0;
}

function createTerminalDataDispatcher({
  dataListeners,
  displayDataListeners,
  terminalDataBacklog,
  onCallbackError = console.error,
  shouldDropSession = () => false,
}) {
  return function deliverToListeners(sessionId, data, meta) {
    if (!data && !hasPluginPipelineIngressMarker(meta)) return;
    if (shouldDropSession(sessionId)) {
      echoLossLog(
        "preload-session-dropped",
        `session=${sessionId} ${String(data ?? "").length}B`,
      );
      return;
    }

    if (!hasSessionListeners(displayDataListeners, sessionId)) {
      terminalDataBacklog?.append?.(sessionId, data, meta);
    }

    const set = dataListeners.get(sessionId);
    if (!set || set.size === 0) return;

    set.forEach((cb) => {
      try {
        cb(data, meta);
      } catch (err) {
        onCallbackError("Data callback failed", err);
      }
    });
  };
}

function clearTerminalDataSession({
  dataListeners,
  displayDataListeners,
  terminalDataBacklog,
}, sessionId) {
  dataListeners?.delete?.(sessionId);
  displayDataListeners?.delete?.(sessionId);
  terminalDataBacklog?.clear?.(sessionId);
}

function clearTerminalDataBacklog({
  terminalDataBacklog,
}, sessionId) {
  terminalDataBacklog?.clear?.(sessionId);
}

module.exports = {
  clearTerminalDataBacklog,
  createTerminalDataBacklog,
  createTerminalDataDispatcher,
  clearTerminalDataSession,
  hasPluginPipelineIngress,
  hasPluginPipelineIngressMarker,
};
