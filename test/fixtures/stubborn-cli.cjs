// A CLI that does not stop when asked. `leave-pipes` mode leaves a descendant holding stdout/stderr
// after the CLI itself is gone, so the stream never ends.
const { spawn } = require('node:child_process');
const mode = process.argv[2];
if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => undefined);
  setInterval(() => undefined, 1_000);
} else if (mode === 'leave-pipes') {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => undefined, 20000)'], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.unref();
  process.stdout.write('started\n');
  setTimeout(() => process.exit(0), 20);
} else {
  process.stdout.write('ok\n');
}
