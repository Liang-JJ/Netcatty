const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  getExpectedPeMachine,
  readPeMachine,
} = require("./build-windows-hello-helper.cjs");
const { getAbi } = require("node-abi");

const ELECTRON_BUILDER_ARCH = {
  0: "ia32",
  1: "x64",
  2: "armv7l",
  3: "arm64",
  4: "universal",
};

const NODE_PTY_RUNTIME_FILES = [
  "pty.node",
  "conpty.node",
  "conpty_console_list.node",
  "winpty.dll",
  "winpty-agent.exe",
  path.join("conpty", "conpty.dll"),
  path.join("conpty", "OpenConsole.exe"),
];

function targetArchName(arch) {
  return typeof arch === "number" ? ELECTRON_BUILDER_ARCH[arch] : arch;
}

function nodePtyArtifacts(projectDir) {
  const releaseDir = path.join(projectDir, "node_modules", "node-pty", "build", "Release");
  return [
    { source: path.join(releaseDir, "conpty.node"), relative: "conpty.node" },
    { source: path.join(releaseDir, "conpty", "conpty.dll"), relative: path.join("conpty", "conpty.dll") },
    { source: path.join(releaseDir, "conpty", "OpenConsole.exe"), relative: path.join("conpty", "OpenConsole.exe") },
  ];
}

function preparePrebuiltNodePty({
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
  if (platform !== "win32" || !env.NETCATTY_NODE_PTY_PREBUILD_DIR) return false;
  const targetArch = targetArchName(arch);
  if (!targetArch || targetArch === "universal") {
    throw new Error(`[nodePtyConptyPatch] Unsupported Windows architecture: ${String(arch)}`);
  }

  const prebuiltDir = env.NETCATTY_NODE_PTY_PREBUILD_DIR;
  const releaseDir = path.join(projectDir, "node_modules", "node-pty", "build", "Release");
  const expectedMachine = getExpectedPeMachine(targetArch);
  const artifacts = NODE_PTY_RUNTIME_FILES.map((relative) => ({
    source: path.join(prebuiltDir, relative),
    destination: path.join(releaseDir, relative),
  }));
  const missingArtifacts = artifacts
    .map(({ source }) => source)
    .filter((filePath) => !exists(filePath));
  if (missingArtifacts.length > 0) {
    throw new Error(
      `[nodePtyConptyPatch] Prebuilt node-pty artifacts missing: ${missingArtifacts.join(", ")}`,
    );
  }

  for (const artifact of artifacts) {
    if (readMachine(artifact.source) !== expectedMachine) {
      throw new Error(
        `[nodePtyConptyPatch] Prebuilt artifact does not match Windows ${targetArch}: ${artifact.source}`,
      );
    }
    mkdir(path.dirname(artifact.destination), { recursive: true });
    copy(artifact.source, artifact.destination);
  }

  const resolvedElectronVersion = electronVersion
    || require(path.join(projectDir, "node_modules", "electron", "package.json")).version;
  writeFile(
    path.join(releaseDir, ".forge-meta"),
    `${targetArch}--${getAbi(resolvedElectronVersion, "electron")}`,
    "utf8",
  );
  logger.log(
    `[nodePtyConptyPatch] Prepared prebuilt node-pty runtime for Windows ${targetArch} `
    + `(Electron ${resolvedElectronVersion})`,
  );
  return true;
}

function rebuildPatchedNodePty({
  projectDir,
  platform,
  arch,
  run = execFileSync,
  exists = fs.existsSync,
  copy = fs.copyFileSync,
  mkdir = fs.mkdirSync,
  env = process.env,
  readMachine = readPeMachine,
  logger = console,
}) {
  if (platform !== "win32") return false;
  const targetArch = targetArchName(arch);
  if (!targetArch || targetArch === "universal") {
    throw new Error(`[nodePtyConptyPatch] Unsupported Windows architecture: ${String(arch)}`);
  }

  const prebuiltDir = env.NETCATTY_NODE_PTY_PREBUILD_DIR;
  if (prebuiltDir) {
    const expectedMachine = getExpectedPeMachine(targetArch);
    const artifacts = nodePtyArtifacts(projectDir).map((artifact) => ({
      ...artifact,
      prebuilt: path.join(prebuiltDir, artifact.relative),
    }));
    const missingArtifacts = artifacts
      .map(({ prebuilt }) => prebuilt)
      .filter((filePath) => !exists(filePath));
    if (missingArtifacts.length > 0) {
      throw new Error(
        `[nodePtyConptyPatch] Prebuilt node-pty artifacts missing: ${missingArtifacts.join(", ")}`,
      );
    }
    for (const artifact of artifacts) {
      if (readMachine(artifact.prebuilt) !== expectedMachine) {
        throw new Error(
          `[nodePtyConptyPatch] Prebuilt artifact does not match Windows ${targetArch}: ${artifact.prebuilt}`,
        );
      }
      mkdir(path.dirname(artifact.source), { recursive: true });
      copy(artifact.prebuilt, artifact.source);
    }
    logger.log(`[nodePtyConptyPatch] Using prebuilt patched node-pty runtime for Windows ${targetArch}`);
    return true;
  }

  const rebuildCli = path.join(projectDir, "node_modules", "@electron", "rebuild", "lib", "cli.js");
  logger.log(`[nodePtyConptyPatch] Rebuilding patched node-pty for Windows ${targetArch}`);
  run(process.execPath, [
    rebuildCli,
    "--force",
    "--build-from-source",
    "--only",
    "node-pty",
    "--arch",
    targetArch,
  ], {
    cwd: projectDir,
    stdio: "inherit",
  });

  const nodePtyDir = path.join(projectDir, "node_modules", "node-pty");
  run(process.execPath, [path.join(nodePtyDir, "scripts", "post-install.js")], {
    cwd: projectDir,
    stdio: "inherit",
    env: { ...process.env, npm_config_arch: targetArch },
  });

  const missingArtifacts = nodePtyArtifacts(projectDir)
    .map(({ source }) => source)
    .filter((filePath) => !exists(filePath));
  if (missingArtifacts.length > 0) {
    throw new Error(
      `[nodePtyConptyPatch] Patched node-pty artifacts missing: ${missingArtifacts.join(", ")}`,
    );
  }
  return true;
}

function copyPatchedNodePtyToPackagedApp({ projectDir, resourcesDir, copy = fs.copyFileSync, mkdir = fs.mkdirSync }) {
  const packagedReleaseDir = path.join(
    resourcesDir,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
    "build",
    "Release",
  );
  const copied = [];
  for (const artifact of nodePtyArtifacts(projectDir)) {
    const destination = path.join(packagedReleaseDir, artifact.relative);
    mkdir(path.dirname(destination), { recursive: true });
    copy(artifact.source, destination);
    copied.push(destination);
  }
  return copied;
}

module.exports = {
  copyPatchedNodePtyToPackagedApp,
  NODE_PTY_RUNTIME_FILES,
  nodePtyArtifacts,
  preparePrebuiltNodePty,
  rebuildPatchedNodePty,
};
