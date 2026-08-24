const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  buildWindowsHelloHelper,
  getExpectedPeMachine,
  normalizeWindowsHelperArch,
  readPeMachine,
} = require("./build-windows-hello-helper.cjs");
const { preparePrebuiltNodePty } = require("./nodePtyConptyPatch.cjs");
const { getAbi } = require("node-abi");

const CURSOR_PLATFORM_PACKAGES = {
  darwin: ["@cursor/sdk-darwin-arm64", "@cursor/sdk-darwin-x64"],
  linux: ["@cursor/sdk-linux-arm64", "@cursor/sdk-linux-x64"],
  win32: ["@cursor/sdk-win32-x64"],
};

const WINDOWS_NATIVE_PREBUILD_FILES = [
  {
    prebuilt: path.join("serialport", "bindings.node"),
    destination: path.join("@serialport", "bindings-cpp", "build", "Release", "bindings.node"),
  },
  {
    prebuilt: path.join("windows-process-tree", "windows_process_tree.node"),
    destination: path.join("@vscode", "windows-process-tree", "build", "Release", "windows_process_tree.node"),
  },
  {
    prebuilt: path.join("sqlite3", "node_sqlite3.node"),
    destination: path.join("sqlite3", "build", "Release", "node_sqlite3.node"),
  },
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getCursorSdkVersion(projectDir) {
  const sdkPackagePath = path.join(projectDir, "node_modules", "@cursor", "sdk", "package.json");
  if (fs.existsSync(sdkPackagePath)) {
    return readJson(sdkPackagePath).version;
  }

  const lockPath = path.join(projectDir, "package-lock.json");
  if (fs.existsSync(lockPath)) {
    const lock = readJson(lockPath);
    const lockedVersion = lock.packages?.["node_modules/@cursor/sdk"]?.version;
    if (lockedVersion) return lockedVersion;
  }

  const packageJson = readJson(path.join(projectDir, "package.json"));
  const spec = packageJson.optionalDependencies?.["@cursor/sdk"];
  return typeof spec === "string" ? spec.replace(/^[^\d]*/, "") : null;
}

function npmExecutable() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function ensureCursorSdkPlatformPackages({
  projectDir,
  platform,
  run = execFileSync,
  logger = console,
}) {
  const packages = CURSOR_PLATFORM_PACKAGES[platform] || [];
  if (packages.length === 0) return [];

  const version = getCursorSdkVersion(projectDir);
  if (!version) {
    logger.warn("[beforePackCursorSdk] Cursor SDK version not found; skipping platform package install.");
    return [];
  }

  const missingPackages = packages.filter((packageName) => (
    !fs.existsSync(path.join(projectDir, "node_modules", ...packageName.split("/"), "package.json"))
  ));
  if (missingPackages.length === 0) return [];

  const packageSpecs = missingPackages.map((packageName) => `${packageName}@${version}`);
  logger.log(`[beforePackCursorSdk] Installing Cursor SDK platform packages: ${packageSpecs.join(", ")}`);
  run(npmExecutable(), ["install", "--no-save", "--force", "--ignore-scripts", ...packageSpecs], {
    cwd: projectDir,
    stdio: "inherit",
  });

  return missingPackages;
}

function prepareWindowsNativePrebuilds({
  projectDir,
  platform,
  arch,
  electronVersion,
  env = process.env,
  exists = fs.existsSync,
  copy = fs.copyFileSync,
  mkdir = fs.mkdirSync,
  writeFile = fs.writeFileSync,
  readMachine = readPeMachine,
  logger = console,
}) {
  const prebuiltDir = env.NETCATTY_WINDOWS_NATIVE_PREBUILD_DIR;
  if (platform !== "win32" || !prebuiltDir) return false;
  const targetArch = normalizeWindowsHelperArch(arch);
  if (!targetArch) {
    throw new Error(`[windowsNativePrebuilds] Unsupported Windows architecture: ${String(arch)}`);
  }

  const expectedMachine = getExpectedPeMachine(targetArch);
  const artifacts = WINDOWS_NATIVE_PREBUILD_FILES.map((artifact) => ({
    source: path.join(prebuiltDir, artifact.prebuilt),
    destination: path.join(projectDir, "node_modules", artifact.destination),
  }));
  const missingArtifacts = artifacts
    .map(({ source }) => source)
    .filter((filePath) => !exists(filePath));
  if (missingArtifacts.length > 0) {
    throw new Error(`[windowsNativePrebuilds] Missing artifacts: ${missingArtifacts.join(", ")}`);
  }

  const resolvedElectronVersion = electronVersion
    || require(path.join(projectDir, "node_modules", "electron", "package.json")).version;
  const forgeMeta = `${targetArch}--${getAbi(resolvedElectronVersion, "electron")}`;
  for (const artifact of artifacts) {
    if (readMachine(artifact.source) !== expectedMachine) {
      throw new Error(
        `[windowsNativePrebuilds] Artifact does not match Windows ${targetArch}: ${artifact.source}`,
      );
    }
    mkdir(path.dirname(artifact.destination), { recursive: true });
    copy(artifact.source, artifact.destination);
    writeFile(path.join(path.dirname(artifact.destination), ".forge-meta"), forgeMeta, "utf8");
  }
  logger.log(
    `[windowsNativePrebuilds] Prepared ${artifacts.length} native modules for Windows ${targetArch} `
    + `(Electron ${resolvedElectronVersion})`,
  );
  return true;
}

function beforePackCursorSdk(context = {}) {
  const projectDir = context.appDir || process.cwd();
  const platform = context.electronPlatformName || process.platform;
  const arch = normalizeWindowsHelperArch(context.arch || process.env.npm_config_arch || process.arch);
  const ensureCursor = context.ensureCursorSdkPlatformPackages || ensureCursorSdkPlatformPackages;
  ensureCursor({ projectDir, platform });
  const buildHelper = context.buildWindowsHelloHelper || buildWindowsHelloHelper;
  if (platform === "win32") {
    const prepareNative = context.prepareWindowsNativePrebuilds || prepareWindowsNativePrebuilds;
    prepareNative({
      projectDir,
      platform,
      arch,
      electronVersion: context.electronVersion,
    });
    const prepareNodePty = context.preparePrebuiltNodePty || preparePrebuiltNodePty;
    prepareNodePty({
      projectDir,
      platform,
      arch,
      electronVersion: context.electronVersion,
    });
    const result = buildHelper({ projectDir, platform, arch });
    if (result?.skipped) {
      throw new Error(`Windows Hello helper was not built: ${result.reason || "unknown"}`);
    }
  }
}

module.exports = beforePackCursorSdk;
module.exports.default = beforePackCursorSdk;
module.exports.beforePackCursorSdk = beforePackCursorSdk;
module.exports.ensureCursorSdkPlatformPackages = ensureCursorSdkPlatformPackages;
module.exports.CURSOR_PLATFORM_PACKAGES = CURSOR_PLATFORM_PACKAGES;
module.exports.prepareWindowsNativePrebuilds = prepareWindowsNativePrebuilds;
module.exports.WINDOWS_NATIVE_PREBUILD_FILES = WINDOWS_NATIVE_PREBUILD_FILES;
