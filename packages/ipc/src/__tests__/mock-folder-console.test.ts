import { beforeEach, describe, expect, it } from 'vitest';
import { type IpcClient, toIpcError } from '../client';
import { createMockClient } from '../mock/mock-client';
import { createMockRecorder, mockBatchLabel, mockIndexCommand } from '../mock/mock-console';
import type { CommandLogRecord, SessionEvent } from '../types';

/** 폴더 장면을 열고 저장소 경로·폴더 이벤트를 준다 */
async function folderScene() {
  const client: IpcClient = createMockClient({ rows: 200, scene: 'folder', progressIntervalMs: 0 });
  const [path = ''] = await client.takeStartupPaths();
  const events: SessionEvent[] = [];
  const { session: folder } = await client.openFolder(path, (e) => events.push(e));
  const repo = (name: string) => `${path}/${name}`;
  return { client, folder, repo, events };
}

/** 받은 폴더 콘솔 이벤트를 (대표 경로, 기록) 으로 */
function logged(events: readonly SessionEvent[]): { repo: string; record: CommandLogRecord }[] {
  return events.flatMap((e) =>
    e.type === 'folderCommandLogged' ? [{ repo: e.repo, record: e.record }] : [],
  );
}

/** 기록을 (저장소 이름, 명령줄, 종료 코드) 로 */
function brief(rows: { repo: string; record: CommandLogRecord }[]): [string, string, number][] {
  return rows.map(({ repo, record }) => [
    repo.split('/').pop() ?? repo,
    record.args.join(' '),
    record.status ?? -1,
  ]);
}

beforeEach(() => {
  const g = globalThis as { __mgitMockCalls?: unknown; __mgitMockBatches?: unknown };
  g.__mgitMockCalls = {};
  g.__mgitMockBatches = [];
});

describe('목의 명령 기록 재료 (W19 ②)', () => {
  it('기록은 쓰기 명령이고 번호는 10001 부터 오르며 시작 시각은 끝난 시각 − 걸린 시간이다', () => {
    const record = createMockRecorder(() => 50_000);
    const a = record('/r', { args: ['push'], status: 1, stderr: 'x', elapsedMs: 900 });
    const b = record('/r', { args: ['fetch'], status: 0, stderr: '', elapsedMs: 10 });
    expect(a).toEqual({
      id: 10_001,
      args: ['push'],
      cwd: '/r',
      startedAt: 49_100,
      elapsedMs: 900,
      status: 1,
      stderrTail: 'x',
      isWrite: true,
      cancelled: false,
    });
    expect(b.id).toBe(10_002);
  });

  it('stage·unstage 의 인자는 코어 index_write 와 같고, 건너뛴 충돌이 있으면 stdin 꼴, 돌리지 않았으면 없다', () => {
    const paths = { kind: 'paths' as const, paths: ['a b.txt', 'dir'] };
    expect(mockIndexCommand('stage', paths, { ran: true, skipped: [] })?.args).toEqual([
      'add',
      '-A',
      '--',
      'a b.txt',
      'dir',
    ]);
    expect(mockIndexCommand('unstage', { kind: 'all' }, { ran: true, skipped: [] })?.args).toEqual([
      'restore',
      '--staged',
      '--',
      '.',
    ]);
    expect(
      mockIndexCommand('stage', paths, {
        ran: true,
        skipped: [{ path: 'dir/c', reason: 'unmerged' }],
      })?.args,
    ).toEqual(['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul']);
    expect(mockIndexCommand('stage', paths, { ran: false, skipped: [] })).toBeNull();
  });

  it('일괄 작업 라벨은 코어 BatchOp::label 과 같다', () => {
    expect(mockBatchLabel({ kind: 'fetch', prune: true })).toBe('일괄 fetch');
    expect(
      mockBatchLabel({
        kind: 'createBranch',
        name: 'x',
        checkout: false,
        startPoint: 'refs/remotes/origin/main',
      }),
    ).toBe('일괄 branch 만들기: x (origin/main 에서)');
    expect(mockBatchLabel({ kind: 'checkoutRemote', remote: 'origin', branch: 'dev' })).toBe(
      '일괄 checkout: origin/dev',
    );
    expect(mockBatchLabel({ kind: 'updateBranch', name: 'development' })).toBe(
      '일괄 업데이트: development',
    );
    expect(mockBatchLabel({ kind: 'renameBranch', from: 'a', to: 'b' })).toBe(
      '일괄 이름 바꾸기: a → b',
    );
  });
});

