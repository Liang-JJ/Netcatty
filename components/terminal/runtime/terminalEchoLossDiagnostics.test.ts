import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";

import {
  formatEchoLossPreview,
  isTerminalEchoLossDiagnosticsEnabled,
  logTerminalEchoLoss,
} from "./terminalEchoLossDiagnostics";

type LocalStorageLike = {
  getItem: (key: string) => string | null;
};

type WindowLike = {
  localStorage?: LocalStorageLike;
};

const withLocalStorage = (value: string | null, run: () => void): void => {
  const storage: LocalStorageLike = {
    getItem: () => value,
  };
  const holder = globalThis as typeof globalThis & { window?: WindowLike };
  const previous = holder.window;
  holder.window = { localStorage: storage };
  try {
    run();
  } finally {
    holder.window = previous;
  }
};

test("isTerminalEchoLossDiagnosticsEnabled reads the localStorage flag", () => {
  withLocalStorage("1", () => {
    assert.equal(isTerminalEchoLossDiagnosticsEnabled(), true);
  });
  withLocalStorage("0", () => {
    assert.equal(isTerminalEchoLossDiagnosticsEnabled(), false);
  });
  withLocalStorage(null, () => {
    assert.equal(isTerminalEchoLossDiagnosticsEnabled(), false);
  });
});

test("logTerminalEchoLoss is silent while disabled", () => {
  const info = mock.method(console, "info", () => {});
  try {
    withLocalStorage(null, () => {
      logTerminalEchoLoss("write-queue-abort", { bytes: 42 });
    });
    assert.equal(info.mock.callCount(), 0);
  } finally {
    info.mock.restore();
  }
});

test("logTerminalEchoLoss formats reason, session, bytes and preview when enabled", () => {
  const info = mock.method(console, "info", () => {});
  try {
    withLocalStorage("1", () => {
      logTerminalEchoLoss("interrupt-display-gate", {
        sessionId: "s-1",
        reason: "draining",
        bytes: 7,
        preview: "ls -la",
      });
    });
    assert.equal(info.mock.callCount(), 1);
    const message = String(info.mock.calls[0]?.arguments[0]);
    assert.match(message, /^\[echo-loss\] interrupt-display-gate:/);
    assert.match(message, /reason=draining/);
    assert.match(message, /session=s-1/);
    assert.match(message, / 7B/);
    assert.match(message, /text="ls -la"/);
  } finally {
    info.mock.restore();
  }
});

test("logTerminalEchoLoss skips zero-byte drops without a preview", () => {
  const info = mock.method(console, "info", () => {});
  try {
    withLocalStorage("1", () => {
      logTerminalEchoLoss("write-queue-abort", { bytes: 0 });
    });
    assert.equal(info.mock.callCount(), 0);
  } finally {
    info.mock.restore();
  }
});

test("formatEchoLossPreview strips CSI and OSC escape sequences", () => {
  assert.equal(formatEchoLossPreview("\x1b[31merror\x1b[0m"), "error");
  assert.equal(formatEchoLossPreview("\x1b]0;title\x07after"), "after");
  assert.equal(formatEchoLossPreview("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\"), "link");
});

test("formatEchoLossPreview escapes control characters visibly", () => {
  assert.equal(formatEchoLossPreview("a\rb\nc"), "a\\x0db\\x0ac");
  assert.equal(formatEchoLossPreview("\x7f"), "\\x7f");
});

test("formatEchoLossPreview truncates long previews", () => {
  assert.equal(formatEchoLossPreview("x".repeat(200), 64).length, 64);
});

test("formatEchoLossPreview handles empty input", () => {
  assert.equal(formatEchoLossPreview(""), "");
});
