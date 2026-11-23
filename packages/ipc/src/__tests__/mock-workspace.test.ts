import { describe, expect, it, vi } from 'vitest';
import { type IpcClient, toIpcError } from '../client';
import { createMockClient, emptyRepoState } from '../mock/mock-client';
import {
  type MockHostingMode,
  type MockScale,
  type MockSceneName,
  mockModules,
  parseMockHosting,
  parseMockScene,
} from '../mock/mock-workspace';
import type { GraphRow, SessionEvent } from '../types';

const ROWS = 400;

/** 장면 클라이언트를 만들고 시작 경로를 꺼낸다 */
async function start(scene: MockSceneName): Promise<{ client: IpcClient; path: string }> {
  const client = createMockClient({ rows: ROWS, scene, progressIntervalMs: 0 });
  const [path] = await client.takeStartupPaths();
  return { client, path: path ?? '' };
}

/** 이벤트를 버린다 */
const ignore = () => {};

describe('parseMockScene', () => {
  it('아는 이름만 장면으로 받는다', () => {
    expect(parseMockScene('folder')).toBe('folder');
    expect(parseMockScene('repo')).toBe('repo');
    expect(parseMockScene('conflict')).toBe('conflict');
    expect(parseMockScene('')).toBeNull();
    expect(parseMockScene(undefined)).toBeNull();
    expect(parseMockScene('Folder')).toBeNull();
  });
});

describe('장면이 없는 목 클라이언트', () => {
  it('시작 경로가 없고 저장소는 변경 없는 main 으로 열린다', async () => {
    for (const client of [
      createMockClient({ rows: ROWS, progressIntervalMs: 0 }),
      createMockClient({ rows: ROWS, progressIntervalMs: 0, scene: null }),
    ]) {
      expect(await client.takeStartupPaths()).toEqual([]);
      const opened = await client.openRepo('/mock/repo-400', ignore);
      const window = await client.graphWindow(opened.session, 0, ROWS);
      const head = window.rows[0]?.oid ?? '';
      expect(opened.alreadyOpen).toBe(false);
      expect(opened.info.workTree).toBe('/mock/repo-400');
      expect(opened.state).toEqual(
        emptyRepoState({ state: 'attached', branch: 'main', oid: head }),
      );
      expect(await client.repoState(opened.session)).toEqual(opened.state);
      // 생성기가 붙인 라벨은 그대로다
      expect(window.rows[0]?.refs.map((l) => l.shortName)).toEqual(['main', 'origin/main']);
      // 같은 경로를 다시 열어도 새 세션이다
      const again = await client.openRepo('/mock/repo-400', ignore);
      expect(again.session).not.toBe(opened.session);
      expect(again.alreadyOpen).toBe(false);
    }
  });

  it('폴더·커밋 상세는 널 스텁 그대로다', async () => {
    const client = createMockClient({ rows: ROWS, progressIntervalMs: 0 });
    const opened = await client.openRepo('/mock/repo-400', ignore);
    expect(await client.openFolder('/mock/any', ignore)).toEqual({
      session: 0,
      path: '/mock/any',
      repos: [],
    });
    expect(await client.folderSummaries(0)).toEqual([]);
    expect(await client.listStashes(opened.session)).toEqual([]);
    await expect(client.commitDetail(opened.session, 'x')).rejects.toThrow();
  });

  it('git 명령 기록은 보내지 않는다', async () => {
    const client = createMockClient({ rows: ROWS, progressIntervalMs: 0 });
    const events: SessionEvent[] = [];
    await client.openRepo('/mock/repo-400', (e) => events.push(e));
    expect(events.some((e) => e.type === 'commandLogged')).toBe(false);
  });

  it('터미널은 탭마다 새 PTY 번호와 안내 한 줄을 준다', async () => {
    const client = createMockClient({ rows: ROWS, progressIntervalMs: 0 });
    const lines: string[] = [];
    const first = await client.ptyOpen('/mock/a', 80, 24, (e) => {
      if (e.kind === 'data') {
        lines.push(e.data);
      }
    });
    const second = await client.ptyOpen('/mock/b', 80, 24, ignore);
    expect(second).not.toBe(first);
    expect(lines).toEqual([`[mock pty ${first}] /mock/a\r\n`]);
    await expect(client.ptyWrite(first, 'ls\n')).resolves.toBeUndefined();
  });

  it('git 버전은 부를 때마다 localStorage 의 mgit.mock.gitVersion 을 보고, 없으면 목 표시가 붙은 기본값이다', async () => {
    const client = createMockClient({ rows: ROWS, progressIntervalMs: 0 });
    expect((await client.gitVersion()).version).toBe('2.54.0 (mock)');
    localStorage.setItem('mgit.mock.gitVersion', '2.47.1');
    try {
      expect((await client.gitVersion()).version).toBe('2.47.1');
    } finally {
      localStorage.removeItem('mgit.mock.gitVersion');
    }
    expect((await client.gitVersion()).version).toBe('2.54.0 (mock)');
  });
});

