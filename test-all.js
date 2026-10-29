const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const isWindows = process.platform === 'win32';

function run(label, command, args, cwd) {
  process.stdout.write('\n=== ' + label + ' ===\n');
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: isWindows
  });
  if (result.error) {
    process.stderr.write(label + ' could not start: ' + result.error.message + '\n');
    return result.status || 1;
  }
  return result.status === null ? 1 : result.status;
}

const npm = isWindows ? 'npm.cmd' : 'npm';
let status = run('Desktop and web receiver tests', npm, ['test'], path.join(root, 'desktop-app'));
if (status !== 0) process.exit(status);

const androidDirectory = path.join(root, 'android-app');
const wrapperName = isWindows ? 'gradlew.bat' : 'gradlew';
const wrapperPath = path.join(androidDirectory, wrapperName);
const gradle = fs.existsSync(wrapperPath) ? wrapperPath : 'gradle';
const gradleArgs = fs.existsSync(wrapperPath)
  ? [':app:testDebugUnitTest', ':app:connectedDebugAndroidTest']
  : ['-p', androidDirectory, ':app:testDebugUnitTest', ':app:connectedDebugAndroidTest'];

status = run('Android unit and connected-device tests', gradle, gradleArgs, androidDirectory);
if (status !== 0) process.exit(status);

process.stdout.write('\nAll desktop, web receiver, and Android tests passed.\n');
