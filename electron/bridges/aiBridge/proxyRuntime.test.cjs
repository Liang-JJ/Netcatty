const test = require("node:test");
const assert = require("node:assert/strict");

const {
  LOCALHOST_NO_PROXY,
  buildCustomProxyUrl,
  buildSessionProxyConfig,
  createAiProxyRuntime,
  mergeNoProxyValues,
  parseResolvedProxyValue,
} = require("./proxyRuntime.cjs");

test("buildSessionProxyConfig maps off, system, and custom modes", () => {
  assert.deepEqual(buildSessionProxyConfig({ mode: "off" }), { mode: "direct" });
  assert.deepEqual(buildSessionProxyConfig({ mode: "system" }), { mode: "system" });
  assert.deepEqual(buildSessionProxyConfig({
    mode: "custom",
    custom: { scheme: "http", host: "proxy.example.com", port: 8080 },
  }), {
    mode: "fixed_servers",
    proxyRules: "http://proxy.example.com:8080",
    proxyBypassRules: LOCALHOST_NO_PROXY,
  });
});

test("buildCustomProxyUrl encodes username and password", () => {
  assert.equal(
    buildCustomProxyUrl({
      scheme: "https",
      host: "proxy.example.com",
      port: 8443,
      username: "net catty",
      password: "p@ss word",
    }),
    "https://net%20catty:p%40ss%20word@proxy.example.com:8443",
  );
});

test("parseResolvedProxyValue keeps only HTTP and HTTPS system proxies", () => {
  assert.equal(parseResolvedProxyValue("PROXY proxy.example.com:8080; DIRECT"), "http://proxy.example.com:8080");
  assert.equal(parseResolvedProxyValue("HTTPS secure.example.com:8443"), "https://secure.example.com:8443");
  assert.equal(parseResolvedProxyValue("SOCKS5 socks.example.com:1080; DIRECT"), null);
  assert.equal(parseResolvedProxyValue("DIRECT"), null);
});

test("mergeNoProxyValues preserves existing entries and always includes localhost", () => {
  assert.equal(
    mergeNoProxyValues("example.com,127.0.0.1", "internal.local"),
    "example.com,127.0.0.1,internal.local,localhost,::1",
  );
});

test("syncConfig reapplies the dedicated AI session proxy and closes pooled connections", async () => {
  const calls = [];
  const session = {
    async setProxy(config) {
      calls.push(["setProxy", config]);
    },
    async closeAllConnections() {
      calls.push(["closeAllConnections"]);
    },
    setCertificateVerifyProc() {},
  };
  const runtime = createAiProxyRuntime({
    electronModule: {
      app: { on() {} },
      session: {
        fromPartition() {
          return session;
        },
      },
    },
  });

  await runtime.syncConfig({
    mode: "custom",
    custom: { scheme: "http", host: "proxy.example.com", port: 8080 },
  });
  await runtime.syncConfig({ mode: "system" });

  assert.deepEqual(calls, [
    ["setProxy", { mode: "fixed_servers", proxyRules: "http://proxy.example.com:8080", proxyBypassRules: LOCALHOST_NO_PROXY }],
    ["closeAllConnections"],
    ["setProxy", { mode: "system" }],
    ["closeAllConnections"],
  ]);
});

test("getAgentProxyEnv resolves system proxy URLs and always includes localhost NO_PROXY", async () => {
  const runtime = createAiProxyRuntime({
    electronModule: {
      app: { on() {} },
      session: {
        fromPartition() {
          return {
            async setProxy() {},
            async closeAllConnections() {},
            setCertificateVerifyProc() {},
            async resolveProxy(url) {
              return url.startsWith("https:")
                ? "HTTPS secure-proxy.example.com:8443"
                : "PROXY proxy.example.com:8080; DIRECT";
            },
          };
        },
      },
    },
  });

  await runtime.syncConfig({ mode: "system" });
  const env = await runtime.getAgentProxyEnv();

  assert.equal(env.HTTP_PROXY, "http://proxy.example.com:8080");
  assert.equal(env.HTTPS_PROXY, "https://secure-proxy.example.com:8443");
  assert.equal(env.ALL_PROXY, "https://secure-proxy.example.com:8443");
  assert.equal(env.NO_PROXY, LOCALHOST_NO_PROXY);
  assert.equal(env.no_proxy, LOCALHOST_NO_PROXY);
});

test("proxy login handler injects credentials only for tracked AI proxy requests", async () => {
  let loginHandler = null;
  const authCallbacks = [];
  const session = {
    async setProxy() {},
    async closeAllConnections() {},
    setCertificateVerifyProc() {},
    async fetch(url) {
      loginHandler(
        { preventDefault() { authCallbacks.push("preventDefault"); } },
        null,
        { url },
        { isProxy: true },
        (username, password) => authCallbacks.push({ username, password }),
      );
      return new Response("ok");
    },
  };

  const runtime = createAiProxyRuntime({
    electronModule: {
      app: {
        on(event, handler) {
          if (event === "login") loginHandler = handler;
        },
      },
      session: {
        fromPartition() {
          return session;
        },
      },
    },
  });

  await runtime.syncConfig({
    mode: "custom",
    custom: {
      scheme: "http",
      host: "proxy.example.com",
      port: 8080,
      username: "alice",
      password: "secret",
    },
  });

  loginHandler(
    { preventDefault() { authCallbacks.push("unexpected"); } },
    null,
    { url: "https://not-tracked.example.com" },
    { isProxy: true },
    () => authCallbacks.push("should-not-run"),
  );

  await runtime.fetch("https://api.openai.com/v1/models");

  assert.deepEqual(authCallbacks, [
    "preventDefault",
    { username: "alice", password: "secret" },
  ]);
});
