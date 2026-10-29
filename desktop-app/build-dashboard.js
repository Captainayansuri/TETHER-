const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = __dirname;
const source = path.join(root, 'public');
const staged = path.join(root, 'src');
const output = path.join(root, 'dist');

async function copyAsset(name) {
  await fs.copyFile(path.join(source, name), path.join(staged, name));
}

async function build() {
  await fs.rm(staged, { recursive: true, force: true });
  await fs.mkdir(staged, { recursive: true });
  await copyAsset('app-dashboard.js');
  await copyAsset('app-dashboard.css');
  await copyAsset('pairing-ui.js');
  await fs.cp(path.join(source, 'mobile'), path.join(staged, 'mobile'), { recursive: true });
  await fs.copyFile(path.join(root, 'index.html'), path.join(staged, 'index.html'));
  const result = spawnSync(process.execPath, [
    path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    'build',
    '--config',
    path.join(root, 'vite.config.mjs')
  ], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
  if (result.status === 0) {
    const builtPage = path.join(output, 'src', 'index.html');
    let html = await fs.readFile(builtPage, 'utf8');
    html = html.replaceAll('../assets/', './assets/');
    await fs.writeFile(path.join(output, 'index.html'), html);
    await fs.rm(path.join(output, 'src'), { recursive: true, force: true });
    await fs.copyFile(path.join(source, 'pairing-ui.js'), path.join(output, 'pairing-ui.js'));
    await fs.cp(path.join(source, 'mobile'), path.join(output, 'mobile'), { recursive: true });
  }
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
