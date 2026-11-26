import { beforeEach, describe, expect, it } from 'vitest';
import { type IpcClient, toIpcError } from '../client';
import { createMockClient } from '../mock/mock-client';
import { applyMockIndexWrite, commitMockStaged } from '../mock/mock-workspace';
import type { FileState, SessionEvent, StatusEntry } from '../types';

/** 상태 항목 하나 (두 쪽 상태와 옛 경로·충돌) */
function entry(
  path: string,
  index: FileState,
  worktree: FileState,
  extra: { origPath?: string; conflict?: boolean } = {},
): StatusEntry {
  return {
    path,
    origPath: extra.origPath ?? null,
    index,
    worktree,
    submodule: null,
    conflict: extra.conflict ? 'bothModified' : null,
    renameScore: extra.origPath ? 90 : null,
  };
}

/** (경로, index, 작업 트리) 로 줄인다 */
function brief(entries: readonly StatusEntry[]): [string, FileState, FileState][] {
  return entries.map((e) => [e.path, e.index, e.worktree]);
}

describe('목 index 규칙 (W14, 코어 folder_stage·folder_unstage 흉내)', () => {
  const sample: StatusEntry[] = [
    entry('src/a.ts', 'unmodified', 'modified'),
    entry('src/b.ts', 'modified', 'modified'),
    entry('src/gone.ts', 'unmodified', 'deleted'),
    entry('src/new.ts', 'untracked', 'untracked'),
    entry('src/c.ts', 'unmerged', 'unmerged', { conflict: true }),
    entry('top.md', 'added', 'unmodified'),
    entry('docs/New.md', 'renamed', 'unmodified', { origPath: 'docs/Old.md' }),
  ];

  it('stage: 디렉터리는 그 아래 전부, untracked 는 추가됨, 삭제는 stage 된 삭제. 충돌은 그대로이고 알린다', () => {
    const { entries, result } = applyMockIndexWrite(sample, 'stage', {
      kind: 'paths',
      paths: ['src'],
    });
    expect(result).toEqual({ ran: true, skipped: [{ path: 'src/c.ts', reason: 'unmerged' }] });
    expect(brief(entries)).toEqual([
      ['src/a.ts', 'modified', 'unmodified'],
      ['src/b.ts', 'modified', 'unmodified'],
      ['src/gone.ts', 'deleted', 'unmodified'],
      ['src/new.ts', 'added', 'unmodified'],
      ['src/c.ts', 'unmerged', 'unmerged'],
      ['top.md', 'added', 'unmodified'],
      ['docs/New.md', 'renamed', 'unmodified'],
    ]);
  });

  it('경로는 글자 그대로다: `src` 가 `src2/x` 를, `s` 가 `src/a.ts` 를 덮지 않는다', () => {
    const extra = [...sample, entry('src2/x.ts', 'untracked', 'untracked')];
    const { entries } = applyMockIndexWrite(extra, 'stage', { kind: 'paths', paths: ['src'] });
    expect(entries.find((e) => e.path === 'src2/x.ts')?.index).toBe('untracked');
    const none = applyMockIndexWrite(sample, 'stage', { kind: 'paths', paths: ['s'] });
    expect(none.entries).toEqual(sample);
  });

  it('unstage 전부: stage 된 변경이 작업 트리 쪽으로 돌아가고, rename 은 옛 경로의 삭제 + untracked 새 경로가 된다', () => {
    const { entries, result } = applyMockIndexWrite(sample, 'unstage', { kind: 'all' });
    expect(result.skipped).toEqual([{ path: 'src/c.ts', reason: 'unmerged' }]);
    expect(brief(entries)).toEqual([
      ['src/a.ts', 'unmodified', 'modified'],
      ['src/b.ts', 'unmodified', 'modified'],
      ['src/gone.ts', 'unmodified', 'deleted'],
      ['src/new.ts', 'untracked', 'untracked'],
      ['src/c.ts', 'unmerged', 'unmerged'],
      ['top.md', 'untracked', 'untracked'],
      ['docs/Old.md', 'unmodified', 'deleted'],
      ['docs/New.md', 'untracked', 'untracked'],
    ]);
  });

  it('rename 의 새 경로만 unstage 하면 옛 경로의 삭제는 stage 된 채 남는다 (코어·세션과 같다)', () => {
    const { entries } = applyMockIndexWrite(sample, 'unstage', {
      kind: 'paths',
      paths: ['docs/New.md'],
    });
    expect(brief(entries.filter((e) => e.path.startsWith('docs/')))).toEqual([
      ['docs/Old.md', 'deleted', 'unmodified'],
      ['docs/New.md', 'untracked', 'untracked'],
    ]);
  });

  it('충돌 파일만 가리키면 쓰지 않고(ran 거짓) 알리기만 한다. 빈 경로 목록은 아무것도 하지 않는다', () => {
    for (const op of ['stage', 'unstage'] as const) {
      expect(
        applyMockIndexWrite(sample, op, { kind: 'paths', paths: ['src/c.ts'] }).result,
      ).toEqual({ ran: false, skipped: [{ path: 'src/c.ts', reason: 'unmerged' }] });
      expect(applyMockIndexWrite(sample, op, { kind: 'paths', paths: [] })).toEqual({
        entries: sample,
        result: { ran: false, skipped: [] },
      });
    }
  });

  it('이미 그 상태면 쓰기는 돌지만(ran) 항목은 그대로다', () => {
    const { entries, result } = applyMockIndexWrite(sample, 'stage', {
      kind: 'paths',
      paths: ['top.md'],
    });
    expect(result).toEqual({ ran: true, skipped: [] });
    expect(entries).toEqual(sample);
  });

  it('커밋하면 stage 된 쪽만 빠지고 작업 트리 쪽 변경·untracked·충돌은 남는다', () => {
    expect(brief(commitMockStaged(sample))).toEqual([
      ['src/a.ts', 'unmodified', 'modified'],
      ['src/b.ts', 'unmodified', 'modified'],
      ['src/gone.ts', 'unmodified', 'deleted'],
      ['src/new.ts', 'untracked', 'untracked'],
      ['src/c.ts', 'unmerged', 'unmerged'],
    ]);
  });
});