describe('folder 장면의 일괄 이름 바꾸기', () => {
  it('branch 가 있는 저장소는 branch -m, 없는 저장소는 건너뛴다. 브랜치 목록·요약이 새 이름이 된다', async () => {
    const { client, folder, repo, events } = await folderScene();
    const before = await client.folderBranches(folder, []);
    const had = before.branches
      .find((b) => !b.remote && b.name === 'staging')
      ?.repos.map((r) => r.path);
    expect(had?.length).toBeGreaterThan(0);
    const result = await client.folderBatch(
      folder,
      { kind: 'renameBranch', from: 'staging', to: 'release/staging' },
      [],
    );
    expect(result.label).toBe('일괄 이름 바꾸기: staging → release/staging');
    for (const r of result.results) {
      if (had?.includes(r.path)) {
        expect(r.ok && r.skipped === null, r.name).toBe(true);
      } else if (r.ok) {
        expect(r.skipped, r.name).toBe('branch 없음');
      }
    }
    const lines = brief(logged(events)).filter(([, line]) => line.startsWith('branch -m'));
    expect(lines.map(([, line]) => line)).toContain(
      'branch -m --end-of-options staging release/staging',
    );
    const after = await client.folderBranches(folder, []);
    expect(after.branches.some((b) => !b.remote && b.name === 'staging')).toBe(false);
    expect(
      after.branches
        .find((b) => !b.remote && b.name === 'release/staging')
        ?.repos.map((r) => r.path),
    ).toEqual(had);
    // 그 branch 가 현재인 저장소의 요약도 새 이름이다
    const [web] = await client.folderSummaries(folder, [repo('web-console')]);
    expect(web?.branch).toBe('release/staging');
  });

  it('새 이름이 이미 있는 저장소는 건너뛰고 아무것도 바꾸지 않는다', async () => {
    const { client, folder, repo } = await folderScene();
    const result = await client.folderBatch(
      folder,
      { kind: 'renameBranch', from: 'development', to: 'main' },
      [repo('api-gateway')],
    );
    expect(result.results.map((r) => [r.name, r.skipped])).toEqual([
      ['api-gateway', '새 이름이 이미 있음: main'],
    ]);
    const after = await client.folderBranches(folder, []);
    expect(
      after.branches.find((b) => !b.remote && b.name === 'development')?.repos.map((r) => r.path),
    ).toContain(repo('api-gateway'));
  });
});

