'use strict';

const assert = require('assert');
const { spawn } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');

const ROOT = join(__dirname, '..');
const TIMEOUT_MS = 5000;

function proxySource() {
  const source = readFileSync(join(ROOT, 'src', 'main.js'), 'utf8');
  const match = source.match(/const PTY_PROXY_PY = `([\s\S]*?)`;/);
  assert(match, 'Could not find PTY_PROXY_PY in src/main.js');
  return match[1];
}

function waitForOutput(proc, pattern, output) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern}`)), TIMEOUT_MS);
    const check = chunk => {
      output.value += chunk.toString();
      const match = typeof pattern === 'string'
        ? output.value.includes(pattern)
        : output.value.match(pattern);
      if (match) {
        clearTimeout(timer);
        proc.stdout.off('data', check);
        resolve(match);
      }
    };
    proc.stdout.on('data', check);
  });
}

function waitForExit(proc) {
  return new Promise((resolve, reject) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve({ code: proc.exitCode, signal: proc.signalCode });
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error('PTY proxy did not exit'));
    }, TIMEOUT_MS);
    proc.once('error', reject);
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function startProxy() {
  return spawn('python3', ['-c', proxySource(), '/bin/sh'], {
    cwd: ROOT,
    stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, TERM: 'xterm-256color' },
  });
}

async function testResizeAndExitStatus() {
  const proc = startProxy();
  const output = { value: '' };
  const ready = '__MT_READY__';
  const marker = '__MT_DONE__';

  proc.stdin.write("printf '__MT_%s__\\n' READY\n");
  await waitForOutput(proc, ready, output);
  proc.stdio[3].write('40x');
  await new Promise(resolve => setTimeout(resolve, 25));
  proc.stdio[3].write('120\n');
  await new Promise(resolve => setTimeout(resolve, 25));
  proc.stdin.write("stty size; printf '__MT_%s__\\n' DONE; exit 7\n");

  await waitForOutput(proc, marker, output);
  const result = await waitForExit(proc);

  assert.match(
    output.value,
    /40 120/,
    `Fragmented resize command was not applied. Output: ${JSON.stringify(output.value)}`,
  );
  assert.strictEqual(result.signal, null, 'Shell exited from an unexpected signal');
  assert.strictEqual(result.code, 7, 'Proxy did not preserve the shell exit status');
}

async function testForegroundProcessCleanup() {
  const proc = startProxy();
  const output = { value: '' };
  try {
    proc.stdin.write("sh -c 'echo __MT_CHILD_$$; exec sleep 30'\n");
    const match = await waitForOutput(proc, /__MT_CHILD_(\d+)/, output);
    const childPid = Number(match[1]);

    proc.kill('SIGTERM');
    await waitForExit(proc);
    await new Promise(resolve => setTimeout(resolve, 100));

    let alive = true;
    try {
      process.kill(childPid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') alive = false;
      else throw error;
    }

    if (alive) {
      try { process.kill(childPid, 'SIGKILL'); } catch {}
    }
    assert.strictEqual(alive, false, 'Foreground process survived proxy shutdown');
  } finally {
    if (proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch {}
    }
  }
}

async function main() {
  await testResizeAndExitStatus();
  await testForegroundProcessCleanup();
  console.log('Many Terminals smoke tests passed');
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
