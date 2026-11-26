import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, startServer } from '../dev.mjs';
import {
  acquireLock,
  developmentEnvironment,
  readJson,
  runtimeProfile,
  tauriConfiguration,
  writeJson,
} from '../dev-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureBase = path.join(ROOT, 'target/runtime-tests');
fs.mkdirSync(fixtureBase, { recursive: true });
const fixtures = [];
after(() => {
  for (const fixture of fixtures) fs.rmSync(fixture, { recursive: true, force: true });
});

/** 테스트 checkout을 현재 workspace 하위에서만 만들고 테스트 후 회수한다. */
function fixture() {
  const directory = fs.mkdtempSync(path.join(fixtureBase, 'case-'));
  fixtures.push(directory);
  fs.mkdirSync(path.join(directory, 'apps/desktop/src-tauri'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'apps/desktop/index.html'), '<div>fixture</div>');
  writeJson(path.join(directory, 'apps/desktop/src-tauri/tauri.conf.json'), {
    app: { windows: [{ label: 'main', title: 'mGit' }] },
  });
  return directory;
}

/** 설정 저장 API의 실제 HTTP 응답을 확인한다. */
async function save(url, key, value) {
  const response = await fetch(`${url}/__mgit/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
  assert.equal(response.status, 204);
}

test('canonical checkout identity is stable across symlinks and separate for other checkouts', () => {
  const root = fixture();
  const link = `${root}-link`;
  fs.symlinkSync(root, link);
  fixtures.push(link);
  const a = runtimeProfile(root);
  assert.deepEqual(runtimeProfile(link), a);
  assert.notEqual(runtimeProfile(fixture()).identifier, a.identifier);
  assert.equal(a.dataStoreIdentifier.length, 16);
  const env = developmentEnvironment(a, {
    CARGO_TARGET_DIR: '/shared/target',
    TAURI_CONFIG: 'old',
  });
  assert.ok(env.CARGO_TARGET_DIR.startsWith(`${root}/target/`));
  assert.equal(env.TAURI_CONFIG, undefined);
});

test('two native test runs get distinct paths, identifiers, caches and mock defaults', () => {
  const root = fixture();
  const a = runtimeProfile(root, 'test');
  const b = runtimeProfile(root, 'test');
  assert.notEqual(a.identifier, b.identifier);
  assert.notEqual(a.runtimeRoot, b.runtimeRoot);
  assert.notEqual(a.artifactRoot, b.artifactRoot);
  assert.notDeepEqual(a.dataStoreIdentifier, b.dataStoreIdentifier);
  assert.equal(developmentEnvironment(a, {}).VITE_MGIT_MOCK, '100');
  assert.equal(developmentEnvironment(a, {}).MGIT_RUNTIME_MODE, 'test');
});

test('duplicate launcher reports the original URL and cannot take ownership', () => {
  const profile = runtimeProfile(fixture());
  const lock = acquireLock(profile);
  try {
    lock.update('http://127.0.0.1:2345');
    assert.throws(() => acquireLock(profile), /127.0.0.1:2345/);
  } finally {
    lock.release();
  }
  acquireLock(profile).release();
});

test('occupied preferred port falls back while settings survive port changes and stay isolated', async () => {
  const a = runtimeProfile(fixture());
  const b = runtimeProfile(fixture());
  const occupied = http.createServer((_request, response) => response.end('unrelated server'));
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const port = occupied.address().port;
  writeJson(path.join(a.runtimeRoot, 'last-port.json'), port);
  writeJson(path.join(b.runtimeRoot, 'last-port.json'), port);
  const servers = [];
  try {
    const first = await startServer(a, { configFile: false, env: {} });
    servers.push(first.server);
    const other = await startServer(b, { configFile: false, env: {} });
    servers.push(other.server);
    assert.notEqual(first.url, `http://127.0.0.1:${port}`);
    assert.notEqual(first.url, other.url);
    assert.equal(first.server.config.server.host, '127.0.0.1');
    assert.equal(first.server.config.server.ws.port, undefined);
    assert.equal(first.server.config.server.ws.clientPort, undefined);
    await save(first.url, 'mgit.theme', 'dark');
    await Promise.all([
      save(first.url, 'mgit.language', 'ko'),
      save(first.url, 'mgit.layout', 'split'),
    ]);
    assert.deepEqual(await (await fetch(`${other.url}/__mgit/settings`)).json(), {});
    const profile = await (await fetch(`${first.url}/__mgit/profile`)).json();
    assert.deepEqual(profile, { kind: a.kind, id: a.id, title: a.title });
    await first.server.close();
    writeJson(path.join(a.runtimeRoot, 'last-port.json'), Number(new URL(other.url).port));
    const restarted = await startServer(a, { configFile: false, env: {} });
    servers.push(restarted.server);
    assert.notEqual(first.url, restarted.url);
    assert.deepEqual(await (await fetch(`${restarted.url}/__mgit/settings`)).json(), {
      'mgit.theme': 'dark',
      'mgit.language': 'ko',
      'mgit.layout': 'split',
    });
    await save(restarted.url, 'mgit.theme', null);
    assert.equal(
      (await (await fetch(`${restarted.url}/__mgit/settings`)).json())['mgit.theme'],
      undefined,
    );
    const config = tauriConfiguration(a, restarted.url, { app: { windows: [{ label: 'main' }] } });
    assert.equal(config.build.devUrl, restarted.url);
    assert.equal(config.build.beforeDevCommand, '');
    assert.ok(config.app.security.devCsp.includes(restarted.url.replace('http:', 'ws:')));
    assert.ok(config.app.security.devCsp.includes("'wasm-unsafe-eval'"));
    assert.ok(config.app.security.devCsp.includes("worker-src 'self'"));
    assert.ok(config.app.security.devCsp.includes("connect-src 'self'"));
    assert.ok(!config.app.security.devCsp.includes("'unsafe-eval'"));
    assert.equal(config.app.windows[0].dataStoreIdentifier, undefined);
    assert.ok(!JSON.stringify(config).includes('dataStoreIdentifier'));
    assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(), 'unrelated server');
  } finally {
    for (const server of servers) await server.close();
    await new Promise((resolve) => occupied.close(resolve));
  }
});