describe('folder 장면의 branch 업데이트와 pull 결과 (BR-09)', () => {
  /** 브랜치 목록에서 그 저장소의 로컬 branch 의 behind */
  async function behindOf(client: IpcClient, folder: number, branch: string, repo: string) {
    const list = await client.folderBranches(folder, []);
    return list.branches
      .find((b) => !b.remote && b.name === branch)
      ?.repos.find((r) => r.path === repo)?.behind;
  }

  it('업데이트: 뒤처진 branch 는 옮기고(moved) ↓ 가 0 이 된다. 최신·갈라짐·워크트리·실패는 저장소별로 나온다', async () => {
    const { client, folder, repo, events } = await folderScene();
    expect(await behindOf(client, folder, 'development', repo('api-gateway'))).toBe(54);
    const result = await client.folderBatch(
      folder,
      { kind: 'updateBranch', name: 'development' },
      [],
    );
    expect(result.label).toBe('일괄 업데이트: development');
    const by = (name: string) => result.results.find((r) => r.name === name);
    // api-gateway: 현재 branch 이고 깨끗하다 → 업스트림만 fetch 하고 merge --ff-only
    expect(by('api-gateway')?.moved).toMatchObject({ branch: 'development', commits: 54 });
    expect(by('auth-service')?.moved?.commits).toBe(0);
    expect(by('design-system')?.moved?.commits).toBe(0);
    // 워크트리에서 보면 development 는 원 저장소에서 checkout 중이다
    expect(by('design-system-hotfix')?.skipped).toBe(
      `다른 워크트리에서 checkout 중 (${repo('design-system')})`,
    );
    expect(by('infra-scripts')?.ok).toBe(false);
    const lines = brief(logged(events)).filter(([name]) => name === 'api-gateway');
    expect(lines.map(([, line]) => line.split(' ').slice(0, 2).join(' '))).toEqual([
      'fetch --end-of-options',
      'merge --ff-only',
    ]);
    expect(lines[0]?.[1]).toContain('+refs/heads/development:refs/remotes/origin/development');
    // 옮긴 branch 는 브랜치 목록·요약에서 ↓ 0
    expect(await behindOf(client, folder, 'development', repo('api-gateway'))).toBe(0);
    const [summary] = await client.folderSummaries(folder, [repo('api-gateway')]);
    expect(summary?.behind).toBe(0);
    // 다시 하면 이미 최신
    const again = await client.folderBatch(folder, { kind: 'updateBranch', name: 'development' }, [
      repo('api-gateway'),
    ]);
    expect(again.results[0]?.moved?.commits).toBe(0);
  });

  it('업데이트: 갈라진 branch·더티한 현재 branch·없는 branch 는 건너뛴다', async () => {
    const { client, folder, repo } = await folderScene();
    const staging = await client.folderBatch(folder, { kind: 'updateBranch', name: 'staging' }, [
      repo('web-console'),
      repo('api-gateway'),
      repo('auth-service'),
    ]);
    expect(staging.results.map((r) => [r.name, r.skipped, r.moved?.commits ?? null])).toEqual([
      ['api-gateway', null, 0],
      ['auth-service', 'branch 없음', null],
      // web-console 은 staging 이 현재 branch 이고 변경이 있다 (더티 검사가 갈라짐 판정보다 먼저)
      ['web-console', '커밋하지 않은 변경이 있음', null],
    ]);
  });

  it('pull 결과의 moved 는 받은 commit 수다 (이미 최신이면 0, 건너뛴 저장소에는 없다)', async () => {
    const { client, folder, repo } = await folderScene();
    const pull = await client.folderBatch(folder, { kind: 'pull' }, []);
    const by = (name: string) => pull.results.find((r) => r.name === name);
    expect(by('api-gateway')?.moved).toMatchObject({ branch: 'development', commits: 54 });
    expect(by('design-system')?.moved?.commits).toBe(0);
    expect(by('auth-service')?.moved).toBeUndefined();
    expect(await behindOf(client, folder, 'development', repo('api-gateway'))).toBe(0);
  });
});

