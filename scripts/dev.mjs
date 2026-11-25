import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import {
  acquireLock,
  developmentEnvironment,
  readJson,
  runtimeProfile,
  settingsPlugin,
  tauriConfiguration,
  writeJson,
} from './dev-runtime.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** HTTP 서버를 직접 바인딩하고 점유된 경우 다음 포트를 시도한다. */
async function bindServer(server, preferred) {
  let port = preferred;
  for (;;) {
    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => {
          server.off('listening', listening);
          reject(error);
        };
        const listening = () => {
          server.off('error', failed);
          resolve();
        };
        server.once('error', failed);
        server.once('listening', listening);
        server.listen(port, '127.0.0.1');
      });
      return;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      port = port < 65535 ? port + 1 : 0;
    }
  }
}

/** Vite 미들웨어와 HMR을 같은 서버에 올리고 종료 책임은 런처에만 둔다. */
export async function startServer(profile, options = {}) {
  const portFile = path.join(profile.runtimeRoot, 'last-port.json');
  const previous = readJson(portFile, null);
  const preferred =
    Number.isInteger(previous) && previous >= 1024 && previous < 65535
      ? previous
      : 1420 + (Number.parseInt(profile.worktreeId.slice(0, 4), 16) % 20000);
  const environment = developmentEnvironment(profile, options.env);
  const httpServer = http.createServer();
  const vite = await createServer({
    root: path.join(profile.root, 'apps/desktop'),
    configFile: options.configFile ?? path.join(profile.root, 'apps/desktop/vite.config.ts'),
    cacheDir: path.join(profile.artifactRoot, 'vite'),
    plugins: [settingsPlugin(profile, httpServer)],
    define: Object.fromEntries(
      Object.entries(environment)
        .filter(([key]) => key.startsWith('VITE_MGIT_'))
        .map(([key, value]) => [`import.meta.env.${key}`, JSON.stringify(value)]),
    ),
    server: {
      host: '127.0.0.1',
      middlewareMode: true,
      ws: { server: httpServer, host: '127.0.0.1' },
      cors: false,
    },
  });
  httpServer.on('request', (request, response) => vite.middlewares(request, response));
  let closing;
  const server = {
    ...vite,
    httpServer,
    close() {
      closing ??= (async () => {
        const stopped = new Promise((resolve, reject) => {
          httpServer.close((error) =>
            error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve(),
          );
        });
        await vite.close();
        await stopped;
      })();
      return closing;
    },
  };
  try {
    await bindServer(httpServer, preferred);
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port.');
    const url = `http://127.0.0.1:${address.port}`;
    writeJson(portFile, address.port);
    return { server, url, environment };
  } catch (error) {
    await server.close();
    throw error;
  }
}

/** 런처가 만든 프로세스 그룹을 정리하며 리더 종료 후 남은 자식도 함께 회수한다. */
async function stopChild(child) {
  if (!child?.pid) return;
  const signal = (name) => {
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  if (child.exitCode === null && child.signalCode === null) {
    let timeout;
    await Promise.race([
      once(child, 'exit'),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, 4000);
      }),
    ]);
    clearTimeout(timeout);
  }
  signal('SIGKILL');
}

/** 웹 서버·네이티브 자식·잠금을 하나의 수명으로 관리하며 중복 개발 실행을 막는다. */
export async function main(args = process.argv.slice(2), options = {}) {
  const root = options.root ?? ROOT;
  if (args.includes('--direct'))
    throw new Error(
      'Use pnpm dev (or pnpm dev --release) so Vite binds before Tauri receives its isolated runtime configuration.',
    );
  const separator = args.indexOf('--');
  const flags = separator < 0 ? args : args.slice(0, separator);
  const forwarded = separator < 0 ? [] : args.slice(separator);
  const web = flags.includes('--web');
  const test = flags.includes('--test');
  const nativeFlags = flags.filter((arg) => !['--web', '--test'].includes(arg));
  if ((web && test) || nativeFlags.some((arg) => !['--release', '--no-watch'].includes(arg)))
    throw new Error(
      'Usage: dev.mjs [--web | --test] [--release] [--no-watch] [-- <cargo/app arguments>]',
    );
  const nativeArgs = [...nativeFlags, ...forwarded];
  const profile = runtimeProfile(root, test ? 'test' : 'development');
  const lock = acquireLock(profile);
  let server;
  let child;
  let finishing;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const finish = (exitCode = 0) => {
    finishing ??= (async () => {
      try {
        await stopChild(child);
      } finally {
        try {
          await server?.close();
        } finally {
          lock.release();
          resolveDone(exitCode);
        }
      }
    })();
    return finishing;
  };
  const interrupt = () => {
    void finish(130);
  };
  const terminate = () => {
    void finish(143);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    const serverOptions = { ...options.serverOptions };
    if (web) {
      const env = serverOptions.env ?? process.env;
      serverOptions.env = {
        ...env,
        VITE_MGIT_MOCK: env.VITE_MGIT_MOCK || '100',
        VITE_MGIT_MOCK_SCENE: env.VITE_MGIT_MOCK_SCENE || 'repo',
      };
    }
    const started = await startServer(profile, serverOptions);
    server = started.server;
    if (finishing) {
      await server.close();
      return await done;
    }
    lock.update(started.url);
    console.log(`${profile.title}: ${started.url}\nRuntime: ${profile.runtimeRoot}`);
    if (!web) {
      const base = readJson(path.join(root, 'apps/desktop/src-tauri/tauri.conf.json'));
      child = (options.spawn ?? spawn)(
        'pnpm',
        [
          '-F',
          '@mgit/desktop',
          'tauri',
          'dev',
          '--config',
          JSON.stringify(tauriConfiguration(profile, started.url, base)),
          ...nativeArgs,
        ],
        {
          cwd: root,
          env: started.environment,
          stdio: 'inherit',
          detached: process.platform !== 'win32',
        },
      );
      child.once('error', (error) => {
        console.error(error.message);
        void finish(1);
      });
      child.once('exit', (code) => {
        void finish(code ?? 1);
      });
    }
    return await done;
  } catch (error) {
    await finish(1);
    throw error;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
