const fs = require('node:fs');
const path = require('node:path');

const PREBUILDS_DIR = path.join(
  __dirname,
  '..',
  'node_modules',
  '@serialport',
  'bindings-cpp',
  'prebuilds',
);

if (!fs.existsSync(PREBUILDS_DIR)) {
  process.exit(0);
}

const dirs = fs.readdirSync(PREBUILDS_DIR);

for (const dir of dirs) {
  const dirPath = path.join(PREBUILDS_DIR, dir);
  if (!fs.statSync(dirPath).isDirectory()) continue;

  const files = fs.readdirSync(dirPath);

  // Find the serialport binding file (named like @serialport+bindings-cpp.node)
  // and create a node.napi.node symlink so @electron/rebuild can detect it.
  const bindingFile = files.find((f) => f.startsWith('@serialport') && f.endsWith('.node'));
  if (!bindingFile) continue;

  const linkPath = path.join(dirPath, 'node.napi.node');
  if (fs.existsSync(linkPath)) {
    // Already linked — verify it still points correctly
    try {
      if (fs.readlinkSync(linkPath) === bindingFile) continue;
      fs.unlinkSync(linkPath);
    } catch {
      fs.unlinkSync(linkPath);
    }
  }

  fs.symlinkSync(bindingFile, linkPath);
  console.log(`[serialport-prebuild] Linked ${dir}/${bindingFile} -> ${dir}/node.napi.node`);
}