describe('folder 장면의 일괄 작업과 폴더 콘솔 (W19 ②, WS-23)', () => {
  it('fetch: 저장소마다 한 줄씩 성공 기록이 오고, 요약에 실패한 저장소는 명령 없이 실패한다. 워크트리 기록은 원 저장소로 온다', async () => {
    const { client, folder, repo, events } = await folderScene();
    const result = await client.folderBatch(folder, { kind: 'fetch', prune: true }, []);
    expect(result.label).toBe('일괄 fetch');
    expect(result.results.map((r) => [r.name, r.ok, r.skipped])).toEqual([
      ['api-gateway', true, null],
      ['auth-service', true, null],
      ['billing-service', true, null],
      ['catalog-service', true, null],
      ['design-system', true, null],
      ['design-system-hotfix', true, null],
      ['infra-scripts', false, null],
      ['web-console', true, null],
    ]);
    expect(result.results.find((r) => r.name === 'infra-scripts')?.message).toContain(
      'index file smaller than expected',
    );
    expect([result.succeeded, result.skipped, result.failed]).toEqual([7, 0, 1]);
    const rows = logged(events);
    expect(brief(rows)).toEqual([
      ['api-gateway', 'fetch --all --prune', 0],
      ['auth-service', 'fetch --all --prune', 0],
      ['billing-service', 'fetch --all --prune', 0],
      ['catalog-service', 'fetch --all --prune', 0],
      ['design-system', 'fetch --all --prune', 0],
      // 워크트리에서 돈 fetch: 대표 경로는 원 저장소, 작업 디렉터리는 워크트리
      ['design-system', 'fetch --all --prune', 0],
      ['web-console', 'fetch --all --prune', 0],
    ]);
    expect(rows[5]?.record.cwd).toBe(repo('design-system-hotfix'));
    expect(rows.every((r) => r.record.isWrite && !r.record.cancelled && r.record.id > 10_000)).toBe(
      true,
    );
    expect(new Set(rows.map((r) => r.record.id)).size).toBe(rows.length);
    // behind 가 있는 저장소는 받은 ref 를 stderr 에 적는다 (git fetch 처럼)
    expect(rows[0]?.record.stderrTail).toContain('origin/development');
    // 코어와 같은 차례: 진행 시작 → (기록 → 진행) … → 끝 → 저장소마다 folderChanged
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('operationStarted');
    expect(types.indexOf('operationFinished')).toBeGreaterThan(
      types.lastIndexOf('folderCommandLogged'),
    );
    expect(types.indexOf('folderChanged')).toBeGreaterThan(types.indexOf('operationFinished'));
    expect(events.filter((e) => e.type === 'folderChanged')).toHaveLength(8);
  });

  it('push: 앞선 저장소는 성공, 갈라진 web-console 은 거부(종료 1, stderr 꼬리)되어 결과와 기록에 실패가 섞인다', async () => {
    const { client, folder, repo, events } = await folderScene();
    const result = await client.folderBatch(folder, { kind: 'push' }, [
      repo('auth-service'),
      repo('web-console'),
    ]);
    expect(result.results.map((r) => [r.name, r.ok])).toEqual([
      ['auth-service', true],
      ['web-console', false],
    ]);
    expect(result.results[1]?.message).toContain('[rejected]');
    const rows = logged(events);
    expect(brief(rows)).toEqual([
      ['auth-service', 'push', 0],
      ['web-console', 'push', 1],
    ]);
    expect(rows[1]?.record.stderrTail).toContain('failed to push some refs');
    // 전부를 고르면 올릴 것이 없거나 업스트림이 없는 저장소는 명령 없이 건너뛴다
    const all = await client.folderBatch(folder, { kind: 'push' }, []);
    expect(all.results.filter((r) => r.skipped).map((r) => [r.name, r.skipped])).toEqual([
      ['api-gateway', '보낼 commit 없음'],
      ['billing-service', '업스트림 없음'],
      ['catalog-service', '업스트림 없음'],
      ['design-system', '보낼 commit 없음'],
      ['design-system-hotfix', '업스트림 없음'],
    ]);
  });

  it('pull·branch·checkout 도 코어의 건너뜀 규칙을 따르고 실패하는 명령은 종료 코드와 사유를 싣는다', async () => {
    const { client, folder, events } = await folderScene();
    const pull = await client.folderBatch(folder, { kind: 'pull' }, []);
    expect(pull.results.map((r) => [r.name, r.skipped])).toEqual([
      ['api-gateway', null],
      ['auth-service', '커밋하지 않은 변경이 있음'],
      ['billing-service', '업스트림 없음'],
      ['catalog-service', '진행 중인 작업이 있음'],
      ['design-system', null],
      ['design-system-hotfix', '커밋하지 않은 변경이 있음'],
      ['infra-scripts', null],
      ['web-console', '커밋하지 않은 변경이 있음'],
    ]);
    events.length = 0;
    const branch = await client.folderBatch(
      folder,
      { kind: 'createBranch', name: 'main', checkout: false, startPoint: null },
      [],
    );
    // 장면의 저장소는 모두 로컬 main 이 있어 만들기가 실패(128)한다. 요약에 실패한 infra-scripts 는 명령 없이 실패
    const made = brief(logged(events));
    expect(made).toHaveLength(7);
    expect(made.every(([, line, code]) => line === 'branch -- main' && code === 128)).toBe(true);
    expect(branch.failed).toBe(8);
    events.length = 0;
    const checkout = await client.folderBatch(folder, { kind: 'checkout', name: 'nope' }, []);
    const tried = logged(events);
    expect(tried.length).toBeGreaterThan(0);
    expect(tried.every((r) => r.record.status === 128)).toBe(true);
    expect(tried[0]?.record.stderrTail).toBe('fatal: invalid reference: nope');
    expect(checkout.failed).toBe(tried.length + 1); // + 요약에 실패한 infra-scripts
  });

  it('대상이 없으면 코어처럼 거부하고 기록도 없다', async () => {
    const { client, folder, events } = await folderScene();
    const error = await client
      .folderBatch(folder, { kind: 'fetch', prune: false }, ['/elsewhere/x'])
      .catch((e: unknown) => toIpcError(e));
    expect(error).toMatchObject({ kind: 'internal' });
    expect(logged(events)).toEqual([]);
  });
});

