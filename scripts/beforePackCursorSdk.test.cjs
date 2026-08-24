const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CURSOR_PLATFORM_PACKAGES,
  WINDOWS_NATIVE_PREBUILD_FILES,
  beforePackCursorSdk,
  ensureCursorSdkPlatformPackages,
  prepareWindowsNativePrebuilds,
} = require("./beforePackCursorSdk.cjs");
const {
  copyPatchedNodePtyToPackagedApp,
  NODE_PTY_RUNTIME_FILES,
  preparePrebuiltNodePty,
  rebuildPatchedNodePty,
} = require("./nodePtyConptyPatch.cjs");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

test("ensureCursorSdkPlatformPackages installs both macOS Cursor runtime packages", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cursor-pack-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  writeJson(path.join(tempDir, "node_modules", "@cursor", "sdk", "package.json"), { version: "1.0.18" });
  writeJson(path.join(tempDir, "node_modules", "@cursor", "sdk-darwin-arm64", "package.json"), { version: "1.0.18" });
  const calls = [];

  const installed = ensureCursorSdkPlatformPackages({
    projectDir: tempDir,
    platform: "darwin",
    run: (...args) => calls.push(args),
    logger: { log() {}, warn() {} },
  });

  assert.deepEqual(installed, ["@cursor/sdk-darwin-x64"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], process.platform === "win32" ? "npm.cmd" : "npm");
  assert.deepEqual(calls[0][1], [
    "install",
    "--no-save",
    "--force",
    "--ignore-scripts",
    "@cursor/sdk-darwin-x64@1.0.18",
  ]);
  assert.equal(calls[0][2].cwd, tempDir);
});

test("ensureCursorSdkPlatformPackages is a no-op when target packages exist", (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "netcatty-cursor-pack-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  writeJson(path.join(tempDir, "node_modules", "@cursor", "sdk", "package.json"), { version: "1.0.18" });
  for (const packageName of CURSOR_PLATFORM_PACKAGES.linux) {
    writeJson(path.join(tempDir, "node_modules", ...packageName.split("/"), "package.json"), { version: "1.0.18" });
  }
  const calls = [];

  const installed = ensureCursorSdkPlatformPackages({
    projectDir: tempDir,
    platform: "linux",
    run: (...args) => calls.push(args),
    logger: { log() {}, warn() {} },
  });

  assert.deepEqual(installed, []);
  assert.deepEqual(calls, []);
});

test("beforePackCursorSdk builds Windows Hello helper only for Windows packages", () => {
  const calls = [];

  beforePackCursorSdk({
    appDir: process.cwd(),
    electronPlatformName: "win32",
    arch: 3,
    ensureCursorSdkPlatformPackages: () => [],
    prepareWindowsNativePrebuilds: () => false,
    preparePrebuiltNodePty: () => false,
    buildWindowsHelloHelper: (projectDir) => calls.push(projectDir),
  });

  assert.deepEqual(calls, [{ projectDir: process.cwd(), platform: "win32", arch: "arm64" }]);

  beforePackCursorSdk({
    appDir: process.cwd(),
    electronPlatformName: "darwin",
    ensureCursorSdkPlatformPackages: () => [],
    prepareWindowsNativePrebuilds: () => false,
    preparePrebuiltNodePty: () => false,
    buildWindowsHelloHelper: (projectDir) => calls.push(projectDir),
  });

  assert.deepEqual(calls, [{ projectDir: process.cwd(), platform: "win32", arch: "arm64" }]);
});

test("beforePackCursorSdk falls back to npm_config_arch for Windows Hello helper arch", () => {
  const calls = [];
  const originalArch = process.env.npm_config_arch;
  process.env.npm_config_arch = "x64";
  try {
    beforePackCursorSdk({
      appDir: process.cwd(),
      electronPlatformName: "win32",
      ensureCursorSdkPlatformPackages: () => [],
      prepareWindowsNativePrebuilds: () => false,
      preparePrebuiltNodePty: () => false,
      buildWindowsHelloHelper: (projectDir) => calls.push(projectDir),
    });
  } finally {
    if (originalArch === undefined) {
      delete process.env.npm_config_arch;
    } else {
      process.env.npm_config_arch = originalArch;
    }
  }

  assert.deepEqual(calls, [{ projectDir: process.cwd(), platform: "win32", arch: "x64" }]);
});

