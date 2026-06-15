"use strict";

const { URL } = require("node:url");

const AI_PROXY_SESSION_PARTITION = "persist:netcatty-ai-proxy";
const LOCALHOST_NO_PROXY = "localhost,127.0.0.1,::1";
const SYSTEM_PROXY_HTTP_PROBE_URL = "http://netcatty-proxy-http.invalid";
const SYSTEM_PROXY_HTTPS_PROBE_URL = "https://netcatty-proxy-https.invalid";
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
];

function normalizeProxyConfig(config) {
  if (!config || typeof config !== "object") return { mode: "off" };

  const mode = config.mode === "system" || config.mode === "custom"
    ? config.mode
    : "off";

  if (mode !== "custom") return { mode };

  const custom = config.custom && typeof config.custom === "object"
    ? config.custom
    : {};
  const port = Number(custom.port);

  return {
    mode: "custom",
    custom: {
      scheme: custom.scheme === "https" ? "https" : "http",
      host: typeof custom.host === "string" ? custom.host : "",
      port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 8080,
      username: typeof custom.username === "string" && custom.username.length > 0
        ? custom.username
        : undefined,
      password: typeof custom.password === "string" && custom.password.length > 0
        ? custom.password
        : undefined,
    },
  };
}

function mergeNoProxyValues(...values) {
  const merged = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) continue;
    for (const rawPart of String(value).split(/[,\s;]+/)) {
      const part = rawPart.trim();
      if (!part || seen.has(part)) continue;
      seen.add(part);
      merged.push(part);
    }
  }
  for (const localPart of LOCALHOST_NO_PROXY.split(",")) {
    if (seen.has(localPart)) continue;
    seen.add(localPart);
    merged.push(localPart);
  }
  return merged.join(",");
}

function parseResolvedProxyValue(value) {
  if (!value) return null;
  const entries = String(value)
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    if (entry === "DIRECT") continue;
    const match = entry.match(/^(PROXY|HTTP|HTTPS)\s+(.+)$/i);
    if (!match) continue;
    const scheme = match[1].toUpperCase() === "HTTPS" ? "https" : "http";
    return `${scheme}://${match[2]}`;
  }

  return null;
}

function hasUsableCustomProxy(config) {
  return Boolean(
    config?.mode === "custom"
    && config.custom
    && typeof config.custom.host === "string"
    && config.custom.host.trim().length > 0
    && Number.isInteger(config.custom.port)
    && config.custom.port >= 1
    && config.custom.port <= 65535,
  );
}

function buildCustomProxyUrl(custom) {
  if (!custom || !custom.host || !custom.port) return null;
  const url = new URL(`${custom.scheme === "https" ? "https" : "http"}://127.0.0.1`);
  url.hostname = String(custom.host).trim();
  url.port = String(custom.port);
  if (custom.username) url.username = custom.username;
  if (custom.password) url.password = custom.password;
  return url.toString().replace(/\/$/, "");
}

function buildDirectProxyEnv() {
  return {
    NO_PROXY: LOCALHOST_NO_PROXY,
    no_proxy: LOCALHOST_NO_PROXY,
  };
}

function buildProxyEnvFromUrls({ httpProxyUrl, httpsProxyUrl, allProxyUrl, noProxy } = {}) {
  const mergedNoProxy = mergeNoProxyValues(noProxy);
  const env = {
    NO_PROXY: mergedNoProxy,
    no_proxy: mergedNoProxy,
  };

  if (httpProxyUrl) {
    env.HTTP_PROXY = httpProxyUrl;
    env.http_proxy = httpProxyUrl;
  }
  if (httpsProxyUrl) {
    env.HTTPS_PROXY = httpsProxyUrl;
    env.https_proxy = httpsProxyUrl;
  }
  if (allProxyUrl) {
    env.ALL_PROXY = allProxyUrl;
    env.all_proxy = allProxyUrl;
  }
  return env;
}

function buildSessionProxyConfig(config) {
  if (config.mode === "system") {
    return { mode: "system" };
  }
  if (hasUsableCustomProxy(config)) {
    return {
      mode: "fixed_servers",
      proxyRules: `${config.custom.scheme === "https" ? "https" : "http"}://${config.custom.host}:${config.custom.port}`,
      proxyBypassRules: LOCALHOST_NO_PROXY,
    };
  }
  return { mode: "direct" };
}

