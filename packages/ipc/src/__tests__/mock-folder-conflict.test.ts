import { beforeEach, describe, expect, it } from 'vitest';
import { type IpcClient, toIpcError } from '../client';
import { createMockClient } from '../mock/mock-client';
import {
  abandonMockOp,
  hasMockConflictMarkers,
  resolveMockConflict,
  unresolveMockConflict,
} from '../mock/mock-workspace';
import type { FileState, SessionEvent, StatusEntry } from '../types';

const CONFLICT = 'src/search/facets/FacetBuilder.kt';

/** 상태 항목 하나 */
function entry(
  path: string,
  index: FileState,
  worktree: FileState,
  conflict: StatusEntry['conflict'] = null,
): StatusEntry {
  return { path, origPath: null, index, worktree, submodule: null, conflict, renameScore: null };
}

/** (경로, index, 작업 트리, 충돌) 로 줄인다 */
const brief = (entries: readonly StatusEntry[]) =>
  entries.map((e) => [e.path, e.index, e.worktree, e.conflict ?? null]);

/** 오류의 종류와 문구 */
async function failure(p: Promise<unknown>) {
  const e = toIpcError(await p.then(() => null).catch((err: unknown) => err));
  return { kind: e.kind, message: e.kind === 'internal' ? e.message : null };
}

describe('목 충돌 해결 규칙 (W15, 코어 resolve_*·unresolve 흉내)', () => {
  const sample = [
    entry('a.kt', 'unmerged', 'unmerged', 'bothModified'),
    entry('b.md', 'unmerged', 'deleted', 'deletedByThem'),
    entry('c.kt', 'unmerged', 'unmerged', 'bothAdded'),
    entry('d.kt', 'modified', 'unmodified'),
    entry('new.txt', 'untracked', 'untracked'),
  ];

  it('남기면 결과가 stage 된다 (추가 충돌은 added). 지우면 삭제가 stage 되고 추가 충돌은 항목이 없어진다', () => {
    expect(brief(resolveMockConflict(sample, 'a.kt') ?? [])[0]).toEqual([
      'a.kt',
      'modified',
      'unmodified',
      null,
    ]);
    expect(brief(resolveMockConflict(sample, 'c.kt') ?? [])[2]).toEqual([
      'c.kt',
      'added',
      'unmodified',
      null,
    ]);
    expect(brief(resolveMockConflict(sample, 'b.md', false) ?? [])[1]).toEqual([
      'b.md',
      'deleted',
      'unmodified',
      null,
    ]);
    expect(resolveMockConflict(sample, 'c.kt', false)?.some((e) => e.path === 'c.kt')).toBe(false);
    // 충돌 항목이 아니면 null
    expect(resolveMockConflict(sample, 'd.kt')).toBeNull();
  });

  it('되돌리기는 원래 충돌 항목으로 (지워졌으면 다시 넣는다), 중단은 untracked 만 남긴다', () => {
    const removed = resolveMockConflict(sample, 'c.kt', false) ?? [];
    const back = unresolveMockConflict(removed, sample[2] as StatusEntry);
    expect(back.find((e) => e.path === 'c.kt')?.conflict).toBe('bothAdded');
    expect(brief(abandonMockOp(sample))).toEqual([['new.txt', 'untracked', 'untracked', null]]);
  });

  it('충돌 마커는 줄 맨 앞의 <<<<<<< 만 센다', () => {
    expect(hasMockConflictMarkers('a\n<<<<<<< HEAD\nb')).toBe(true);
    expect(hasMockConflictMarkers('x <<<<<<< y')).toBe(false);
  });
});