test("beforePackCursorSdk fails Windows packaging when Windows Hello helper build is skipped", () => {
  assert.throws(
    () => beforePackCursorSdk({
      appDir: process.cwd(),
      electronPlatformName: "win32",
      ensureCursorSdkPlatformPackages: () => [],
      prepareWindowsNativePrebuilds: () => false,
      preparePrebuiltNodePty: () => false,
      buildWindowsHelloHelper: () => ({ skipped: true, reason: "compiler-unavailable" }),
    }),
    /Windows Hello helper was not built: compiler-unavailable/,
  );
});

test("Windows packaging rebuilds patched node-pty from source for the target architecture", () => {
  const calls = [];
  const rebuilt = rebuildPatchedNodePty({
    projectDir: "/workspace/netcatty",
    platform: "win32",
    arch: 3,
    run: (...args) => calls.push(args),
    exists: () => true,
    logger: { log() {} },
  });

  assert.equal(rebuilt, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], [
    path.join("/workspace/netcatty", "node_modules", "@electron", "rebuild", "lib", "cli.js"),
    "--force",
    "--build-from-source",
    "--only",
    "node-pty",
    "--arch",
    "arm64",
  ]);
  assert.equal(calls[0][2].cwd, "/workspace/netcatty");
  assert.equal(calls[1][0], process.execPath);
  assert.equal(
    calls[1][1][0],
    path.join("/workspace/netcatty", "node_modules", "node-pty", "scripts", "post-install.js"),
  );
  assert.equal(calls[1][2].env.npm_config_arch, "arm64");
});

test("Windows cross-packaging prepares active native modules for the Electron ABI", () => {
  const copied = [];
  const writes = [];
  const prepared = prepareWindowsNativePrebuilds({
    projectDir: "/workspace/netcatty",
    platform: "win32",
    arch: "x64",
    electronVersion: "42.3.3",
    env: { NETCATTY_WINDOWS_NATIVE_PREBUILD_DIR: "/prebuilt/native" },
    exists: () => true,
    readMachine: () => 0x8664,
    copy: (...args) => copied.push(args),
    mkdir: () => {},
    writeFile: (...args) => writes.push(args),
    logger: { log() {} },
  });

  assert.equal(prepared, true);
  assert.equal(copied.length, WINDOWS_NATIVE_PREBUILD_FILES.length);
  assert.deepEqual(copied[0], [
    path.join("/prebuilt/native", "serialport", "bindings.node"),
    path.join(
      "/workspace/netcatty",
      "node_modules",
      "@serialport",
      "bindings-cpp",
      "build",
      "Release",
      "bindings.node",
    ),
  ]);
  assert.equal(writes.length, WINDOWS_NATIVE_PREBUILD_FILES.length);
  assert.ok(writes.every(([, value, encoding]) => value === "x64--146" && encoding === "utf8"));
});

test("Windows cross-packaging prepares the complete node-pty runtime and Electron ABI marker", () => {
  const copied = [];
  const writes = [];
  const prepared = preparePrebuiltNodePty({
    projectDir: "/workspace/netcatty",
    platform: "win32",
    arch: 1,
    electronVersion: "42.3.3",
    env: { NETCATTY_NODE_PTY_PREBUILD_DIR: "/prebuilt/node-pty" },
    exists: () => true,
    readMachine: () => 0x8664,
    copy: (...args) => copied.push(args),
    mkdir: () => {},
    writeFile: (...args) => writes.push(args),
    logger: { log() {} },
  });

  assert.equal(prepared, true);
  assert.equal(copied.length, NODE_PTY_RUNTIME_FILES.length);
  assert.deepEqual(copied[0], [
    path.join("/prebuilt/node-pty", "pty.node"),
    path.join("/workspace/netcatty", "node_modules", "node-pty", "build", "Release", "pty.node"),
  ]);
  assert.deepEqual(writes, [[
    path.join("/workspace/netcatty", "node_modules", "node-pty", "build", "Release", ".forge-meta"),
    "x64--146",
    "utf8",
  ]]);
});