describe('folder 장면의 stage·commit·충돌 흐름도 기록을 남긴다 (W19 ②)', () => {
  it('폴더 stage 는 그 저장소에 add 한 줄, 그 저장소를 연 세션에는 같은 번호의 commandLogged', async () => {
    const { client, folder, repo, events } = await folderScene();
    const web = repo('web-console');
    const sessionEvents: SessionEvent[] = [];
    await client.folderOpenRepoSession(folder, web, (e) => sessionEvents.push(e));
    const test = 'apps/console/src/pages/orders/filters/__tests__/DateRangeFilter.test.tsx';
    await client.folderStage(folder, web, { kind: 'paths', paths: [test] });
    const rows = logged(events);
    expect(brief(rows)).toEqual([['web-console', `add -A -- ${test}`, 0]]);
    const own = sessionEvents.flatMap((e) => (e.type === 'commandLogged' ? [e.record] : []));
    expect(own.map((r) => r.id)).toEqual([rows[0]?.record.id]);
    // 쓰지 않은 호출(빈 대상)은 기록이 없다
    await client.folderUnstage(folder, web, { kind: 'paths', paths: [] });
    expect(logged(events)).toHaveLength(1);
  });

  it('일괄 commit 은 커밋한 저장소마다 commit, 전부 stage 면 그 앞에 add -A', async () => {
    const { client, folder, repo, events } = await folderScene();
    await client.folderCommit(
      folder,
      [repo('auth-service'), repo('web-console')],
      'feat: x',
      false,
    );
    expect(brief(logged(events))).toEqual([
      ['auth-service', 'commit -q -F -', 0],
      ['web-console', 'commit -q -F -', 0],
    ]);
    events.length = 0;
    await client.folderCommit(folder, [repo('design-system-hotfix')], 'fix: y', true);
    expect(brief(logged(events))).toEqual([
      ['design-system', 'add -A', 0],
      ['design-system', 'commit -q -F -', 0],
    ]);
  });

  it('충돌 해결·Continue·Abort 는 그 저장소의 명령을 남긴다 (검사에서 거부되면 남기지 않는다)', async () => {
    const client: IpcClient = createMockClient({
      rows: 200,
      scene: 'folder',
      progressIntervalMs: 0,
      folderOps: 1,
    });
    const [path = ''] = await client.takeStartupPaths();
    const events: SessionEvent[] = [];
    const { session: folder } = await client.openFolder(path, (e) => events.push(e));
    const catalog = `${path}/catalog-service`;
    const { session } = await client.folderOpenRepoSession(folder, catalog, () => {});
    // 충돌이 남은 채 계속하면 git 을 돌리기 전에 거부된다
    await expect(client.opContinue(session, false)).rejects.toThrow();
    expect(logged(events)).toEqual([]);
    await client.resolveSide(session, 'src/search/facets/FacetBuilder.kt', 'theirs');
    await client.opContinue(session, false);
    expect(brief(logged(events))).toEqual([
      ['catalog-service', 'checkout --theirs -- src/search/facets/FacetBuilder.kt', 0],
      ['catalog-service', 'add -- src/search/facets/FacetBuilder.kt', 0],
      ['catalog-service', 'rebase --continue', 0],
    ]);
    // 조절값으로 더한 billing-service(merge)를 중단
    events.length = 0;
    const billing = `${path}/billing-service`;
    const { session: merge } = await client.folderOpenRepoSession(folder, billing, () => {});
    await client.opAbort(merge);
    expect(brief(logged(events))).toEqual([['billing-service', 'merge --abort', 0]]);
  });
});