function createAiProxyRuntime({ electronModule, decryptValue } = {}) {
  let currentConfig = { mode: "off" };
  let aiSession = null;
  let loginHandlerRegistered = false;
  const inFlightRequestUrls = new Set();
  const inFlightRequestHosts = new Map();
  const tlsBypassHostRefs = new Map();

  function getAiSession() {
    if (aiSession) return aiSession;
    const sessionModule = electronModule?.session;
    if (!sessionModule?.fromPartition) return null;

    aiSession = sessionModule.fromPartition(AI_PROXY_SESSION_PARTITION, { cache: false });
    if (typeof aiSession.setCertificateVerifyProc === "function") {
      aiSession.setCertificateVerifyProc((request, callback) => {
        const hostname = request?.hostname || "";
        if (hostname && tlsBypassHostRefs.get(hostname) > 0) {
          callback(0);
          return;
        }
        callback(-3);
      });
    }
    return aiSession;
  }

  function trackRequestHost(hostname, delta) {
    if (!hostname) return;
    const next = (inFlightRequestHosts.get(hostname) || 0) + delta;
    if (next <= 0) {
      inFlightRequestHosts.delete(hostname);
      return;
    }
    inFlightRequestHosts.set(hostname, next);
  }

  function trackTlsBypassHost(hostname, delta) {
    if (!hostname) return;
    const next = (tlsBypassHostRefs.get(hostname) || 0) + delta;
    if (next <= 0) {
      tlsBypassHostRefs.delete(hostname);
      return;
    }
    tlsBypassHostRefs.set(hostname, next);
  }

  function withRequestTracking(url, skipTlsVerify, fn) {
    const parsed = new URL(url);
    const normalizedUrl = parsed.toString();
    const hostname = parsed.hostname;
    inFlightRequestUrls.add(normalizedUrl);
    trackRequestHost(hostname, 1);
    if (skipTlsVerify && parsed.protocol === "https:") {
      trackTlsBypassHost(hostname, 1);
    }

    return Promise.resolve()
      .then(fn)
      .finally(() => {
        inFlightRequestUrls.delete(normalizedUrl);
        trackRequestHost(hostname, -1);
        if (skipTlsVerify && parsed.protocol === "https:") {
          trackTlsBypassHost(hostname, -1);
        }
      });
  }

  function decryptMaybeEncrypted(value) {
    if (!value || typeof value !== "string") return "";
    if (!value.startsWith("enc:v1:")) return value;
    if (typeof decryptValue === "function") {
      try {
        return decryptValue(value) || "";
      } catch {
        return "";
      }
    }
    const safeStorage = electronModule?.safeStorage;
    if (!safeStorage?.isEncryptionAvailable?.()) return "";
    try {
      return safeStorage.decryptString(Buffer.from(value.slice("enc:v1:".length), "base64"));
    } catch {
      return "";
    }
  }

  function getCustomProxyCredentials() {
    if (!hasUsableCustomProxy(currentConfig)) return null;
    const username = currentConfig.custom.username || "";
    const password = decryptMaybeEncrypted(currentConfig.custom.password) || "";
    if (!username && !password) return null;
    return { username, password };
  }

  function registerLoginHandler() {
    if (loginHandlerRegistered || !electronModule?.app?.on) return;
    electronModule.app.on("login", (event, webContents, request, authInfo, callback) => {
      if (!authInfo?.isProxy) return;
      const credentials = getCustomProxyCredentials();
      if (!credentials) return;

      const requestUrl = request?.url ? String(request.url) : "";
      let isAiRequest = false;
      if (requestUrl) {
        try {
          const parsed = new URL(requestUrl);
          isAiRequest = inFlightRequestUrls.has(parsed.toString()) || inFlightRequestHosts.has(parsed.hostname);
        } catch {
          isAiRequest = false;
        }
      }
      if (!isAiRequest) return;

      event.preventDefault();
      callback(credentials.username, credentials.password);
    });
    loginHandlerRegistered = true;
  }

  async function syncConfig(config) {
    currentConfig = normalizeProxyConfig(config);
    registerLoginHandler();

    const session = getAiSession();
    if (!session?.setProxy) {
      return { ok: true };
    }

    await session.setProxy(buildSessionProxyConfig(currentConfig));
    if (typeof session.closeAllConnections === "function") {
      await session.closeAllConnections();
    }
    return { ok: true };
  }

  async function fetch(url, init = {}, options = {}) {
    const session = getAiSession();
    const requestInit = { ...init };
    if (!requestInit.redirect) requestInit.redirect = "manual";

    return withRequestTracking(url, options.skipTlsVerify === true, async () => {
      if (session?.fetch) {
        return session.fetch(url, requestInit);
      }
      return globalThis.fetch(url, requestInit);
    });
  }

  async function getAgentProxyEnv() {
    const normalized = normalizeProxyConfig(currentConfig);
    if (normalized.mode === "off" || (normalized.mode === "custom" && !hasUsableCustomProxy(normalized))) {
      return buildDirectProxyEnv();
    }

    if (normalized.mode === "custom") {
      const password = decryptMaybeEncrypted(normalized.custom.password);
      const proxyUrl = buildCustomProxyUrl({
        ...normalized.custom,
        password: password || undefined,
      });
      if (!proxyUrl) return buildDirectProxyEnv();
      return buildProxyEnvFromUrls({
        httpProxyUrl: proxyUrl,
        httpsProxyUrl: proxyUrl,
        allProxyUrl: proxyUrl,
      });
    }

    const session = getAiSession();
    if (!session?.resolveProxy) {
      return buildDirectProxyEnv();
    }

    const httpProxyUrl = parseResolvedProxyValue(await session.resolveProxy(SYSTEM_PROXY_HTTP_PROBE_URL));
    const httpsProxyUrl = parseResolvedProxyValue(await session.resolveProxy(SYSTEM_PROXY_HTTPS_PROBE_URL));
    return buildProxyEnvFromUrls({
      httpProxyUrl: httpProxyUrl || undefined,
      httpsProxyUrl: httpsProxyUrl || undefined,
      allProxyUrl: httpsProxyUrl || httpProxyUrl || undefined,
    });
  }

  return {
    PROXY_ENV_KEYS,
    get currentConfig() {
      return currentConfig;
    },
    getAiSession,
    syncConfig,
    fetch,
    getAgentProxyEnv,
    mergeNoProxyValues,
    registerLoginHandler,
  };
}

module.exports = {
  AI_PROXY_SESSION_PARTITION,
  LOCALHOST_NO_PROXY,
  PROXY_ENV_KEYS,
  SYSTEM_PROXY_HTTP_PROBE_URL,
  SYSTEM_PROXY_HTTPS_PROBE_URL,
  buildCustomProxyUrl,
  buildDirectProxyEnv,
  buildProxyEnvFromUrls,
  buildSessionProxyConfig,
  createAiProxyRuntime,
  hasUsableCustomProxy,
  mergeNoProxyValues,
  normalizeProxyConfig,
  parseResolvedProxyValue,
};