describe('folder 장면의 stage·unstage·일괄 commit (W14, WS-23)', () => {
  /** 폴더 장면을 열고 저장소 경로·폴더 이벤트를 준다 */
  async function folderScene() {
    const client: IpcClient = createMockClient({
      rows: 400,
      scene: 'folder',
      progressIntervalMs: 0,
    });
    const [path = ''] = await client.takeStartupPaths();
    const events: SessionEvent[] = [];
    const { session } = await client.openFolder(path, (e) => events.push(e));
    const repo = (name: string) => `${path}/${name}`;
    return { client, folder: session, repo, events };
  }

  /** 받은 `folderChanged` 를 (저장소, refs) 로 */
  function changed(events: readonly SessionEvent[]) {
    return events.flatMap((e) => (e.type === 'folderChanged' ? [[e.repo, e.refs]] : []));
  }

  beforeEach(() => {
    const g = globalThis as { __mgitMockCalls?: unknown; __mgitMockBatches?: unknown };
    g.__mgitMockCalls = {};
    g.__mgitMockBatches = [];
  });

  it('stage 하면 변경 표·요약의 수가 따라가고 그 저장소의 folderChanged(refs 거짓)가 온다. 호출이 남는다', async () => {
    const { client, folder, repo, events } = await folderScene();
    const web = repo('web-console');
    const test = 'apps/console/src/pages/orders/filters/__tests__/DateRangeFilter.test.tsx';
    const [before] = await client.folderChanges(folder, [web]);
    const result = await client.folderStage(folder, web, { kind: 'paths', paths: [test] });
    expect(result).toEqual({ ran: true, skipped: [] });
    const [after] = await client.folderChanges(folder, [web]);
    expect(after?.entries.find((e) => e.path === test)).toMatchObject({
      index: 'added',
      worktree: 'unmodified',
    });
    expect(after?.summary.staged).toBe((before?.summary.staged ?? 0) + 1);
    expect(after?.summary.untracked).toBe((before?.summary.untracked ?? 0) - 1);
    const [summary] = await client.folderSummaries(folder, [web]);
    const s = after?.summary;
    expect(summary?.changed).toBe(
      (s?.staged ?? 0) + (s?.unstaged ?? 0) + (s?.untracked ?? 0) + (s?.conflicted ?? 0),
    );
    expect(changed(events)).toEqual([[web, false]]);
    // 앞서 돌려준 응답은 바뀌지 않는다 (새 객체로 바꾼다)
    expect(before?.entries.find((e) => e.path === test)?.index).toBe('untracked');
    const g = globalThis as {
      __mgitMockCalls?: Record<string, number>;
      __mgitMockBatches?: unknown[];
    };
    expect(g.__mgitMockCalls?.folderStage).toBe(1);
    expect(g.__mgitMockBatches).toEqual([
      { method: 'folderStage', repo: web, target: { kind: 'paths', paths: [test] } },
    ]);
  });

  it('전부 unstage 하면 stage 된 변경이 없어지고, 깨끗해진 저장소는 변경 보기에서 빠진다', async () => {
    const { client, folder, repo } = await folderScene();
    const auth = repo('auth-service');
    await client.folderUnstage(folder, auth, { kind: 'all' });
    const [after] = await client.folderChanges(folder, [auth]);
    expect(after?.summary.staged).toBe(0);
    // 작업 트리만 바뀐 워크트리 저장소를 stage 한 뒤 되돌린다
    const hotfix = repo('design-system-hotfix');
    await client.folderStage(folder, hotfix, { kind: 'all' });
    expect((await client.folderChanges(folder, [hotfix]))[0]?.summary).toMatchObject({
      staged: 2,
      unstaged: 0,
    });
    await client.folderUnstage(folder, hotfix, { kind: 'paths', paths: ['tokens'] });
    expect((await client.folderChanges(folder, [hotfix]))[0]?.summary).toMatchObject({
      staged: 1,
      unstaged: 1,
    });
  });

  it('충돌이 있는 저장소: 충돌 파일은 그대로이고 결과로 알린다. 충돌뿐이면 이벤트도 없다', async () => {
    const { client, folder, repo, events } = await folderScene();
    const catalog = repo('catalog-service');
    const conflict = 'src/search/facets/FacetBuilder.kt';
    const only = await client.folderStage(folder, catalog, { kind: 'paths', paths: [conflict] });
    expect(only).toEqual({ ran: false, skipped: [{ path: conflict, reason: 'unmerged' }] });
    expect(changed(events)).toEqual([]);
    const dir = await client.folderUnstage(folder, catalog, {
      kind: 'paths',
      paths: ['src/search'],
    });
    expect(dir).toEqual({ ran: true, skipped: [{ path: conflict, reason: 'unmerged' }] });
    const [after] = await client.folderChanges(folder, [catalog]);
    expect(after?.summary).toMatchObject({ staged: 0, unstaged: 2, conflicted: 1 });
    expect(after?.entries.find((e) => e.path === conflict)?.conflict).toBe('bothModified');
  });

  it('코어처럼 거부한다: 목록 밖 저장소·작업 트리 밖 경로·루트 자체(git 전), 상태를 못 읽는 저장소. 빈 경로 목록은 아무것도 하지 않는다', async () => {
    const { client, folder, repo, events } = await folderScene();
    const kind = async (p: Promise<unknown>) => toIpcError(await p.catch((e: unknown) => e)).kind;
    expect(await kind(client.folderStage(folder, '/elsewhere/x', { kind: 'all' }))).toBe(
      'internal',
    );
    for (const bad of ['../x', '/abs', '.', '']) {
      expect(
        await kind(
          client.folderStage(folder, repo('web-console'), { kind: 'paths', paths: [bad] }),
        ),
      ).toBe('internal');
    }
    expect(await kind(client.folderUnstage(folder, repo('infra-scripts'), { kind: 'all' }))).toBe(
      'internal',
    );
    expect(await kind(client.folderStage(999, repo('web-console'), { kind: 'all' }))).toBe(
      'sessionNotFound',
    );
    expect(
      await client.folderStage(folder, repo('web-console'), { kind: 'paths', paths: [] }),
    ).toEqual({ ran: false, skipped: [] });
    expect(events).toEqual([]);
  });

  it('그 저장소를 연 세션도 같은 표를 본다: 열린 세션은 statusChanged 로, 나중에 연 세션은 지금 상태로', async () => {
    const { client, folder, repo } = await folderScene();
    const auth = repo('auth-service');
    const sessionEvents: SessionEvent[] = [];
    const opened = await client.folderOpenRepoSession(folder, auth, (e) => sessionEvents.push(e));
    await client.folderStage(folder, auth, { kind: 'all' });
    const [changes] = await client.folderChanges(folder, [auth]);
    const status = sessionEvents.find((e) => e.type === 'statusChanged');
    expect(status?.type === 'statusChanged' ? status.status.entries : null).toEqual(
      changes?.entries,
    );
    expect((await client.repoState(opened.session)).status.entries).toEqual(changes?.entries);
    // 아직 열지 않은 저장소를 stage 한 뒤 열면 그 상태로 열린다
    const web = repo('web-console');
    await client.folderStage(folder, web, { kind: 'all' });
    const later = await client.folderOpenRepoSession(folder, web, () => {});
    const [webChanges] = await client.folderChanges(folder, [web]);
    expect(later.state.status.entries).toEqual(webChanges?.entries);
    expect(later.state.status.summary.untracked).toBe(0);
  });

  it('일괄 commit(stage 된 것만): 커밋한 저장소는 stage 된 변경이 빠지고 ahead 가 오른다. 건너뛰는 사유는 코어와 같다', async () => {
    const { client, folder, repo, events } = await folderScene();
    const auth = repo('auth-service');
    const sessionEvents: SessionEvent[] = [];
    await client.folderOpenRepoSession(folder, auth, (e) => sessionEvents.push(e));
    const result = await client.folderCommit(folder, [], '로그인 제한', false);
    const outcome = Object.fromEntries(
      result.results.map((r) => [r.name, r.skipped ?? (r.ok ? 'ok' : 'failed')]),
    );
    expect(outcome).toEqual({
      'api-gateway': 'stage 된 변경 없음',
      'auth-service': 'ok',
      'billing-service': 'stage 된 변경 없음',
      'catalog-service': '진행 중인 작업이 있음',
      'design-system': 'stage 된 변경 없음',
      'design-system-hotfix': 'stage 된 변경 없음',
      'infra-scripts': '진행 중인 작업이 있음',
      'web-console': 'ok',
    });
    expect(result).toMatchObject({ label: '일괄 commit', succeeded: 2, skipped: 6, failed: 0 });
    const [authChanges] = await client.folderChanges(folder, [auth]);
    expect(authChanges?.summary).toMatchObject({ staged: 0, unstaged: 2, untracked: 1, ahead: 4 });
    const [authSummary] = await client.folderSummaries(folder, [auth]);
    expect(authSummary?.ahead).toBe(4);
    const branches = await client.folderBranches(folder, [auth]);
    const current = branches.branches
      .flatMap((b) => b.repos)
      .find((r) => r.path === auth && r.current);
    expect(current?.ahead).toBe(4);
    // 대상 저장소마다 refs 가 바뀐 folderChanged, 열린 세션에는 statusChanged(ahead 포함)
    expect(changed(events)).toHaveLength(8);
    expect(changed(events).every(([, refs]) => refs)).toBe(true);
    const status = sessionEvents.find((e) => e.type === 'statusChanged');
    expect(status?.type === 'statusChanged' ? status.status.summary.ahead : null).toBe(4);
    // 메시지가 비면 거부, 저장소를 고르면 그 저장소만
    expect(
      toIpcError(await client.folderCommit(folder, [], '  ', false).catch((e) => e)).kind,
    ).toBe('internal');
    const again = await client.folderCommit(folder, [repo('web-console')], 'again', true);
    expect(again.results.map((r) => [r.name, r.skipped])).toEqual([['web-console', null]]);
    expect(await client.folderChanges(folder, [repo('web-console')])).toEqual([]);
    const g = globalThis as { __mgitMockCalls?: Record<string, number> };
    expect(g.__mgitMockCalls?.folderCommit).toBe(3);
  });

  it('저장소별 메시지: 공통 메시지가 비어도 대상 모두에 자기 메시지가 있으면 커밋하고, 하나라도 없으면 아무것도 바꾸지 않고 거부한다', async () => {
    const { client, folder, repo } = await folderScene();
    const auth = repo('auth-service');
    const web = repo('web-console');
    const own = [{ path: auth, message: 'docs: auth' }];
    // web 은 자기 메시지가 없고 공통 메시지가 비었다 → 거부, stage 된 것은 그대로
    expect(
      toIpcError(await client.folderCommit(folder, [auth, web], ' ', false, own).catch((e) => e))
        .kind,
    ).toBe('internal');
    const [authBefore] = await client.folderChanges(folder, [auth]);
    expect(authBefore?.summary.staged).toBeGreaterThan(0);
    // 공백뿐인 자기 메시지는 공통 메시지로 본다 → 공통 메시지가 있으면 커밋된다
    const result = await client.folderCommit(folder, [auth, web], 'feat: 공통', false, [
      ...own,
      { path: web, message: '  ' },
    ]);
    expect(result.succeeded).toBe(2);
    const g = globalThis as { __mgitMockBatches?: unknown[] };
    expect(g.__mgitMockBatches?.at(-1)).toMatchObject({
      method: 'folderCommit',
      message: 'feat: 공통',
      repoMessages: [own[0], { path: web, message: '  ' }],
    });
  });
});