describe('repo 장면의 branch 업데이트 (BR-09, 저장소 탭)', () => {
  /** 저장소 장면을 연다 */
  async function repoScene() {
    const client: IpcClient = createMockClient({ rows: 400, scene: 'repo', progressIntervalMs: 0 });
    const [path] = await client.takeStartupPaths();
    const events: SessionEvent[] = [];
    const { session } = await client.openRepo(path ?? '', (e) => events.push(e));
    events.length = 0;
    const label = async (name: string) =>
      (await client.repoState(session)).refs.labels.find(
        (l) => l.fullName === `refs/heads/${name}`,
      );
    return { client, session, events, label };
  }

  it('checkout 안 한 뒤처진 branch 는 업스트림 커밋으로 옮기고 ↓ 0, 다시 하면 이미 최신', async () => {
    const { client, session, events, label } = await repoScene();
    const upstream = (await client.repoState(session)).refs.labels.find(
      (l) => l.fullName === 'refs/remotes/origin/development',
    );
    expect((await label('development'))?.behind).toBe(12);
    const r = await client.updateBranch(session, 'development');
    expect(r).toMatchObject({ kind: 'updated', commits: 12, to: upstream?.target });
    expect(await label('development')).toMatchObject({ behind: 0, target: upstream?.target });
    expect(events.map((e) => e.type)).toContain('refsChanged');
    const lines = events.flatMap((e) => (e.type === 'commandLogged' ? [e.record.args[0]] : []));
    expect(lines).toEqual(['fetch', 'branch']);
    expect(await client.updateBranch(session, 'development')).toEqual({ kind: 'upToDate' });
  });

  it('앞섬·갈라짐은 옮기지 않고, 업스트림 없음·다른 워크트리는 오류다', async () => {
    const { client, session } = await repoScene();
    expect(await client.updateBranch(session, 'feature/checkout-redesign')).toEqual({
      kind: 'diverged',
      ahead: 3,
      behind: 1,
    });
    const fail = (name: string) =>
      client.updateBranch(session, name).catch((e: unknown) => toIpcError(e));
    expect(await fail('feature/search-filters')).toMatchObject({
      kind: 'internal',
      message: '업스트림 없음',
    });
    expect(await fail('hotfix/payment-timeout')).toMatchObject({ kind: 'internal' });
    expect(await fail('nope')).toMatchObject({ kind: 'internal', message: 'branch 없음' });
  });
});