describe('folder 장면', () => {
  it('폴더 경로를 저장소로 열면 multiRepoFolder 로 거부하고 폴더로는 열린다', async () => {
    const { client, path } = await start('folder');
    expect(path).not.toBe('');
    // 시작 경로는 한 번만 준다
    expect(await client.takeStartupPaths()).toEqual([]);
    const err = toIpcError(await client.openRepo(path, ignore).catch((e: unknown) => e));
    expect(err.kind).toBe('multiRepoFolder');
    const repos = err.kind === 'multiRepoFolder' ? err.repos : [];
    const opened = await client.openFolder(path, ignore);
    expect(opened.path).toBe(path);
    expect(opened.repos.map((r) => r.path)).toEqual(repos);
    expect(opened.repos).toHaveLength(8);
    // 같은 폴더를 다시 열면 같은 세션이다
    expect((await client.openFolder(path, ignore)).session).toBe(opened.session);
    await expect(client.openFolder('/mock/elsewhere', ignore)).rejects.toThrow();
  });

  it('요약에 성격이 다른 저장소가 하나씩 있다', async () => {
    const { client, path } = await start('folder');
    const { session } = await client.openFolder(path, ignore);
    const summaries = await client.folderSummaries(session);
    expect(summaries).toHaveLength(8);
    expect(summaries.some((s) => s.behind === 54)).toBe(true);
    expect(summaries.some((s) => s.branch?.startsWith('feature/'))).toBe(true);
    expect(summaries.some((s) => s.detached && !s.op)).toBe(true);
    expect(summaries.some((s) => s.op === 'rebase' && s.conflicted === 1)).toBe(true);
    expect(summaries.some((s) => s.kind === 'worktree')).toBe(true);
    expect(summaries.some((s) => s.error)).toBe(true);
    expect(await client.folderRescan(session)).toHaveLength(8);
  });

  it('변경 보기는 중첩 경로를 주고 요약의 변경 수와 맞는다', async () => {
    const { client, path } = await start('folder');
    const { session } = await client.openFolder(path, ignore);
    const summaries = await client.folderSummaries(session);
    const changes = await client.folderChanges(session);
    expect(changes.length).toBeGreaterThan(2);
    for (const c of changes) {
      const s = c.summary;
      expect(summaries.find((x) => x.path === c.path)?.changed).toBe(
        s.staged + s.unstaged + s.untracked + s.conflicted,
      );
    }
    const paths = changes.flatMap((c) => c.entries.map((e) => e.path));
    expect(paths.some((p) => p.split('/').length >= 5)).toBe(true);
  });

  it('타임라인은 저장소가 구간으로 섞이고, 여러 저장소에 걸친 브랜치가 있다 (브랜치는 folderBranches 가 준다 — W28)', async () => {
    const { client, path } = await start('folder');
    const { session } = await client.openFolder(path, ignore);
    const info = await client.folderTimelineOpen(session);
    expect(info).toMatchObject({ generation: 1, rows: ROWS, finished: true });
    expect(await client.folderTimelineInfo(session)).toEqual(info);
    const list = await client.folderBranches(session);
    const shared = (name: string, remote: boolean) =>
      list.branches.find((b) => b.name === name && b.remote === remote)?.repos.length ?? 0;
    expect(shared('development', false)).toBeGreaterThan(1);
    expect(shared('staging', false)).toBeGreaterThan(1);
    expect(shared('origin/development', true)).toBeGreaterThan(1);
    expect(list.branches.some((b) => b.repos.some((r) => r.current))).toBe(true);

    const window = await client.folderTimelineWindow(session, 0, ROWS);
    expect(window.rows).toHaveLength(ROWS);
    expect(window.totalRows).toBe(ROWS);
    const repoOf = window.rows.map((r) => r.repo ?? null);
    expect(repoOf.every((r) => r !== null)).toBe(true);
    expect(new Set(repoOf).size).toBeGreaterThan(4);
    // 구간: 저장소가 바뀌는 곳도, 이어지는 곳도 여럿 있다
    const switches = repoOf.filter((r, i) => i > 0 && r !== repoOf[i - 1]).length;
    expect(switches).toBeGreaterThan(20);
    expect(switches).toBeLessThan(ROWS - 20);
    // 모든 행의 레인은 그 행을 덮는 구간이 있다
    for (const row of window.rows) {
      expect(
        window.segments.some(
          (s) => s.lane === row.lane && s.fromRow <= row.row && row.row <= s.toRow,
        ),
      ).toBe(true);
    }
    expect(window.rows.some((r) => r.refs.length > 0)).toBe(true);
    expect(window.rows.some((r) => !r.inHead)).toBe(true);
    const sample = window.rows[37] as GraphRow;
    expect(await client.folderTimelineFindRow(session, sample.repo ?? -1, sample.oid)).toBe(37);
  });

  it('타임라인 질의를 바꾸면 그 ref 가 있는 저장소만 남고 graphReloaded 가 온다', async () => {
    const { client, path } = await start('folder');
    const events: SessionEvent[] = [];
    const { session } = await client.openFolder(path, (e) => events.push(e));
    const info = await client.folderTimelineOpen(session);
    const all = await client.folderTimelineWindow(session, 0, ROWS);
    // staging 이 있는 저장소의 순번 (브랜치 목록은 경로로 준다)
    const stagingPaths = (await client.folderBranches(session)).branches
      .find((b) => b.name === 'staging' && !b.remote)
      ?.repos.map((r) => r.path);
    const staging = info.repos.filter((r) => stagingPaths?.includes(r.path)).map((r) => r.index);
    expect(staging.length).toBeGreaterThan(1);
    await client.folderTimelineQuerySet(session, {
      revs: { kind: 'solo', name: 'staging' },
      hideRemotes: false,
      pathScope: [],
      sort: 'date',
      firstParent: false,
      noMerges: false,
    });
    const solo = await client.folderTimelineWindow(session, 0, ROWS);
    expect(events).toEqual([
      { type: 'graphReloaded', session, generation: 2, rows: solo.totalRows, laneCount: 3 },
    ]);
    expect(solo.totalRows).toBeGreaterThan(0);
    expect(solo.totalRows).toBeLessThan(ROWS);
    expect(solo.rows.every((r) => staging.includes(r.repo ?? -1))).toBe(true);
    // 남은 커밋은 전체 타임라인의 그 커밋과 같다
    const first = solo.rows[0] as GraphRow;
    expect(all.rows.find((r) => r.oid === first.oid)?.subject).toBe(first.subject);
  });

  it('브랜치 목록은 타임라인을 열지 않아도 오고, 저장소별 추적 상태와 HEAD 를 준다', async () => {
    const { client, path } = await start('folder');
    const events: SessionEvent[] = [];
    const { session } = await client.openFolder(path, (e) => events.push(e));
    const list = await client.folderBranches(session);
    expect(events).toEqual([]);
    // 워크트리는 원 저장소에 흡수된다
    expect(list.repos).toHaveLength(7);
    expect(list.repos.some((r) => r.head?.state === 'detached')).toBe(true);
    const development = list.branches.find((b) => b.name === 'development' && !b.remote);
    expect(development?.repos.length).toBeGreaterThan(3);
    expect(development?.repos.some((r) => r.current && r.behind === 54)).toBe(true);
    expect(development?.repos.every((r) => r.upstream === 'origin/development')).toBe(true);
    const origin = list.branches.find((b) => b.name === 'origin/development');
    expect(origin).toMatchObject({ remote: true, remoteName: 'origin' });
    expect(origin?.repos.every((r) => !r.current && r.upstream === null)).toBe(true);
    // 현재 브랜치의 ahead·behind 는 요약과 같다
    const summaries = await client.folderSummaries(session);
    for (const s of summaries.filter((x) => x.branch && x.ahead !== null && !x.error)) {
      const own = list.branches
        .find((b) => !b.remote && b.name === s.branch)
        ?.repos.find((r) => r.path === s.path);
      if (own) {
        expect([own.ahead, own.behind]).toEqual([s.ahead, s.behind]);
      }
    }
  });

  it('저장소 색은 요약·브랜치 목록·타임라인·레인이 같고, 워크트리는 원 저장소와 같다 (LF-09)', async () => {
    const { client, path } = await start('folder');
    const { session } = await client.openFolder(path, ignore);
    const summaries = await client.folderSummaries(session);
    const list = await client.folderBranches(session);
    const info = await client.folderTimelineOpen(session);
    const window = await client.folderTimelineWindow(session, 0, ROWS);
    const colorOf = (repoPath: string) => summaries.find((s) => s.path === repoPath)?.color;
    for (const repo of info.repos) {
      expect(colorOf(repo.path)).toBe(repo.color);
      expect(list.repos.find((r) => r.path === repo.path)?.color).toBe(repo.color);
      const lanes = window.rows.filter((r) => r.repo === repo.index).map((r) => r.color);
      expect(lanes.length).toBeGreaterThan(0);
      expect(new Set(lanes)).toEqual(new Set([repo.color]));
    }
    for (const b of list.branches) {
      for (const r of b.repos) {
        expect(r.color).toBe(colorOf(r.path));
      }
    }
    const worktree = summaries.find((s) => s.kind === 'worktree');
    expect(worktree?.color).toBe(summaries.find((s) => s.name === 'design-system')?.color);
    expect(new Set(info.repos.map((r) => r.color)).size).toBe(info.repos.length);
  });

  it('타임라인 행을 고르면 저장소 경로로 커밋 상세·diff 가 나온다 (W7, 저장소 세션 없음)', async () => {
    const { client, path } = await start('folder');
    const { session } = await client.openFolder(path, ignore);
    const info = await client.folderTimelineOpen(session);
    const window = await client.folderTimelineWindow(session, 0, ROWS);
    const pathOf = (row: GraphRow) => info.repos.find((r) => r.index === row.repo)?.path ?? '';
    const kinds = new Set<string>();
    for (const row of window.rows.slice(0, 12)) {
      const detail = await client.folderCommitDetail(session, pathOf(row), row.oid);
      expect(detail.oid).toBe(row.oid);
      expect(detail.row).toBe(row.row);
      expect(detail.parents).toEqual(row.parents);
      expect(detail.refs).toEqual(row.refs);
      expect(detail.authorName).toBe(row.authorName);
      expect(detail.message.startsWith(row.subject)).toBe(true);
      // 중첩 디렉터리의 파일 여러 개, 한 커밋 안에 추가·rename·삭제가 섞인다
      expect(detail.files.length).toBeGreaterThanOrEqual(4);
      expect(detail.files.some((f) => f.path.split('/').length >= 4)).toBe(true);
      const own = new Set(detail.files.map((f) => f.change.kind));
      expect([...own]).toEqual(expect.arrayContaining(['added', 'renamed', 'deleted']));
      expect(detail.files.find((f) => f.change.kind === 'renamed')?.oldPath).toBeTruthy();
      for (const f of detail.files) {
        kinds.add(f.change.kind);
        const diff = await client.folderCommitFileDiff(
          session,
          pathOf(row),
          row.oid,
          f.path,
          f.oldPath ?? null,
          false,
        );
        expect(diff?.hunks).toHaveLength(1);
        expect(diff?.change.kind).toBe(f.change.kind);
        // 코어처럼 이름이 바뀐 파일은 옛 경로를 넘겨야 rename 으로 나온다 (없으면 전체 추가)
        if (f.change.kind === 'renamed') {
          expect(diff?.oldPath).toBe(f.oldPath);
          const alone = await client.folderCommitFileDiff(
            session,
            pathOf(row),
            row.oid,
            f.path,
            null,
            false,
          );
          expect(alone?.change.kind).toBe('added');
        }
      }
    }
    expect(kinds).toEqual(new Set(['modified', 'added', 'renamed', 'deleted']));
    // 부모의 자식 목록에 그 커밋이 있다 (같은 저장소 안)
    const child = window.rows.find((r) => r.parents.length > 0) as GraphRow;
    const parent = await client.folderCommitDetail(session, pathOf(child), child.parents[0] ?? '');
    expect(parent.children).toContain(child.oid);
  });

  it('폴더 커밋 상세는 목록 밖 저장소·다른 저장소의 커밋을 거부하고, 그래프 필드는 타임라인을 따른다', async () => {
    const { client, path } = await start('folder');
    const { session, repos } = await client.openFolder(path, ignore);
    const window = await client.folderTimelineWindow(session, 0, ROWS);
    const info = await client.folderTimelineInfo(session);
    const sample = window.rows[5] as GraphRow;
    const own = info.repos.find((r) => r.index === sample.repo)?.path ?? '';
    const other = info.repos.find((r) => r.index !== sample.repo)?.path ?? '';
    await expect(client.folderCommitDetail(session, `${path}/nope`, sample.oid)).rejects.toThrow();
    await expect(client.folderCommitDetail(session, other, sample.oid)).rejects.toThrow();
    await expect(
      client.folderCommitFileDiff(session, `${path}/nope`, sample.oid, 'x', null, false),
    ).rejects.toThrow();
    // 워크트리 경로는 원 저장소로 읽는다
    const worktree = repos.find((r) => r.kind === 'worktree')?.path ?? '';
    const origin = info.repos.find((r) => worktree.startsWith(`${r.path}-`))?.path ?? '';
    const originRow = window.rows.find(
      (r) => r.repo === info.repos.find((x) => x.path === origin)?.index,
    ) as GraphRow;
    expect(await client.folderCommitDetail(session, worktree, originRow.oid)).toEqual(
      await client.folderCommitDetail(session, origin, originRow.oid),
    );

    // 브랜치 필터로 그 저장소가 빠지면 상세는 그대로 오고 행·자식만 빈다 (라벨은 남는다)
    const missing = (await client.folderBranches(session)).branches.find(
      (b) => !b.remote && !b.repos.some((r) => r.path === own),
    );
    expect(missing).toBeDefined();
    await client.folderTimelineQuerySet(session, {
      revs: { kind: 'solo', name: missing?.name ?? '' },
      hideRemotes: false,
      pathScope: [],
      sort: 'date',
      firstParent: false,
      noMerges: false,
    });
    const filtered = await client.folderCommitDetail(session, own, sample.oid);
    expect(filtered.row).toBeNull();
    expect(filtered.children).toEqual([]);
    expect(filtered.refs).toEqual(sample.refs);
    expect(filtered.files.length).toBeGreaterThanOrEqual(4);
  });

  it('타임라인을 열기 전의 폴더 커밋 상세는 그래프 필드만 비어 있다 (타임라인을 만들지 않는다)', async () => {
    const { client, path } = await start('folder');
    const events: SessionEvent[] = [];
    const { session } = await client.openFolder(path, (e) => events.push(e));
    const scratch = createMockClient({ rows: ROWS, scene: 'folder', progressIntervalMs: 0 });
    const peek = await scratch.openFolder(path, ignore);
    const peekInfo = await scratch.folderTimelineOpen(peek.session);
    const row = (await scratch.folderTimelineWindow(peek.session, 0, 1)).rows[0] as GraphRow;
    const repo = peekInfo.repos.find((r) => r.index === row.repo)?.path ?? '';
    const detail = await client.folderCommitDetail(session, repo, row.oid);
    expect(detail).toMatchObject({ oid: row.oid, row: null, children: [], refs: [] });
    expect(detail.files.length).toBeGreaterThanOrEqual(4);
    expect(events).toEqual([]);
    // 상세를 읽었다고 타임라인이 생기지 않는다: 처음 열면 1세대다
    expect((await client.folderTimelineOpen(session)).generation).toBe(1);
  });

  it('요약·변경·브랜치는 저장소를 주면 그 저장소만 준다 (부분 갱신)', async () => {
    const { client, path } = await start('folder');
    const { session, repos } = await client.openFolder(path, ignore);
    const one = repos.find((r) => r.path.endsWith('/web-console'))?.path ?? '';
    expect((await client.folderSummaries(session, [one])).map((s) => s.path)).toEqual([one]);
    expect((await client.folderChanges(session, [one])).map((c) => c.path)).toEqual([one]);
    const list = await client.folderBranches(session, [one]);
    expect(list.repos.map((r) => r.path)).toEqual([one]);
    expect(list.branches.length).toBeGreaterThan(2);
    expect(list.branches.every((b) => b.repos.every((r) => r.path === one))).toBe(true);
    // 비우면 전부다
    expect(await client.folderSummaries(session, [])).toHaveLength(8);
  });

  it('HEAD 범위는 저장소마다 HEAD 에서 닿는 커밋만 남긴다 (HEAD 위의 커밋이 빠진다)', async () => {
    const { client, path } = await start('folder');
    const events: SessionEvent[] = [];
    const { session } = await client.openFolder(path, (e) => events.push(e));
    await client.folderTimelineOpen(session);
    const all = await client.folderTimelineWindow(session, 0, ROWS);
    await client.folderTimelineQuerySet(session, {
      revs: { kind: 'head' },
      hideRemotes: false,
      pathScope: [],
      sort: 'date',
      firstParent: false,
      noMerges: false,
    });
    const head = await client.folderTimelineWindow(session, 0, ROWS);
    expect(events.at(-1)).toMatchObject({ type: 'graphReloaded', rows: head.totalRows });
    expect(head.totalRows).toBeGreaterThan(0);
    expect(head.totalRows).toBeLessThan(all.totalRows);
    expect(head.rows.every((r) => r.inHead)).toBe(true);
    // 저장소마다 첫 행이 HEAD 이고, 분리 HEAD 저장소도 들어 있다
    const repos = new Set(head.rows.map((r) => r.repo));
    expect(repos.size).toBe(new Set(all.rows.map((r) => r.repo)).size);
    for (const repo of repos) {
      expect(head.rows.find((r) => r.repo === repo)?.isHead).toBe(true);
    }
    // 남은 커밋은 전체 타임라인의 그 커밋과 같고, HEAD 위에 있던 커밋은 없다
    const kept = new Set(head.rows.map((r) => r.oid));
    const dropped = all.rows.filter((r) => !kept.has(r.oid));
    expect(dropped.length).toBe(all.totalRows - head.totalRows);
    expect(dropped.every((r) => !r.inHead)).toBe(true);
    const sample = head.rows[0] as GraphRow;
    expect(all.rows.find((r) => r.oid === sample.oid)?.subject).toBe(sample.subject);
  });

  it('타임라인 지연을 주면 코어처럼 끝나지 않은 정보를 먼저 주고, 그사이에도 브랜치 목록은 온다', async () => {
    vi.useFakeTimers();
    try {
      const client = createMockClient({
        rows: ROWS,
        scene: 'folder',
        progressIntervalMs: 0,
        timelineDelayMs: 300,
      });
      const [path] = await client.takeStartupPaths();
      const events: SessionEvent[] = [];
      const { session } = await client.openFolder(path ?? '', (e) => events.push(e));
      const info = await client.folderTimelineOpen(session);
      expect(info).toMatchObject({ generation: 0, rows: 0, finished: false, repos: [] });
      expect(events).toEqual([{ type: 'graphLoadStarted', session, generation: 1 }]);
      // 로드가 끝나기 전: 브랜치 목록은 이미 답한다
      expect((await client.folderBranches(session)).branches.length).toBeGreaterThan(5);
      // 다시 열어도 로드를 또 시작하지 않는다
      await client.folderTimelineOpen(session);
      await vi.advanceTimersByTimeAsync(299);
      expect(events).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(events.at(-1)).toMatchObject({
        type: 'graphLoadFinished',
        session,
        generation: 1,
        rows: ROWS,
      });
      expect(await client.folderTimelineOpen(session)).toMatchObject({
        finished: true,
        rows: ROWS,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('하위 저장소는 탭으로 열리고 다시 열면 같은 세션이다', async () => {
    const { client, path } = await start('folder');
    const folder = await client.openFolder(path, ignore);
    const child = folder.repos[0]?.path ?? '';
    const opened = await client.openRepo(child, ignore);
    expect(opened.session).not.toBe(folder.session);
    expect(opened.alreadyOpen).toBe(false);
    expect(opened.info.workTree).toBe(child);
    expect(await client.openRepo(child, ignore)).toMatchObject({
      session: opened.session,
      alreadyOpen: true,
    });
  });
});

describe('가벼운 세션 (W13, WS-23)', () => {
  /** 폴더 장면을 열고 저장소 경로를 이름으로 찾는 도구를 준다 */
  async function folderScene() {
    const { client, path } = await start('folder');
    const folder = await client.openFolder(path, ignore);
    const repo = (name: string) => `${path}/${name}`;
    return { client, folder: folder.session, repo };
  }

  it('폴더 저장소를 light 로 열면 상태가 그 저장소의 요약·변경 줄과 같고 그래프 이벤트가 없다', async () => {
    const { client, folder, repo } = await folderScene();
    const events: SessionEvent[] = [];
    const opened = await client.folderOpenRepoSession(folder, repo('web-console'), (e) =>
      events.push(e),
    );
    expect(opened).toMatchObject({ profile: 'light', alreadyOpen: false, promoted: false });
    expect(opened.info.workTree).toBe(repo('web-console'));
    const [summary] = await client.folderSummaries(folder, [repo('web-console')]);
    const [changes] = await client.folderChanges(folder, [repo('web-console')]);
    expect(opened.state.status.entries).toEqual(changes?.entries);
    expect(opened.state.status.branch.head).toBe(summary?.branch);
    expect(opened.state.status.summary.ahead).toBe(summary?.ahead);
    expect(opened.state.status.summary.behind).toBe(summary?.behind);
    expect(opened.state.refs.head).toMatchObject({ state: 'attached', branch: 'staging' });
    // 작업 트리 diff 가 그 변경으로 나온다
    const first = changes?.entries.find((e) => e.worktree === 'modified');
    expect(
      await client.workTreeDiff(opened.session, first?.path ?? '', false, false),
    ).not.toBeNull();
    expect(events.filter((e) => e.type.startsWith('graph'))).toEqual([]);
  });

  it('그래프 메서드는 graphUnavailable 로 거부하고, 상세·히스토리·blame 은 된다', async () => {
    const { client, folder, repo } = await folderScene();
    const { session, state } = await client.folderOpenRepoSession(
      folder,
      repo('auth-service'),
      ignore,
    );
    const graphCalls: (() => Promise<unknown>)[] = [
      () => client.graphWindow(session, 0, 10),
      () => client.findRow(session, 'x'),
      () => client.reloadGraph(session),
      () => client.searchCommits(session, 'x', { subject: true, author: true, hash: true }, 10),
      () =>
        client.setGraphQuery(session, {
          revs: { kind: 'all' },
          hideRemotes: false,
          pathScope: [],
          sort: 'date',
          firstParent: false,
          noMerges: false,
        }),
    ];
    for (const call of graphCalls) {
      // 동기로 던지는 메서드(graphWindow)도 거부로 받는다
      const err = toIpcError(
        await Promise.resolve()
          .then(call)
          .catch((e: unknown) => e),
      );
      expect(err).toEqual({ kind: 'graphUnavailable', session });
    }
    const head = state.refs.head.state === 'attached' ? state.refs.head.oid : '';
    const detail = await client.commitDetail(session, head);
    expect(detail.files.length).toBeGreaterThan(0);

    const path = 'src/main/java/com/acme/auth/login/LoginController.java';
    const history = await client.fileHistory(session, path, 100);
    expect(history.length).toBeGreaterThan(2);
    expect(history.every((h) => h.path === path)).toBe(true);
    const file = await client.fsReadFile(session, path);
    const blame = await client.blame(session, path, null, false);
    expect(file.kind).toBe('text');
    expect(blame.map((l) => l.text).join('\n')).toBe(
      file.kind === 'text' ? file.text.replace(/\n$/, '') : '',
    );
    expect(new Set(blame.map((l) => l.oid)).size).toBeGreaterThan(1);
    expect(blame.every((l) => history.some((h) => h.oid === l.oid))).toBe(true);
  });

  it('rebase 중 충돌이 있는 저장소는 충돌 목록과 3-way 자료가 나온다', async () => {
    const { client, folder, repo } = await folderScene();
    const opened = await client.folderOpenRepoSession(folder, repo('catalog-service'), ignore);
    expect(opened.state.op).toMatchObject({ kind: 'rebase' });
    expect(opened.state.refs.head.state).toBe('detached');
    const conflicts = await client.conflicts(opened.session);
    expect(conflicts.map((c) => c.path)).toEqual(['src/search/facets/FacetBuilder.kt']);
    const payload = await client.conflictFile(opened.session, conflicts[0]?.path ?? '');
    expect(payload.labels).toMatchObject({ ours: 'development', theirs: 'feature/search-facets' });
    expect(payload.doc).not.toBeNull();
  });

  it('워크트리는 자기 작업 트리로 열리고, 같은 저장소를 다시 열면 같은 세션이다', async () => {
    const { client, folder, repo } = await folderScene();
    const wt = await client.folderOpenRepoSession(folder, repo('design-system-hotfix'), ignore);
    const [changes] = await client.folderChanges(folder, [repo('design-system-hotfix')]);
    expect(wt.state.status.entries).toEqual(changes?.entries);
    expect(wt.state.refs.head).toMatchObject({ branch: 'hotfix/token-contrast' });
    const again = await client.folderOpenRepoSession(folder, repo('design-system-hotfix'), ignore);
    expect(again).toMatchObject({ session: wt.session, alreadyOpen: true, profile: 'light' });
  });

  it('목록 밖 경로·요약에 실패한 저장소는 코어처럼 거부한다', async () => {
    const { client, folder, repo } = await folderScene();
    const outside = toIpcError(
      await client
        .folderOpenRepoSession(folder, '/mock/elsewhere', ignore)
        .catch((e: unknown) => e),
    );
    expect(outside.kind).toBe('internal');
    const failed = toIpcError(
      await client
        .folderOpenRepoSession(folder, repo('infra-scripts'), ignore)
        .catch((e: unknown) => e),
    );
    expect(failed).toMatchObject({ kind: 'internal', message: expect.stringContaining('index') });
  });

  it('한 폴더는 3개까지: 4번째는 lightSessionLimit, 하나를 내려놓으면 다시 열린다', async () => {
    const { client, folder, repo } = await folderScene();
    const ids: number[] = [];
    for (const name of ['api-gateway', 'auth-service', 'billing-service']) {
      ids.push((await client.folderOpenRepoSession(folder, repo(name), ignore)).session);
    }
    const err = toIpcError(
      await client
        .folderOpenRepoSession(folder, repo('design-system'), ignore)
        .catch((e: unknown) => e),
    );
    expect(err).toEqual({ kind: 'lightSessionLimit', limit: 3, sessions: ids });
    expect(await client.folderReleaseRepoSession(folder, ids[0] ?? 0)).toEqual({
      released: true,
      profile: null,
    });
    // 닫힌 세션은 sessionNotFound, 다시 해제해도 같은 모양
    expect(toIpcError(await client.repoState(ids[0] ?? 0).catch((e: unknown) => e)).kind).toBe(
      'sessionNotFound',
    );
    expect(await client.folderReleaseRepoSession(folder, ids[0] ?? 0)).toEqual({
      released: false,
      profile: null,
    });
    const fourth = await client.folderOpenRepoSession(folder, repo('design-system'), ignore);
    expect(fourth.profile).toBe('light');
  });

  it('탭으로 열면 같은 id 로 승격된다: 그래프 이벤트는 새 채널로, 상한·폴더 닫기와 무관해진다', async () => {
    const { client, folder, repo } = await folderScene();
    const oldEvents: SessionEvent[] = [];
    const light = await client.folderOpenRepoSession(folder, repo('api-gateway'), (e) =>
      oldEvents.push(e),
    );
    const newEvents: SessionEvent[] = [];
    const tab = await client.openRepo(repo('api-gateway'), (e) => newEvents.push(e));
    expect(tab).toMatchObject({
      session: light.session,
      alreadyOpen: true,
      promoted: true,
      profile: 'full',
    });
    expect(newEvents.some((e) => e.type === 'graphLoadFinished')).toBe(true);
    expect(oldEvents).toEqual([]);
    expect((await client.graphWindow(light.session, 0, 5)).rows.length).toBe(5);
    expect(await client.folderReleaseRepoSession(folder, light.session)).toEqual({
      released: false,
      profile: 'full',
    });
    // 다시 탭으로 열면 승격은 없다. 폴더가 다시 열면 그 탭의 세션을 빌려 준다
    expect((await client.openRepo(repo('api-gateway'), ignore)).promoted).toBe(false);
    expect(await client.folderOpenRepoSession(folder, repo('api-gateway'), ignore)).toMatchObject({
      session: light.session,
      profile: 'full',
    });

    // 폴더를 닫으면 light 세션만 닫히고 승격된 세션은 남는다
    const other = await client.folderOpenRepoSession(folder, repo('auth-service'), ignore);
    await client.closeFolder(folder);
    expect(toIpcError(await client.repoState(other.session).catch((e: unknown) => e)).kind).toBe(
      'sessionNotFound',
    );
    expect((await client.repoState(light.session)).refs.head).toBeTruthy();
  });
});

describe('repo 장면', () => {
  it('세션을 열면 git 명령 기록이 실행 순서대로 이벤트로 온다 (콘솔 탭)', async () => {
    const { client, path } = await start('repo');
    const events: SessionEvent[] = [];
    const opened = await client.openRepo(path, (e) => events.push(e));
    const records = events.flatMap((e) => (e.type === 'commandLogged' ? [e.record] : []));
    expect(records.length).toBeGreaterThan(4);
    expect(events.every((e) => e.session === opened.session)).toBe(true);
    expect(new Set(records.map((r) => r.id)).size).toBe(records.length);
    expect(records.every((r) => r.cwd === path)).toBe(true);
    // 시각은 밀리초이고 뒤에 온 기록일수록 늦다
    const times = records.map((r) => r.startedAt);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times[0]).toBeGreaterThan(1_000_000_000_000);
    // 읽기·쓰기가 섞여 있고 실패한 명령에는 stderr 가 있다
    expect(records.some((r) => r.isWrite)).toBe(true);
    expect(records.some((r) => !r.isWrite)).toBe(true);
    const failed = records.filter((r) => r.status !== 0);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((r) => r.stderrTail.length > 0)).toBe(true);
  });

  it('사이드바 섹션과 작업 트리 변경이 채워진다', async () => {
    const { client, path } = await start('repo');
    const opened = await client.openRepo(path, ignore);
    const { refs, status, op } = opened.state;
    const locals = refs.labels.filter((l) => l.kind.kind === 'localBranch');
    expect(locals.length).toBeGreaterThan(4);
    expect(locals.filter((l) => l.isCurrent).map((l) => l.shortName)).toEqual(['main']);
    expect(locals.some((l) => (l.ahead ?? 0) > 0)).toBe(true);
    expect(locals.some((l) => (l.behind ?? 0) > 0)).toBe(true);
    expect(locals.some((l) => l.upstreamGone)).toBe(true);
    expect(locals.some((l) => !l.upstream)).toBe(true);
    expect(locals.some((l) => l.worktreePath)).toBe(true);
    const remotes = new Set(
      refs.labels.flatMap((l) => (l.kind.kind === 'remoteBranch' ? [l.kind.remote] : [])),
    );
    expect([...remotes].sort()).toEqual(refs.remotes.map((r) => r.name).sort());
    expect(remotes.size).toBe(2);
    expect(refs.labels.filter((l) => l.kind.kind === 'tag').length).toBeGreaterThan(1);
    expect(refs.stashes.length).toBeGreaterThan(1);
    expect(refs.worktrees.length).toBeGreaterThan(1);
    expect(refs.worktrees.filter((w) => w.isMain).map((w) => w.path)).toEqual([path]);
    expect(op ?? null).toBeNull();
    expect(status.summary.staged).toBeGreaterThan(0);
    expect(status.summary.unstaged).toBeGreaterThan(0);
    expect(status.summary.untracked).toBeGreaterThan(0);
    expect(status.summary.conflicted).toBe(0);
    expect(status.summary.stashCount).toBe(refs.stashes.length);
    expect(await client.repoState(opened.session)).toEqual(opened.state);
  });

  it('브랜치 트리 배지·Backups 를 볼 자료가 있다 (W22): 충돌 레이더 ok·conflict, 백업 2개, 폴더 없는 워크트리', async () => {
    const { client, path } = await start('repo');
    const opened = await client.openRepo(path, ignore);
    const locals = opened.state.refs.labels.filter((l) => l.kind.kind === 'localBranch');
    const radar = await client.conflictRadar(opened.session, 12, false);
    // 레이더는 현재 branch 가 아닌 로컬 branch 를 가리킨다 (깨끗한 것 하나, 충돌 나는 것 하나)
    expect(radar.map((r) => [r.reference, r.clean])).toEqual([
      ['development', true],
      ['feature/checkout-redesign', false],
    ]);
    for (const r of radar) {
      expect(locals.find((l) => l.shortName === r.reference)?.isCurrent).toBe(false);
    }
    expect(radar[1]?.conflicts.length).toBeGreaterThan(5);
    // 백업: 현재 branch 의 것(되돌리면 hard reset)과 다른 branch 의 것. 그래프의 커밋을 가리킨다
    const backups = await client.backups(opened.session);
    expect(backups.map((b) => b.branch)).toEqual(['main', 'staging']);
    for (const b of backups) {
      expect(b.name.startsWith(`refs/mgit/backup/${b.branch}/`)).toBe(true);
      expect(await client.findRow(opened.session, b.oid)).not.toBeNull();
    }
    expect(opened.state.refs.worktrees.filter((w) => w.prunable !== null)).toHaveLength(1);
  });

  it('호스팅 (W24): 기본은 GitHub + 계정 연결 + 배지 조합이 다 든 PR 목록, 조절값이 없음·계정 없음·빈 목록·오류·GitLab 으로 바꾼다', async () => {
    const { path } = await start('repo');
    const open = async (hosting?: MockHostingMode) => {
      const client = createMockClient({
        rows: ROWS,
        scene: 'repo',
        progressIntervalMs: 0,
        hosting,
      });
      const opened = await client.openRepo(path, ignore);
      return { client, session: opened.session };
    };
    const { client, session } = await open();
    const project = await client.hostingRemoteProject(session);
    expect(project).toMatchObject({
      kind: 'github',
      project: 'acme/storefront-web',
      remote: 'origin',
    });
    expect(project?.accountId).toBeTruthy();
    const prs = await client.pullRequests(session);
    // 배지 조합: draft, 리뷰 셋, 검사 셋, 충돌, 배지 없음
    expect(prs.some((p) => p.draft)).toBe(true);
    expect(new Set(prs.map((p) => p.review))).toEqual(
      new Set(['approved', 'changes_requested', 'review_required', null]),
    );
    expect(new Set(prs.map((p) => p.checks))).toEqual(
      new Set(['success', 'failure', 'pending', null]),
    );
    expect(prs.some((p) => p.mergeable === false)).toBe(true);
    expect(prs.some((p) => !p.draft && !p.review && !p.checks && p.mergeable !== false)).toBe(true);
    expect(Math.max(...prs.map((p) => p.title.length))).toBeGreaterThan(40);
    expect(prs.every((p) => p.webUrl.endsWith(`/pull/${p.number}`))).toBe(true);
    expect(await client.prTemplates(session)).toHaveLength(1);
    expect(await client.checkoutPullRequest(session, 128, null)).toBe('pr/128');
    const created = await client.createPullRequest(session, {
      head: 'feat',
      base: 'main',
      title: '새 PR',
      body: '',
      draft: true,
    });
    expect(created).toMatchObject({ number: 129, title: '새 PR', draft: true });

    // 조절값
    const none = await open('none');
    expect(await none.client.hostingRemoteProject(none.session)).toBeNull();
    const noAccount = await open('noAccount');
    expect((await noAccount.client.hostingRemoteProject(noAccount.session))?.accountId).toBeNull();
    const empty = await open('empty');
    expect(await empty.client.pullRequests(empty.session)).toEqual([]);
    const error = await open('error');
    await expect(error.client.pullRequests(error.session)).rejects.toBeTruthy();
    const gitlab = await open('gitlab');
    expect((await gitlab.client.hostingRemoteProject(gitlab.session))?.kind).toBe('gitlab');
    const mrs = await gitlab.client.pullRequests(gitlab.session);
    expect(mrs.every((p) => p.webUrl.includes('/-/merge_requests/'))).toBe(true);
    expect(parseMockHosting('gitlab')).toBe('gitlab');
    expect(parseMockHosting(null)).toBe('github');
    expect(parseMockHosting('bitbucket')).toBe('github');
  });

  it('ref 는 그래프의 커밋을 가리키고 그래프 라벨과 같다', async () => {
    const { client, path } = await start('repo');
    const opened = await client.openRepo(path, ignore);
    const labels = opened.state.refs.labels;
    for (const l of labels) {
      expect(await client.findRow(opened.session, l.target)).not.toBeNull();
    }
    const window = await client.graphWindow(opened.session, 0, ROWS);
    const onGraph = window.rows.flatMap((r) => r.refs.map((l) => l.fullName));
    expect(onGraph.sort()).toEqual(labels.map((l) => l.fullName).sort());
  });

  it('커밋을 고르면 중첩 경로의 변경 파일과 diff 가 나온다', async () => {
    const { client, path } = await start('repo');
    const opened = await client.openRepo(path, ignore);
    const window = await client.graphWindow(opened.session, 0, 50);
    for (const row of window.rows.slice(0, 12)) {
      const detail = await client.commitDetail(opened.session, row.oid);
      expect(detail.row).toBe(row.row);
      expect(detail.parents).toEqual(row.parents);
      expect(detail.message.startsWith(row.subject)).toBe(true);
      expect(detail.files.length).toBeGreaterThan(1);
      expect(detail.files.some((f) => f.path.split('/').length >= 4)).toBe(true);
      const first = detail.files[0];
      expect(
        (
          await client.commitFileDiff(
            opened.session,
            row.oid,
            first?.path ?? '',
            first?.oldPath ?? null,
            false,
          )
        )?.hunks,
      ).toHaveLength(1);
    }
    // 이름이 바뀐 파일: 옛 경로를 넘기면 rename, 넘기지 않으면 전체 추가 (코어와 같다)
    const renamedIn = await (async () => {
      for (const row of window.rows) {
        const d = await client.commitDetail(opened.session, row.oid);
        const f = d.files.find((x) => x.change.kind === 'renamed');
        if (f) {
          return { oid: row.oid, file: f };
        }
      }
      return null;
    })();
    expect(renamedIn).not.toBeNull();
    const { oid: renamedOid, file: renamed } = renamedIn ?? { oid: '', file: null };
    const paired = await client.commitFileDiff(
      opened.session,
      renamedOid,
      renamed?.path ?? '',
      renamed?.oldPath ?? null,
      false,
    );
    expect(paired?.change.kind).toBe('renamed');
    expect(paired?.oldPath).toBe(renamed?.oldPath);
    const alone = await client.commitFileDiff(
      opened.session,
      renamedOid,
      renamed?.path ?? '',
      null,
      false,
    );
    expect(alone?.change.kind).toBe('added');
    // 부모의 자식 목록에 그 커밋이 있다
    const child = window.rows[0] as GraphRow;
    const parent = await client.commitDetail(opened.session, child.parents[0] ?? '');
    expect(parent.children).toContain(child.oid);
    await expect(client.commitDetail(opened.session, 'f'.repeat(40))).rejects.toThrow();
  });

  it('스태시와 작업 트리 diff 가 나온다', async () => {
    const { client, path } = await start('repo');
    const opened = await client.openRepo(path, ignore);
    const stashes = await client.listStashes(opened.session);
    expect(stashes.map((s) => s.info)).toEqual(opened.state.refs.stashes);
    expect(stashes.some((s) => s.origin)).toBe(true);
    expect((await client.stashFiles(opened.session, stashes[0]?.info.oid ?? '')).length).toBe(4);
    const entries = opened.state.status.entries;
    const both = entries.find((e) => e.index === 'modified' && e.worktree === 'modified');
    const untracked = entries.find((e) => e.worktree === 'untracked');
    const diff = (p: string | undefined, staged: boolean) =>
      client.workTreeDiff(opened.session, p ?? '', staged, false);
    expect((await diff(both?.path, true))?.change.kind).toBe('modified');
    expect((await diff(both?.path, false))?.change.kind).toBe('modified');
    expect((await diff(untracked?.path, false))?.change.kind).toBe('added');
    expect(await diff(untracked?.path, true)).toBeNull();
    expect(await diff('no/such/file', false)).toBeNull();
  });
});

describe('conflict 장면', () => {
  it('merge 가 충돌 2개로 멈춘 상태로 열린다', async () => {
    const { client, path } = await start('conflict');
    const opened = await client.openRepo(path, ignore);
    const { status, op } = opened.state;
    expect(op?.kind).toBe('merge');
    expect(status.summary.conflicted).toBe(2);
    const conflicts = await client.conflicts(opened.session);
    expect(conflicts.map((c) => c.path).sort()).toEqual(
      status.entries
        .filter((e) => e.conflict)
        .map((e) => e.path)
        .sort(),
    );
    // 충돌 파일은 작업 트리 diff 대상이 아니다
    expect(
      await client.workTreeDiff(opened.session, conflicts[0]?.path ?? '', false, false),
    ).toBeNull();
  });

  it('하나는 3-way 편집기 자료가 있고 하나는 한쪽 선택이다', async () => {
    const { client, path } = await start('conflict');
    const opened = await client.openRepo(path, ignore);
    const [text, deleted] = await client.conflicts(opened.session);
    const payload = await client.conflictFile(opened.session, text?.path ?? '');
    const blocks = payload.doc?.blocks.filter((b) => b.kind === 'conflict') ?? [];
    expect(blocks).toHaveLength(2);
    expect(payload.auto.map((a) => a.index)).toEqual([0, 1]);
    expect(payload.auto.some((a) => a.resolution)).toBe(true);
    expect(payload.worktreeModified).toBe(false);
    expect(payload.ours).not.toBe(payload.theirs);
    expect(payload.labels.theirs).toBe('feature/checkout-redesign');

    const side = await client.conflictFile(opened.session, deleted?.path ?? '');
    expect(side.file.kind).toBe('deletedByThem');
    expect(side.doc ?? null).toBeNull();
    expect(side.ours).toBeTruthy();
    expect(side.theirs ?? null).toBeNull();
    await expect(client.conflictFile(opened.session, 'no/such/file')).rejects.toThrow();
  });
});

describe('포함 브랜치 (W9, CD-03)', () => {
  /** 결과를 `[HEAD 포함 여부, 항목 수(HEAD 포함)]` 로 줄인다 */
  const size = (r: { head: boolean; branches: unknown[] }) => Number(r.head) + r.branches.length;

  it('폴더 장면: 커밋마다 개수가 다르고(0개·몇 개·10개 초과) 일부는 HEAD 를 품는다. 순서는 코어와 같다', async () => {
    const { client, path } = await start('folder');
    const { session } = await client.openFolder(path, ignore);
    const info = await client.folderTimelineOpen(session);
    const window = await client.folderTimelineWindow(session, 0, ROWS);
    const pathOf = (row: GraphRow) => info.repos.find((r) => r.index === row.repo)?.path ?? '';
    const sizes = new Set<number>();
    let withHead = 0;
    let withoutHead = 0;
    for (const row of window.rows) {
      const r = await client.folderCommitContainingRefs(session, pathOf(row), row.oid);
      expect(r.timedOut).toBe(false);
      sizes.add(size(r));
      if (r.head) {
        withHead += 1;
      } else {
        withoutHead += 1;
      }
      // 현재 브랜치 → 로컬 → 원격, 원격 이름은 `origin/` 으로 시작하고 전체 이름은 refs/remotes/ 아래
      const ranks = r.branches.map((b) => (b.remote ? 2 : b.current ? 0 : 1));
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      for (const b of r.branches) {
        expect(b.name).toBe(`refs/${b.remote ? 'remotes' : 'heads'}/${b.shortName}`);
        expect(b.shortName.startsWith('origin/')).toBe(b.remote);
      }
      // HEAD 가 브랜치에 붙은 저장소에서 현재 브랜치가 품으면 HEAD 도 품는다
      if (r.branches.some((b) => b.current)) {
        expect(r.head).toBe(true);
      }
    }
    expect(sizes.has(0)).toBe(true);
    expect([...sizes].some((n) => n > 0 && n <= 10)).toBe(true);
    expect([...sizes].some((n) => n > 10)).toBe(true);
    expect(withHead).toBeGreaterThan(0);
    expect(withoutHead).toBeGreaterThan(0);
  });

  it('폴더 장면: 이 폴더의 저장소가 아니거나 그 저장소에 없는 커밋은 거부한다', async () => {
    const { client, path } = await start('folder');
    const { session } = await client.openFolder(path, ignore);
    const info = await client.folderTimelineOpen(session);
    const row = (await client.folderTimelineWindow(session, 0, 1)).rows[0] as GraphRow;
    const own = info.repos.find((r) => r.index === row.repo)?.path ?? '';
    const other = info.repos.find((r) => r.index !== row.repo)?.path ?? '';
    for (const [repo, oid] of [
      ['/elsewhere', row.oid],
      [other, row.oid],
      [own, 'f'.repeat(40)],
    ] as const) {
      const err = toIpcError(
        await client.folderCommitContainingRefs(session, repo, oid).catch((e: unknown) => e),
      );
      expect(err.kind).toBe('internal');
    }
  });

  // 합성 그래프는 모든 토픽 브랜치가 main 에 머지되므로 모든 커밋이 HEAD(main)에서 닿는다 — 0개는 폴더 장면이 맡는다
  it('저장소 장면: 그래프의 부모를 따라 정한다 — 몇 개·10개 초과가 모두 있고 HEAD(main)는 main 과 같다', async () => {
    const { client, path } = await start('repo');
    const opened = await client.openRepo(path, ignore);
    const window = await client.graphWindow(opened.session, 0, ROWS);
    const sizes = new Set<number>();
    for (const row of window.rows) {
      const r = await client.commitContainingRefs(opened.session, row.oid);
      sizes.add(size(r));
      const main = r.branches.find((b) => b.shortName === 'main');
      expect(r.head).toBe(main !== undefined);
      if (main) {
        expect(main.current).toBe(true);
        expect(r.branches[0]).toBe(main);
      }
    }
    expect([...sizes].some((n) => n > 0 && n <= 10)).toBe(true);
    expect([...sizes].some((n) => n > 10)).toBe(true);
    // 브랜치 라벨이 붙은 커밋은 적어도 그 브랜치가 품는다
    const labelled = window.rows.find((r) => r.refs.some((l) => l.kind.kind === 'localBranch'));
    const label = labelled?.refs.find((l) => l.kind.kind === 'localBranch');
    const r = await client.commitContainingRefs(opened.session, labelled?.oid ?? '');
    expect(r.branches.map((b) => b.name)).toContain(label?.fullName);
  });

  it('지연·시간 초과 흉내: 지연 뒤에 답하고, 시간 초과면 timedOut 과 빈 목록이다. 호출 수를 센다', async () => {
    vi.useFakeTimers();
    try {
      const calls = () =>
        (globalThis as { __mgitMockCalls?: Record<string, number> }).__mgitMockCalls
          ?.folderCommitContainingRefs ?? 0;
      const client = createMockClient({
        rows: ROWS,
        scene: 'folder',
        progressIntervalMs: 0,
        containingDelayMs: 500,
        containingTimeout: true,
      });
      const [path] = await client.takeStartupPaths();
      const { session } = await client.openFolder(path ?? '', ignore);
      const info = await client.folderTimelineOpen(session);
      const row = (await client.folderTimelineWindow(session, 0, 1)).rows[0] as GraphRow;
      const repo = info.repos.find((r) => r.index === row.repo)?.path ?? '';
      const before = calls();
      let settled = false;
      const pending = client.folderCommitContainingRefs(session, repo, row.oid).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({ timedOut: true, head: false, branches: [] });
      expect(calls()).toBe(before + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('조절값을 주지 않으면 부를 때마다 localStorage 를 본다 (끄면 바로 읽힌다)', async () => {
    const { client, path } = await start('folder');
    const { session } = await client.openFolder(path, ignore);
    const info = await client.folderTimelineOpen(session);
    const row = (await client.folderTimelineWindow(session, 0, 1)).rows[0] as GraphRow;
    const repo = info.repos.find((r) => r.index === row.repo)?.path ?? '';
    localStorage.setItem('mgit.mock.containingTimeout', '1');
    try {
      expect((await client.folderCommitContainingRefs(session, repo, row.oid)).timedOut).toBe(true);
    } finally {
      localStorage.removeItem('mgit.mock.containingTimeout');
    }
    expect((await client.folderCommitContainingRefs(session, repo, row.oid)).timedOut).toBe(false);
  });
});

describe('크기 조절값 (W18 ② 화면 측정)', () => {
  /** 조절값을 준 폴더 장면을 연다 */
  async function openScaled(scale: MockScale, rows = ROWS) {
    const client = createMockClient({ rows, scene: 'folder', progressIntervalMs: 0, scale });
    const [path = ''] = await client.takeStartupPaths();
    const { session } = await client.openFolder(path, ignore);
    return { client, session };
  }

  /** 폴더 장면의 크기 (저장소·원격 브랜치·작업 트리 변경·logs 항목·작성자 수) */
  async function sizes(client: IpcClient, session: number) {
    const branches = await client.folderBranches(session);
    const changes = await client.folderChanges(session);
    const logs = await client.fsListDir(session, 'logs', 50_000);
    await client.folderTimelineOpen(session);
    return {
      repos: (await client.folderSummaries(session)).length,
      remotes: branches.branches.filter((b) => b.remote).length,
      changes: changes.reduce((sum, c) => sum + c.entries.length, 0),
      logs: logs.kind === 'listed' ? logs.total : -1,
      authors: (await client.folderTimelineAuthors(session)).total,
    };
  }

  it('주지 않거나 0 이면 기본 장면 그대로다', async () => {
    const base = await openScaled({});
    const zero = await openScaled({
      repos: 0,
      remoteBranches: 0,
      commitFiles: 0,
      dirEntries: 0,
      authors: 0,
      worktreeChanges: 0,
      bigFileKiB: 0,
    });
    const expected = await sizes(base.client, base.session);
    expect(expected).toMatchObject({ repos: 8, logs: 2_402, authors: 5 });
    expect(await sizes(zero.client, zero.session)).toEqual(expected);
    const samples = await zero.client.fsListDir(zero.session, 'samples');
    expect(
      samples.kind === 'listed' && samples.entries.some((e) => e.name.startsWith('big-')),
    ).toBe(false);
  });

  it('저장소·원격 브랜치·작업 트리 변경·logs 항목·작성자 수를 그 크기로 늘린다', async () => {
    const base = await openScaled({});
    const before = await sizes(base.client, base.session);
    const { client, session } = await openScaled(
      {
        repos: 20,
        remoteBranches: 300,
        dirEntries: 50_000,
        authors: 1_000,
        worktreeChanges: 5_000,
      },
      20_000,
    );
    const after = await sizes(client, session);
    expect(after).toEqual({
      repos: 20,
      remotes: before.remotes + 300,
      changes: before.changes + 5_000,
      logs: 50_002,
      authors: 1_000,
    });
    // 더한 저장소도 타임라인·브랜치 목록에 들고 색은 순번 % 10 이다
    const info = await client.folderTimelineInfo(session);
    expect(info.repos).toHaveLength(19);
    expect(info.repos.map((r) => r.color)).toEqual(info.repos.map((r) => r.index % 10));
    // 더한 원격 브랜치는 타임라인 행의 라벨에도 붙는다
    const window = await client.folderTimelineWindow(session, 0, 20_000);
    const labels = new Set(window.rows.flatMap((r) => r.refs.map((l) => l.shortName)));
    expect(labels.has('origin/feature/SHOP-4000-order-export')).toBe(true);
  });

  it('커밋 변경 파일 수를 주면 모든 커밋이 그 수의 파일(여러 단계 디렉터리, 추가·삭제·rename 포함)을 준다', async () => {
    const { client, session } = await openScaled({ commitFiles: 5_000 });
    const info = await client.folderTimelineOpen(session);
    const row = (await client.folderTimelineWindow(session, 3, 1)).rows[0] as GraphRow;
    const repo = info.repos.find((r) => r.index === row.repo)?.path ?? '';
    const detail = await client.folderCommitDetail(session, repo, row.oid);
    expect(detail.files).toHaveLength(5_000);
    expect(detail.files.every((f) => f.path.split('/').length === 5)).toBe(true);
    expect(new Set(detail.files.map((f) => f.change.kind))).toEqual(
      new Set(['modified', 'added', 'deleted', 'renamed']),
    );
    const renamed = detail.files.find((f) => f.change.kind === 'renamed');
    expect(
      await client.folderCommitFileDiff(
        session,
        repo,
        row.oid,
        renamed?.path ?? '',
        renamed?.oldPath ?? null,
        false,
      ),
    ).not.toBeNull();
  });

  it('큰 파일 크기를 주면 samples/ 에 읽기 상한 안의 텍스트 파일을 둔다', async () => {
    const { client, session } = await openScaled({ bigFileKiB: 1_024 });
    const file = await client.fsReadFile(session, 'samples/big-1024k.log');
    expect(file.kind).toBe('text');
    const text = file.kind === 'text' ? file.text : '';
    expect(text.length).toBeLessThanOrEqual(1024 * 1024);
    expect(text.length).toBeGreaterThan(1024 * 1024 - 64);
    expect(text.split('\n').length).toBeGreaterThan(30_000);
  });

  it('조절값을 주지 않으면 만들 때 localStorage 의 mgit.mock.<이름> 을 본다', async () => {
    localStorage.setItem('mgit.mock.repos', '12');
    localStorage.setItem('mgit.mock.remoteBranches', '30');
    try {
      const { client, path } = await start('folder');
      const { session } = await client.openFolder(path, ignore);
      expect(await client.folderSummaries(session)).toHaveLength(12);
      const remotes = (await client.folderBranches(session)).branches.filter((b) => b.remote);
      expect(remotes.filter((b) => b.name.startsWith('origin/feature/SHOP-4'))).toHaveLength(30);
    } finally {
      localStorage.removeItem('mgit.mock.repos');
      localStorage.removeItem('mgit.mock.remoteBranches');
    }
  });
});

describe('모듈·서브모듈·하위 저장소·상위 저장소 (W25 Project 트리)', () => {
  it('mockModules: 코어처럼 감지 + 직접 추가(같은 경로가 없을 때만, manual) − 숨김, 경로순', () => {
    const detected = [
      { name: 'web', path: 'apps/web', kind: 'npm' as const },
      { name: 'api', path: 'apps/api', kind: 'gradle' as const },
    ];
    expect(
      mockModules(detected, {
        added: [
          { name: 'tools', path: 'tools', kind: 'npm' },
          { name: 'dup', path: 'apps/web', kind: 'manual' },
        ],
        hidden: ['apps/api'],
      }),
    ).toEqual([
      { name: 'web', path: 'apps/web', kind: 'npm' },
      { name: 'tools', path: 'tools', kind: 'manual' },
    ]);
  });

  it('저장소 장면의 storefront-web 에만 자료가 있고, 범위·수동 보정은 세션에 남는다. 상위 저장소는 조절값으로만 켠다', async () => {
    const { client, path } = await start('repo');
    const opened = await client.openRepo(path, ignore);
    expect(opened.superproject).toBeNull();
    expect(opened.nestedRepos).toEqual([`${path}/experiments`, `${path}/playground`]);
    const s = opened.session;
    expect((await client.modules(s)).map((m) => m.path)).toEqual([
      'packages/ui',
      'src/features/cart',
      'src/features/checkout',
      'tools',
      'vendor/design-system',
    ]);
    expect((await client.submodules(s)).map((m) => m.status)).toEqual([
      'clean',
      'mismatch',
      'dirty',
      'notInitialized',
      'conflict',
    ]);
    // 트리에 그 디렉터리가 있다 (미초기화 서브모듈은 빈 디렉터리)
    expect(await client.fsListDir(s, 'vendor/legacy-theme')).toMatchObject({
      kind: 'listed',
      entries: [],
    });
    await client.moduleScopeSet(s, 'tools');
    expect(await client.moduleScope(s)).toBe('tools');
    await client.moduleOverridesSet(s, { added: [], hidden: ['packages/ui'] });
    expect((await client.modules(s)).map((m) => m.path)).not.toContain('packages/ui');
    // 다른 저장소(충돌 장면의 저장소)는 비어 있다
    const other = await client.openRepo('/mock/checkout-service', ignore);
    expect(await client.modules(other.session)).toEqual([]);
    expect(await client.submodules(other.session)).toEqual([]);
    expect(other.nestedRepos).toEqual([]);
    // 조절값을 켜면 storefront-web 만 서브모듈로 열린다
    const sub = createMockClient({
      rows: ROWS,
      scene: 'repo',
      progressIntervalMs: 0,
      superproject: true,
    });
    expect((await sub.openRepo(path, ignore)).superproject).toBe('/mock/platform-monorepo');
    expect((await sub.openRepo('/mock/checkout-service', ignore)).superproject).toBeNull();
  });
});
