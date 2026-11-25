import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';

export const PRODUCTION_ID = 'io.github.motolies.mgit';

/** 실제 checkout 경로로 식별자를 만들어 브랜치 변경과 심볼릭 링크에 영향받지 않는다. */
export function runtimeProfile(
  checkout,
  kind = 'development',
  runId = randomUUID().replaceAll('-', ''),
) {
  if (!['development', 'test'].includes(kind)) throw new Error('Invalid development runtime kind.');
  const root = fs.realpathSync(checkout);
  const worktreeId = createHash('sha256').update(root).digest('hex').slice(0, 16);
  if (kind === 'test' && !/^[a-zA-Z0-9-]{1,32}$/.test(runId))
    throw new Error('Invalid test run ID.');
  const id = kind === 'test' ? `${worktreeId}.${runId}` : worktreeId;
  const runtimeRoot = path.join(
    root,
    'target/runtime',
    worktreeId,
    ...(kind === 'test' ? ['test', runId] : []),
  );
  const identifier = `${PRODUCTION_ID}.${kind === 'test' ? 'test' : 'dev'}.${id}`;
  return {
    root,
    kind,
    id,
    worktreeId,
    runId: kind === 'test' ? runId : undefined,
    title: `${kind === 'test' ? 'mGit TEST' : 'mGit Dev'} · ${path.basename(root)}`,
    identifier,
    runtimeRoot,
    artifactRoot: path.join(root, 'target', kind === 'test' ? 'test-app' : 'dev', id),
    dataStoreIdentifier: [...createHash('sha256').update(identifier).digest().subarray(0, 16)],
  };
}

/** 설정을 원자적으로 교체해 중단 중 생긴 불완전 JSON을 다음 실행에서 읽지 않게 한다. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** 파일이 없을 때만 초기값을 사용하고 읽기 오류와 손상된 설정은 호출자에게 전달한다. */
export function readJson(file, initial) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return initial;
    throw error;
  }
}

/** 동일 checkout의 개발 실행을 원자적 디렉터리 생성으로 잠근다. */
export function acquireLock(profile) {
  const directory = path.join(profile.runtimeRoot, 'launcher.lock');
  const metadata = path.join(directory, 'owner.json');
  const token = randomUUID();
  fs.mkdirSync(profile.runtimeRoot, { recursive: true });
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = readJson(metadata, {});
    throw new Error(
      `This checkout already has a launcher lock (PID ${owner.pid ?? 'unknown'}${owner.url ? `, ${owner.url}` : ''}). If that launcher has stopped, remove ${directory}.`,
    );
  }
  try {
    writeJson(metadata, { pid: process.pid, token, kind: profile.kind });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    update(url) {
      writeJson(metadata, { pid: process.pid, token, kind: profile.kind, url });
    },
    release() {
      if (readJson(metadata, {}).token === token)
        fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** 환경별 웹 설정만 처리하고 임의 경로·교차 출처 쓰기는 받지 않는다. */
export function settingsPlugin(profile, httpServer) {
  const file = path.join(profile.runtimeRoot, 'web-ui-settings.json');
  let snapshot = readJson(file, {});
  if (
    !snapshot ||
    Array.isArray(snapshot) ||
    typeof snapshot !== 'object' ||
    Object.values(snapshot).some((value) => typeof value !== 'string')
  ) {
    throw new Error(`Invalid UI settings snapshot: ${file}`);
  }
  let queue = Promise.resolve();
  return {
    name: 'mgit-runtime-settings',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const route = request.url?.split('?')[0];
        if (!['/__mgit/settings', '/__mgit/profile'].includes(route)) return next();
        response.setHeader('Cache-Control', 'no-store');
        const address = (httpServer ?? server.httpServer)?.address();
        const origin =
          address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : undefined;
        if (
          !origin ||
          request.headers.host !== new URL(origin).host ||
          (request.headers.origin && request.headers.origin !== origin)
        ) {
          response.writeHead(403).end();
          return;
        }
        try {
          if (request.method === 'GET') {
            await queue;
            response.setHeader('Content-Type', 'application/json');
            response.end(
              JSON.stringify(
                route === '/__mgit/profile'
                  ? { kind: profile.kind, id: profile.id, title: profile.title }
                  : snapshot,
              ),
            );
            return;
          }
          if (route !== '/__mgit/settings' || request.method !== 'POST') {
            response.writeHead(405, { Allow: 'GET, POST' }).end();
            return;
          }
          if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
            response.writeHead(415).end();
            return;
          }
          let body = '';
          for await (const chunk of request) {
            body += chunk;
            if (Buffer.byteLength(body) > 1024 * 1024) {
              response.writeHead(413).end();
              return;
            }
          }
          const mutation = JSON.parse(body);
          if (
            !mutation ||
            typeof mutation.key !== 'string' ||
            mutation.key.length > 1024 ||
            !(mutation.value === null || typeof mutation.value === 'string') ||
            Object.keys(mutation).some((key) => !['key', 'value'].includes(key))
          ) {
            response.writeHead(400).end();
            return;
          }
          const write = queue.then(() => {
            const nextSnapshot = { ...snapshot };
            if (mutation.value === null) delete nextSnapshot[mutation.key];
            else
              Object.defineProperty(nextSnapshot, mutation.key, {
                value: mutation.value,
                enumerable: true,
                configurable: true,
                writable: true,
              });
            writeJson(file, nextSnapshot);
            snapshot = nextSnapshot;
          });
          queue = write.catch(() => {});
          await write;
          response.writeHead(204).end();
        } catch (error) {
          response
            .writeHead(error instanceof SyntaxError ? 400 : 500)
            .end('Settings operation failed.');
        }
      });
    },
    async closeBundle() {
      await queue;
    },
  };
}

/** 외부 Cargo 경로를 덮어써 각 checkout과 테스트 실행의 산출물을 분리한다. */
export function developmentEnvironment(profile, environment = process.env) {
  const env = {
    ...environment,
    MGIT_RUNTIME_MODE: profile.kind,
    MGIT_CHECKOUT_ROOT: profile.root,
    MGIT_WORKTREE_ID: profile.worktreeId,
    MGIT_RUNTIME_ROOT: profile.runtimeRoot,
    CARGO_TARGET_DIR: path.join(profile.artifactRoot, 'cargo'),
    VITE_MGIT_RUNTIME_MODE: profile.kind,
    VITE_MGIT_RUNTIME_TITLE: profile.title,
  };
  delete env.TAURI_CONFIG;
  delete env.MGIT_TEST_RUN_ID;
  if (profile.kind === 'test') {
    env.MGIT_TEST_RUN_ID = profile.runId;
    env.VITE_MGIT_MOCK = environment.VITE_MGIT_MOCK || '100';
    env.VITE_MGIT_MOCK_SCENE = environment.VITE_MGIT_MOCK_SCENE || 'repo';
  }
  return env;
}

/** 실제 바인딩된 서버 주소를 Tauri와 CSP에 한 번에 전달한다. */
export function tauriConfiguration(profile, url, base) {
  const websocket = url.replace(/^http:/, 'ws:');
  return {
    identifier: profile.identifier,
    productName: profile.kind === 'test' ? 'mGit TEST' : 'mGit Dev',
    build: { beforeDevCommand: '', devUrl: url },
    app: {
      windows: base.app.windows.map((window) => ({
        ...window,
        title: profile.title,
        dataStoreIdentifier: profile.dataStoreIdentifier,
      })),
      security: {
        devCsp: `default-src 'self'; img-src 'self' data: http: https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src ipc: http://ipc.localhost ${url} ${websocket}`,
      },
    },
  };
}