describe('folder 장면 세션의 충돌 흐름 (W15, WS-23)', () => {
  /** 폴더 장면을 열고 catalog-service(rebase 중 충돌)의 가벼운 세션을 연다 */
  async function scene(folderOps?: number) {
    const client: IpcClient = createMockClient({
      rows: 200,
      scene: 'folder',
      progressIntervalMs: 0,
      ...(folderOps === undefined ? {} : { folderOps }),
    });
    const [path = ''] = await client.takeStartupPaths();
    const folderEvents: SessionEvent[] = [];
    const { session: folder } = await client.openFolder(path, (e) => folderEvents.push(e));
    const repo = (name: string) => `${path}/${name}`;
    const sessionEvents: SessionEvent[] = [];
    const open = async (name: string) =>
      (await client.folderOpenRepoSession(folder, repo(name), (e) => sessionEvents.push(e)))
        .session;
    return { client, folder, repo, folderEvents, sessionEvents, open };
  }

  /** 그 저장소의 요약·변경 */
  async function stateOf(client: IpcClient, folder: number, repo: string) {
    const [summary] = await client.folderSummaries(folder, [repo]);
    const [changes] = await client.folderChanges(folder, [repo]);
    return { summary, entries: changes?.entries ?? [] };
  }

  /** 받은 `folderChanged` 를 (저장소, refs) 로 */
  const changed = (events: readonly SessionEvent[]) =>
    events.flatMap((e) => (e.type === 'folderChanged' ? [[e.repo, e.refs]] : []));

  /** 받은 마지막 `statusChanged` 의 충돌 수와 작업 종류 */
  const lastStatus = (events: readonly SessionEvent[]) => {
    const last = events.filter((e) => e.type === 'statusChanged').at(-1);
    return last?.type === 'statusChanged'
      ? { conflicted: last.status.summary.conflicted, op: last.op?.kind ?? null }
      : null;
  };

  beforeEach(() => {
    const g = globalThis as { __mgitMockCalls?: unknown; __mgitMockBatches?: unknown };
    g.__mgitMockCalls = {};
    g.__mgitMockBatches = [];
  });

  it('충돌 파일을 저장하면 해결됨(stage)으로 바뀌고 충돌 수가 준다. 세션 statusChanged(작업은 그대로)·folderChanged 를 낸다', async () => {
    const { client, folder, repo, folderEvents, sessionEvents, open } = await scene();
    const catalog = repo('catalog-service');
    const session = await open('catalog-service');
    expect((await stateOf(client, folder, catalog)).summary?.conflicted).toBe(1);
    await client.resolveFile(session, CONFLICT, 'merged\n', false);
    const after = await stateOf(client, folder, catalog);
    expect(after.summary).toMatchObject({ conflicted: 0, op: 'rebase' });
    expect(after.entries.find((e) => e.path === CONFLICT)).toMatchObject({
      index: 'modified',
      worktree: 'unmodified',
      conflict: null,
    });
    expect(lastStatus(sessionEvents)).toEqual({ conflicted: 0, op: 'rebase' });
    expect(changed(folderEvents)).toEqual([[catalog, false]]);
    const g = globalThis as { __mgitMockBatches?: unknown[] };
    expect(g.__mgitMockBatches).toEqual([
      { method: 'resolveFile', session, path: CONFLICT, allowConflictMarkers: false },
    ]);
  });

  it('충돌이 남았으면 계속은 코어와 같은 오류다. 다 해결하면 작업이 끝나고(요약·세션의 작업이 없다) stage 된 변경이 커밋된다', async () => {
    const { client, folder, repo, folderEvents, sessionEvents, open } = await scene();
    const catalog = repo('catalog-service');
    const session = await open('catalog-service');
    expect(await failure(client.opContinue(session, false))).toEqual({
      kind: 'internal',
      message: '해결하지 않은 충돌 파일이 남아 있습니다',
    });
    expect((await stateOf(client, folder, catalog)).summary?.op).toBe('rebase');
    await client.resolveSide(session, CONFLICT, 'ours');
    expect(await client.opContinue(session, false)).toBe('clean');
    const after = await stateOf(client, folder, catalog);
    expect(after.summary).toMatchObject({ op: null, conflicted: 0, changed: 0 });
    expect(after.entries).toEqual([]);
    expect(lastStatus(sessionEvents)).toEqual({ conflicted: 0, op: null });
    expect(changed(folderEvents).at(-1)).toEqual([catalog, true]);
    // 끝난 뒤 새로 연 세션도 작업 없이 열린다
    const later = await client.folderOpenRepoSession(folder, catalog, () => {});
    expect((await client.repoState(later.session)).op ?? null).toBeNull();
  });

  it('마커를 남긴 채 저장하려면 허용이 필요하고, 그렇게 저장한 뒤의 계속은 마커 오류(conflictMarkers)를 낸다', async () => {
    const { client, open } = await scene();
    const session = await open('catalog-service');
    const marked = '<<<<<<< ours\na\n=======\nb\n>>>>>>> theirs\n';
    expect((await failure(client.resolveFile(session, CONFLICT, marked, false))).kind).toBe(
      'conflictMarkers',
    );
    await client.resolveFile(session, CONFLICT, marked, true);
    const err = toIpcError(await client.opContinue(session, false).catch((e: unknown) => e));
    expect(err).toEqual({ kind: 'conflictMarkers', files: [CONFLICT] });
    expect(await client.opContinue(session, true)).toBe('clean');
  });

  it('중단하면 작업이 사라지고 변경이 작업 전으로 돌아간다. 다시 충돌로 되돌리기는 해결한 파일만', async () => {
    const { client, folder, repo, folderEvents, open } = await scene();
    const catalog = repo('catalog-service');
    const session = await open('catalog-service');
    await client.resolveFile(session, CONFLICT, 'x\n', false);
    await client.unresolve(session, CONFLICT, 'remake');
    expect(
      (await stateOf(client, folder, catalog)).entries.find((e) => e.path === CONFLICT)?.conflict,
    ).toBe('bothModified');
    expect((await failure(client.unresolve(session, CONFLICT, 'remake'))).kind).toBe('internal');
    await client.opAbort(session);
    const after = await stateOf(client, folder, catalog);
    expect(after.summary).toMatchObject({ op: null, conflicted: 0 });
    expect(after.entries).toEqual([]);
    expect(changed(folderEvents).at(-1)).toEqual([catalog, true]);
    expect((await failure(client.opAbort(session))).kind).toBe('internal');
  });

  it('조절값으로 진행 중인 저장소를 늘린다: merge 의 삭제 충돌은 남기기/지우기, merge 는 건너뛸 수 없다', async () => {
    const { client, folder, repo, open } = await scene(3);
    const summaries = await client.folderSummaries(folder);
    expect(
      summaries.filter((s) => s.op !== null && s.op !== undefined).map((s) => [s.name, s.op]),
    ).toEqual([
      ['api-gateway', 'revert'],
      ['billing-service', 'merge'],
      ['catalog-service', 'rebase'],
      ['design-system', 'cherryPick'],
    ]);
    const billing = repo('billing-service');
    const session = await open('billing-service');
    expect((await client.repoState(session)).op?.kind).toBe('merge');
    await client.resolveDelete(session, 'docs/billing-limits.md', false);
    expect(
      (await stateOf(client, folder, billing)).entries.find(
        (e) => e.path === 'docs/billing-limits.md',
      ),
    ).toMatchObject({ index: 'deleted', conflict: null });
    expect((await failure(client.opSkip(session))).message).toBe('건너뛸 수 없는 작업입니다');
    // 기본 장면은 그대로다: 진행 중인 저장소는 catalog-service 하나
    const plain = await scene();
    const ops = (await plain.client.folderSummaries(plain.folder)).filter(
      (s) => s.op !== null && s.op !== undefined,
    );
    expect(ops.map((s) => s.name)).toEqual(['catalog-service']);
  });

  it('폴더 장면이 아닌 세션의 충돌 쓰기는 지금처럼 아무것도 바꾸지 않는다 (널 스텁)', async () => {
    const client = createMockClient({ rows: 50, scene: 'conflict', progressIntervalMs: 0 });
    const [path = ''] = await client.takeStartupPaths();
    const { session } = await client.openRepo(path, () => {});
    const before = await client.repoState(session);
    await client.resolveSide(session, 'x', 'ours');
    expect(await client.opContinue(session, false)).toBe('clean');
    await client.opAbort(session);
    expect(await client.repoState(session)).toEqual(before);
    expect(await client.mergeToolName(session)).toBeNull();
  });
});
