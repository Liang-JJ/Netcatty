// Restore npm-shipped Windows prebuilt native binaries that @electron/rebuild
// would otherwise try to cross-compile from source (which fails on macOS).
//
// Some npm packages ship a prebuilt Windows `.node` directly under
// `build/Release/<target>.node` instead of using the prebuildify
// `prebuilds/<platform>-<arch>/` convention. @electron/rebuild does not
// recognise that layout and falls back to node-gyp, which cannot cross-compile
// to win32 from macOS, breaking `pack:win-x64`.
//
// Worse: running `pack:mac` first recompiles these modules for darwin and
// overwrites the shipped Windows binary, so by the time `pack:win-x64` runs
// the `build/Release/*.node` is a Mach-O bundle.
//
// Strategy: for each module below, re-extract the original Windows binary from
// the npm registry tarball back into its `build/Release/` directory. The
// `.forge-meta` file written by a previous rebuild encodes `${arch}--${ABI}`
// (no platform), so with the ABI matching electron's it already satisfies
// `alreadyBuiltByRebuild()` and @electron/rebuild skips node-gyp.
//
// This is a no-op when the module is not installed or when the binary cannot
// be fetched (leaves the existing file untouched).

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ROOT = path.resolve(__dirname, '..');

// Maps: module path (under node_modules) -> { npmPackage, targetName }.
// targetName is the binding.gyp target_name (== the shipped `.node` basename).
const MODULES = [
  {
    modulePath: path.join(ROOT, 'node_modules', '@vscode', 'windows-process-tree'),
    npmPackage: '@vscode/windows-process-tree',
    targetName: 'windows_process_tree',
  },
];

function fetchTarball(packageSpec) {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${packageSpec}/-/$(basename)`;
    // Resolve the actual tarball URL from the registry metadata so we pin the
    // installed version rather than always pulling "latest".
    https.get(`https://registry.npmjs.org/${packageSpec}`, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`registry returned ${res.statusCode} for ${packageSpec}`));
        res.resume();
        return;
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const meta = JSON.parse(data);
          const version = meta['dist-tags']?.latest || meta.version;
          const tarball = meta.versions?.[version]?.dist?.tarball;
          if (!tarball) {
            reject(new Error(`could not resolve tarball for ${packageSpec}`));
            return;
          }
          https.get(tarball, (res2) => {
            if (res2.statusCode !== 200) {
              reject(new Error(`tarball returned ${res2.statusCode}`));
              res2.resume();
              return;
            }
            const chunks = [];
            res2.on('data', (c) => chunks.push(c));
            res.on('end', () => {});
            res2.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject);
        } catch (err) {
          reject(err);
        }
      });
    }).on('error', reject);
  });
}

// Unzip won't handle .tgz well from a Buffer; use tar to list+extract a single
// member to stdout. tar is present on macOS/Linux and is reliable here.
function extractMemberFromTarball(tarballBuffer, memberPath) {
  const { execFileSync } = require('node:child_process');
  const tmp = path.join(require('node:os').tmpdir(), `netcatty-prebuild-${process.pid}-${Date.now()}.tgz`);
  fs.writeFileSync(tmp, tarballBuffer);
  try {
    // tar converts `package/` prefix to `./`; request without leading `package/`
    const entry = memberPath.replace(/^package\//, '');
    return execFileSync('tar', ['-xzf', tmp, '-O', `package/${entry}`], {
      maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

async function restoreModule(mod) {
  if (!fs.existsSync(mod.modulePath)) return;
  const releaseDir = path.join(mod.modulePath, 'build', 'Release');
  const nodeFile = path.join(releaseDir, `${mod.targetName}.node`);

  // Detect the current binary's platform. Only proceed when it is NOT a
  // win32 PE — if we already have the right Windows binary, nothing to do.
  let currentPlatform = 'unknown';
  try {
    const fd = fs.openSync(nodeFile, 'r');
    const header = Buffer.alloc(2);
    fs.readSync(fd, header, 0, 2, 0);
    fs.closeSync(fd);
    // PE32+ starts with "MZ" (0x4D 0x5A). Mach-O starts with 0xCF 0xFA (64-bit)
    // or 0xFE 0xED. ELF starts with 0x7F "ELF".
    if (header[0] === 0x4D && header[1] === 0x5A) currentPlatform = 'win32';
    else if (header[0] === 0xCF && header[1] === 0xFA) currentPlatform = 'darwin';
    else if (header[0] === 0x7F && header[1] === 0x45) currentPlatform = 'linux';
  } catch {
    // No .node file yet — fall through and restore one.
  }

  let tarball;
  try {
    tarball = await fetchTarball(mod.npmPackage);
  } catch (err) {
    console.warn(`[win-prebuild-restore] Could not fetch tarball for ${mod.npmPackage}: ${err.message}`);
    return;
  }

  let windowsBinary;
  try {
    windowsBinary = extractMemberFromTarball(tarball, `package/build/Release/${mod.targetName}.node`);
  } catch (err) {
    console.warn(`[win-prebuild-restore] No prebuilt .node found in ${mod.npmPackage} tarball: ${err.message}`);
    return;
  }

  if (currentPlatform === 'win32') {
    // Already Windows — avoid overwriting with an identical copy.
    return;
  }

  fs.mkdirSync(releaseDir, { recursive: true });
  fs.writeFileSync(nodeFile, windowsBinary);
  console.log(`[win-prebuild-restore] Restored win32 ${mod.targetName}.node for ${mod.npmPackage} (was ${currentPlatform})`);
}

async function main() {
  for (const mod of MODULES) {
    try {
      await restoreModule(mod);
    } catch (err) {
      console.warn(`[win-prebuild-restore] ${mod.npmPackage}: ${err.message}`);
    }
  }
}

main();