test("Windows cross-packaging accepts an explicitly configured patched node-pty runtime", () => {
  const copied = [];
  const made = [];
  const rebuilt = rebuildPatchedNodePty({
    projectDir: "/workspace/netcatty",
    platform: "win32",
    arch: 1,
    env: { NETCATTY_NODE_PTY_PREBUILD_DIR: "/prebuilt/node-pty" },
    run: () => {
      throw new Error("should not rebuild from source");
    },
    exists: () => true,
    readMachine: () => 0x8664,
    copy: (...args) => copied.push(args),
    mkdir: (...args) => made.push(args),
    logger: { log() {} },
  });

  assert.equal(rebuilt, true);
  assert.equal(copied.length, 3);
  assert.equal(made.length, 3);
  assert.deepEqual(copied[0], [
    path.join("/prebuilt/node-pty", "conpty.node"),
    path.join("/workspace/netcatty", "node_modules", "node-pty", "build", "Release", "conpty.node"),
  ]);
});

test("Windows cross-packaging rejects prebuilt node-pty files for the wrong architecture", () => {
  assert.throws(() => rebuildPatchedNodePty({
    projectDir: "/workspace/netcatty",
    platform: "win32",
    arch: 3,
    env: { NETCATTY_NODE_PTY_PREBUILD_DIR: "/prebuilt/node-pty" },
    run: () => {
      throw new Error("should not rebuild from source");
    },
    exists: () => true,
    readMachine: () => 0x8664,
    copy: () => {
      throw new Error("should not copy wrong-arch artifacts");
    },
    mkdir: () => {},
    logger: { log() {} },
  }), /does not match Windows arm64/);
});

test("Windows packaging fails when rebuilt node-pty runtime files are incomplete", () => {
  assert.throws(() => rebuildPatchedNodePty({
    projectDir: "/workspace/netcatty",
    platform: "win32",
    arch: 1,
    run() {},
    exists: (filePath) => !filePath.endsWith("conpty.dll"),
    logger: { log() {} },
  }), /Patched node-pty artifacts missing: .*conpty\.dll/);
});

test("non-Windows packaging keeps the prebuilt node-pty path", () => {
  const calls = [];
  const rebuilt = rebuildPatchedNodePty({
    projectDir: "/workspace/netcatty",
    platform: "linux",
    arch: 1,
    run: (...args) => calls.push(args),
    logger: { log() {} },
  });

  assert.equal(rebuilt, false);
  assert.deepEqual(calls, []);
});

test("Windows afterPack copies rebuilt ConPTY files over packaged prebuilds", () => {
  const copied = [];
  const made = [];
  const destinations = copyPatchedNodePtyToPackagedApp({
    projectDir: "/workspace/netcatty",
    resourcesDir: "/workspace/release/resources",
    copy: (...args) => copied.push(args),
    mkdir: (...args) => made.push(args),
  });

  assert.equal(copied.length, 3);
  assert.equal(made.length, 3);
  assert.equal(copied[0][0], path.join(
    "/workspace/netcatty", "node_modules", "node-pty", "build", "Release", "conpty.node",
  ));
  assert.equal(copied[0][1], path.join(
    "/workspace/release/resources", "app.asar.unpacked", "node_modules", "node-pty", "build", "Release", "conpty.node",
  ));
  assert.deepEqual(destinations, copied.map(([, destination]) => destination));
});

test("node-pty patch matches bundled ConPTY clear ABI and preserves the cursor row", () => {
  const patch = fs.readFileSync(
    path.join(__dirname, "..", "patches", "node-pty+1.1.0.patch"),
    "utf8",
  );

  assert.match(patch, /ConptyClearPseudoConsole\(HPCON hPC, BOOL keepCursorRow\)/);
  assert.match(patch, /PFNCLEARPSEUDOCONSOLE\)\(HPCON hpc, BOOL keepCursorRow\)/);
  assert.match(patch, /pfnClearPseudoConsole\(handle->hpc, TRUE\)/);
  assert.doesNotMatch(patch, /node_modules\/node-pty\/build\//);
});