test('HMR uses each bound HTTP port and delivers only its own runtime updates', async () => {
  const a = await startServer(runtimeProfile(fixture()), { configFile: false, env: {} });
  const b = await startServer(runtimeProfile(fixture()), { configFile: false, env: {} });
  const sockets = [];
  try {
    const received = [[], []];
    const connected = await Promise.all(
      [a, b].map(async (instance, index) => {
        const socket = new WebSocket(
          `${instance.url.replace('http:', 'ws:')}/?token=${instance.server.config.webSocketToken}`,
          'vite-hmr',
        );
        sockets.push(socket);
        socket.addEventListener('message', (event) => {
          const message = JSON.parse(event.data);
          if (message.type === 'custom') received[index].push(message.data);
        });
        await once(socket, 'open');
        return socket;
      }),
    );
    const updates = connected.map(
      (socket) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('HMR update timed out')), 3000);
          socket.addEventListener('message', function receive(event) {
            if (JSON.parse(event.data).type === 'custom') {
              clearTimeout(timer);
              socket.removeEventListener('message', receive);
              resolve();
            }
          });
        }),
    );
    a.server.ws.send({ type: 'custom', event: 'runtime-test', data: 'checkout-a' });
    b.server.ws.send({ type: 'custom', event: 'runtime-test', data: 'checkout-b' });
    await Promise.all(updates);
    assert.deepEqual(received, [['checkout-a'], ['checkout-b']]);
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all([a.server.close(), b.server.close()]);
  }
});

test('settings middleware rejects cross-origin, arbitrary paths, and malformed writes', async () => {
  const profile = runtimeProfile(fixture());
  const { server, url } = await startServer(profile, { configFile: false, env: {} });
  try {
    const endpoint = `${url}/__mgit/settings`;
    assert.equal(
      (await fetch(endpoint, { headers: { Origin: 'https://attacker.invalid' } })).status,
      403,
    );
    assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 415);
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: 'x', value: 'y', path: '/private/file' }),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        })
      ).status,
      400,
    );
    await save(url, '__proto__', 'safe');
    assert.equal(
      Object.getOwnPropertyDescriptor(await (await fetch(endpoint)).json(), '__proto__').value,
      'safe',
    );
  } finally {
    await server.close();
  }
});

