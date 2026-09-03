/**
 * Opt-in diagnostics for the terminal echo display pipeline.
 *
 * Symptom these logs chase (fork debugging): a typed character reaches the
 * remote host (the executed command is correct) but never shows up in the
 * terminal. Every code path that deliberately drops or truncates PTY output
 * before it reaches `term.write` logs here, so a repro either points at the
 * dropping gate directly — or proves the pipeline clean and moves suspicion
 * to the renderer (e.g. blank WebGL glyphs).
 *
 * Enable (renderer + preload paths), then reload the window:
 *   localStorage.setItem("netcatty.debug.echoLoss", "1")
 *
 * Terminal-worker paths run in a utility process without DOM access and use:
 *   NETCATTY_ECHO_LOSS=1
 */

const ECHO_LOSS_STORAGE_KEY = "netcatty.debug.echoLoss";

export const isTerminalEchoLossDiagnosticsEnabled = (): boolean => {
  try {
    return typeof window !== "undefined"
      && window.localStorage?.getItem(ECHO_LOSS_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
};

/** ANSI-stripped, control-escaped preview of dropped display data. */
export const formatEchoLossPreview = (data: string, maxLength = 64): string => {
  if (!data) return "";
  let plain = "";
  for (let index = 0; index < data.length && plain.length < maxLength; index += 1) {
    const char = data[index];
    const code = char.charCodeAt(0);
    if (code === 0x1b) {
      const next = data[index + 1];
      if (next === "[") {
        index += 2;
        while (index < data.length) {
          const c = data.charCodeAt(index);
          if (c >= 0x40 && c <= 0x7e) break;
          index += 1;
        }
        continue;
      }
      if (next === "]") {
        index += 2;
        while (index < data.length) {
          if (data[index] === "\x07") break;
          if (data[index] === "\x1b" && data[index + 1] === "\\") {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      if (next) index += 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      plain += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    plain += char;
  }
  return plain.length > maxLength ? plain.slice(0, maxLength) : plain;
};

export type TerminalEchoLossDetail = {
  sessionId?: string | null;
  reason?: string;
  bytes: number;
  preview?: string;
};

export const logTerminalEchoLoss = (
  where: string,
  detail: TerminalEchoLossDetail,
): void => {
  if (!isTerminalEchoLossDiagnosticsEnabled()) return;
  if (detail.bytes <= 0 && !detail.preview) return;
  const suffix = [
    typeof detail.reason === "string" && detail.reason ? ` reason=${detail.reason}` : "",
    detail.sessionId ? ` session=${detail.sessionId}` : "",
    ` ${detail.bytes}B`,
    typeof detail.preview === "string" && detail.preview
      ? ` text=${JSON.stringify(detail.preview)}`
      : "",
  ].join("");
  console.info(`[echo-loss] ${where}:${suffix}`);
};