test('corrupt settings fail startup and are not replaced with empty defaults', async () => {
  const profile = runtimeProfile(fixture());
  fs.mkdirSync(profile.runtimeRoot, { recursive: true });
  const file = path.join(profile.runtimeRoot, 'web-ui-settings.json');
  fs.writeFileSync(file, '{broken');
  await assert.rejects(startServer(profile, { configFile: false, env: {} }), SyntaxError);
  await assert.rejects(
    main(['--web'], { root: profile.root, serverOptions: { configFile: false, env: {} } }),
    SyntaxError,
  );
  assert.equal(fs.existsSync(path.join(profile.runtimeRoot, 'launcher.lock')), false);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('launcher termination reaps its child group, server and lock only', async () => {
  const root = fixture();
  const profile = runtimeProfile(root);
  const helper = path.join(root, 'run.mjs');
  const childFile = path.join(root, 'child.pid');
  fs.writeFileSync(
    helper,
    `import {spawn} from 'node:child_process';
import {main} from ${JSON.stringify(new URL('../dev.mjs', import.meta.url).href)};
process.exitCode = await main([], {root:${JSON.stringify(root)},serverOptions:{configFile:false,env:{}},spawn:(_program,_args,options)=>spawn(process.execPath,['-e',${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(childFile)}, String(process.pid)); setInterval(()=>{},1000);`)}],options)});
`,
  );
  const processUnderTest = spawn(process.execPath, [helper], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  processUnderTest.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  try {
    const deadline = Date.now() + 15000;
    while (
      !fs.existsSync(childFile) &&
      processUnderTest.exitCode === null &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fs.existsSync(childFile), true, stderr);
    const childPid = Number(fs.readFileSync(childFile, 'utf8'));
    const url = readJson(path.join(profile.runtimeRoot, 'launcher.lock/owner.json')).url;
    const exited = once(processUnderTest, 'exit');
    processUnderTest.kill('SIGTERM');
    const exitResult = await exited;
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
    assert.equal(
      fs.existsSync(path.join(profile.runtimeRoot, 'launcher.lock')),
      false,
      `${exitResult} ${stderr} ${JSON.stringify(readJson(path.join(profile.runtimeRoot, 'launcher.lock/owner.json'), {}))}`,
    );
    await assert.rejects(fetch(url));
  } finally {
    if (processUnderTest.exitCode === null && processUnderTest.signalCode === null)
      processUnderTest.kill('SIGKILL');
  }
});

// CLI 리더가 먼저 종료되어도 같은 세션에 남은 네이티브 자식이 살아 있으면 안 된다.
test('launcher cleans descendants when its CLI process exits first', async () => {
  const root = fixture();
  const profile = runtimeProfile(root);
  const helper = path.join(root, 'run.mjs');
  const descendantFile = path.join(root, 'descendant.pid');
  const descendantCode = `require('node:fs').writeFileSync(${JSON.stringify(descendantFile)}, String(process.pid)); setInterval(()=>{},1000);`;
  const leaderCode = `const {spawn} = require('node:child_process'); const fs=require('node:fs'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:'ignore'}); child.unref(); const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(descendantFile)})){clearInterval(timer);process.exit(0)}},10);`;
  fs.writeFileSync(
    helper,
    `import {spawn} from 'node:child_process';
import {main} from ${JSON.stringify(new URL('../dev.mjs', import.meta.url).href)};
process.exitCode = await main([], {root:${JSON.stringify(root)},serverOptions:{configFile:false,env:{}},spawn:(_program,_args,options)=>spawn(process.execPath,['-e',${JSON.stringify(leaderCode)}],options)});
`,
  );
  const launcher = spawn(process.execPath, [helper], { stdio: ['ignore', 'pipe', 'pipe'] });
  const [code] = await once(launcher, 'exit');
  assert.equal(code, 0);
  assert.equal(fs.existsSync(path.join(profile.runtimeRoot, 'launcher.lock')), false);
  const pid = Number(fs.readFileSync(descendantFile, 'utf8'));
  let alive = true;
  for (let attempt = 0; attempt < 40 && alive; attempt++) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch (error) {
      if (error.code === 'ESRCH') alive = false;
      else throw error;
    }
  }
  assert.equal(alive, false);
});
