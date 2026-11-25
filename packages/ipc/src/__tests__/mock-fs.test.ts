import { describe, expect, it } from 'vitest';
import { type IpcClient, toIpcError } from '../client';
import { createMockClient } from '../mock/mock-client';
import type { MockSceneName } from '../mock/mock-workspace';
import type { FsDirListing, FsEntry, FsFile, SessionId } from '../types';

/** 이벤트를 버린다 */
const ignore = () => {};

/** 장면 클라이언트와 시작 경로의 세션 (폴더 장면은 폴더 세션, 그 밖은 저장소 세션) */
async function open(
  scene: MockSceneName,
): Promise<{ client: IpcClient; session: SessionId; path: string }> {
  const client = createMockClient({ rows: 200, scene, progressIntervalMs: 0 });
  const [path = ''] = await client.takeStartupPaths();
  const session =
    scene === 'folder'
      ? (await client.openFolder(path, ignore)).session
      : (await client.openRepo(path, ignore)).session;
  return { client, session, path };
}

/** 나열된 항목. 나열이 아니면 실패 */
function entriesOf(listing: FsDirListing): FsEntry[] {
  if (listing.kind !== 'listed') {
    throw new Error(`나열이 아니다: ${listing.kind}`);
  }
  return listing.entries;
}

/** 텍스트 본문. 텍스트가 아니면 실패 */
function textOf(file: FsFile): string {
  if (file.kind !== 'text') {
    throw new Error(`텍스트가 아니다: ${file.kind}`);
  }
  return file.text;
}

/** 거부된 호출의 오류 종류 */
async function rejectionKind(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return toIpcError(error).kind;
  }
  return 'resolved';
}

/** 코어 정렬 규칙(디렉터리 먼저 → 소문자 이름 → 원래 이름)을 지키는지 */
function isCoreOrder(entries: readonly FsEntry[]): boolean {
  return entries.every((e, i) => {
    const prev = entries[i - 1];
    if (!prev) {
      return true;
    }
    const pd = prev.kind === 'dir' ? 0 : 1;
    const d = e.kind === 'dir' ? 0 : 1;
    if (pd !== d) {
      return pd < d;
    }
    const pl = prev.name.toLowerCase();
    const l = e.name.toLowerCase();
    return pl < l || (pl === l && prev.name < e.name);
  });
}

describe('파일 API 목 (W10) — folder 장면', () => {
  it('루트에 점 폴더·문서·저장소 디렉터리가 있고 .git 은 없다. 디렉터리 먼저 이름순이다', async () => {
    const { client, session } = await open('folder');
    const root = entriesOf(await client.fsListDir(session, ''));
    const names = root.map((e) => e.name);
    for (const name of [
      '.github',
      '.vscode',
      'api-gateway',
      'auth-service',
      'design-system-hotfix',
      'web-console',
      'samples',
      'logs',
      'private',
      'README.md',
    ]) {
      expect(names).toContain(name);
    }
    expect(names.some((n) => n.toLowerCase() === '.git')).toBe(false);
    expect(isCoreOrder(root)).toBe(true);
    // 저장소 디렉터리는 요약의 저장소 경로와 같은 이름이다 (프로젝트 트리가 경로로 조인한다)
    const summaries = await client.folderSummaries(session);
    const repoDirs = root.filter((e) => e.kind === 'dir').map((e) => e.name);
    for (const summary of summaries) {
      expect(repoDirs).toContain(summary.path.slice(summary.path.lastIndexOf('/') + 1));
    }
    // 파일은 크기·수정 시각, 디렉터리는 수정 시각만
    const readme = root.find((e) => e.name === 'README.md');
    expect(readme?.openable).toBe(true);
    expect(readme?.size).toBeGreaterThan(0);
    expect(root.find((e) => e.name === 'logs')?.size).toBeNull();
  });

  it('저장소 안은 여러 단계의 소스 트리이고 변경 보기·커밋 변경 파일의 경로가 실제로 있다', async () => {
    const { client, session } = await open('folder');
    const changes = await client.folderChanges(session);
    const checked: string[] = [];
    for (const repo of changes) {
      const dir = repo.path.slice(repo.path.lastIndexOf('/') + 1);
      for (const entry of repo.entries) {
        if (entry.worktree === 'deleted' || entry.index === 'deleted') {
          continue;
        }
        const file = await client.fsReadFile(session, `${dir}/${entry.path}`);
        expect(file.kind, `${dir}/${entry.path}`).toBe('text');
        checked.push(entry.path);
      }
    }
    expect(checked.length).toBeGreaterThan(5);
    expect(
      textOf(
        await client.fsReadFile(session, 'api-gateway/src/routes/orders/handlers/create-order.ts'),
      ),
    ).toContain('create-order.ts');
    const deep = entriesOf(
      await client.fsListDir(session, 'web-console/apps/console/src/pages/orders'),
    );
    expect(deep.map((e) => e.name)).toEqual(['filters', 'OrderExport.tsx', 'OrderTable.tsx']);
  });

  it('2,000개를 넘는 디렉터리는 잘리고, 상한을 올려 다시 부르면 나머지가 온다. 상한은 1~50,000 으로 맞춘다', async () => {
    const { client, session } = await open('folder');
    const first = await client.fsListDir(session, 'logs');
    if (first.kind !== 'listed') {
      throw new Error(first.kind);
    }
    expect(first.entries).toHaveLength(2_000);
    expect(first.truncated).toBe(true);
    expect(first.total).toBe(2_402);
    // 정렬은 자르기 전에: 하위 디렉터리가 이름과 무관하게 맨 앞
    expect(first.entries.slice(0, 3).map((e) => e.name)).toEqual([
      'archive',
      'rotated',
      'request-00000.log',
    ]);
    const all = await client.fsListDir(session, 'logs', first.total);
    expect(all.kind === 'listed' && all.entries.length === 2_402 && !all.truncated).toBe(true);
    expect(entriesOf(await client.fsListDir(session, 'logs', 0))).toHaveLength(1);
    expect(entriesOf(await client.fsListDir(session, 'logs', 1e9))).toHaveLength(2_402);
  });

  it('상태 표본: 바이너리·너무 큼·UTF-8 아님·링크·읽는 순간 사라짐·소켓·긴 문서·한글 이름', async () => {
    const { client, session } = await open('folder');
    const samples = entriesOf(await client.fsListDir(session, 'samples'));
    const kindOf = (name: string) => samples.find((e) => e.name === name);
    expect(kindOf('current')).toMatchObject({ kind: 'symlink', openable: false, size: null });
    expect(kindOf('agent.sock')).toMatchObject({ kind: 'other', openable: false });
    expect(kindOf('vanished.log')).toMatchObject({ kind: 'file', openable: true });
    const read = (path: string) => client.fsReadFile(session, `samples/${path}`);
    expect(await read('logo.png')).toEqual({ kind: 'binary', size: 68 });
    expect(await read('heap-dump.hprof')).toEqual({
      kind: 'tooLarge',
      size: 48_234_496,
      limit: 1_048_576,
    });
    expect(await read('legacy-euc-kr.csv')).toEqual({ kind: 'notUtf8', size: 2_816 });
    expect(await read('current')).toEqual({ kind: 'unsupported', fileKind: 'symlink' });
    expect(await read('agent.sock')).toEqual({ kind: 'unsupported', fileKind: 'other' });
    expect(await read('vanished.log')).toEqual({ kind: 'missing' });
    expect(textOf(await read('release-notes.md')).split('\n').length).toBeGreaterThan(300);
    expect(textOf(await read('주간 보고 2026-11-18.md'))).toContain('참석');
    expect(await client.fsReadFile(session, 'samples')).toEqual({
      kind: 'unsupported',
      fileKind: 'dir',
    });
    // 텍스트의 크기는 UTF-8 바이트 수다
    const korean = await read('주간 보고 2026-11-18.md');
    expect(korean.kind === 'text' && korean.size > korean.text.length).toBe(true);
  });

  it('없음·권한 없음은 결과 상태로 온다', async () => {
    const { client, session } = await open('folder');
    expect(await client.fsListDir(session, 'private')).toEqual({ kind: 'denied' });
    expect(await client.fsReadFile(session, 'private/credentials.json')).toEqual({
      kind: 'denied',
    });
    expect(await client.fsListDir(session, 'gone')).toEqual({ kind: 'missing' });
    expect(await client.fsListDir(session, 'README.md')).toEqual({ kind: 'missing' });
    expect(await client.fsReadFile(session, 'gone.txt')).toEqual({ kind: 'missing' });
    expect(await client.fsReadFile(session, 'README.md/x')).toEqual({ kind: 'missing' });
  });

  it('루트 밖·.git·어휘 위반·링크 나열·경로 중간의 링크는 코어처럼 internal 오류로 거부한다', async () => {
    const { client, session } = await open('folder');
    const bad = [
      '..',
      '../x',
      'api-gateway/../README.md',
      '.',
      './README.md',
      '/etc/passwd',
      '/mock/acme-platform/README.md',
      'a//b',
      'docs/',
      'a\0b',
      '.git',
      '.GIT/config',
      'api-gateway/.git/HEAD',
      'api-gateway/.Git',
      'samples/current/x',
      'x'.repeat(256),
    ];
    for (const path of bad) {
      expect(await rejectionKind(client.fsReadFile(session, path)), path).toBe('internal');
      expect(await rejectionKind(client.fsListDir(session, path)), path).toBe('internal');
    }
    expect(await rejectionKind(client.fsReadFile(session, ''))).toBe('internal');
    expect(await rejectionKind(client.fsListDir(session, 'samples/current'))).toBe('internal');
    // 거부 문구에는 요청한 그대로만 있다
    try {
      await client.fsReadFile(session, '../x');
    } catch (error) {
      expect(toIpcError(error)).toEqual({
        kind: 'internal',
        message: '파일 경로를 거부했습니다 (`..` 구성요소는 쓸 수 없습니다): "../x"',
      });
    }
  });

  it('루트는 세션 id 로만 정한다: 저장소를 탭으로 열면 폴더의 그 디렉터리와 같은 트리, 모르는 세션은 sessionNotFound', async () => {
    const { client, session, path } = await open('folder');
    const repo = await client.openRepo(`${path}/web-console`, ignore);
    expect(repo.session).not.toBe(session);
    expect(await client.fsListDir(repo.session, '')).toEqual(
      await client.fsListDir(session, 'web-console'),
    );
    expect(await rejectionKind(client.fsListDir(9_999, ''))).toBe('sessionNotFound');
    expect(await rejectionKind(client.fsReadFile(9_999, 'README.md'))).toBe('sessionNotFound');
  });
});

describe('파일 API 목 (W10) — repo·conflict 장면', () => {
  it('작업 트리 하나의 소스 트리: 커밋·작업 트리 변경 경로가 있고 지워진 파일은 없다', async () => {
    const { client, session } = await open('repo');
    const root = entriesOf(await client.fsListDir(session, ''));
    const names = root.map((e) => e.name);
    for (const name of [
      '.github',
      'src',
      'public',
      'docs',
      'secrets',
      'package.json',
      'CHANGELOG.md',
    ]) {
      expect(names).toContain(name);
    }
    expect(isCoreOrder(root)).toBe(true);
    const state = await client.repoState(session);
    for (const entry of state.status.entries) {
      const file = await client.fsReadFile(session, entry.path);
      const deleted = entry.worktree === 'deleted' || entry.index === 'deleted';
      expect(file.kind, entry.path).toBe(deleted ? 'missing' : 'text');
    }
    // 커밋에서 지운 파일은 없고 rename 의 새 경로는 있다
    expect(await client.fsReadFile(session, 'src/features/checkout/legacy/CardForm.tsx')).toEqual({
      kind: 'missing',
    });
    expect((await client.fsReadFile(session, 'src/lib/money/format.ts')).kind).toBe('text');
  });

  it('Rollback 흉내: 추가·untracked 파일은 상태와 트리에서 사라지고 충돌 항목은 거부된다', async () => {
    const { client, session } = await open('repo');
    const before = (await client.repoState(session)).status.entries;
    const added = before.find((e) => e.index === 'added' && e.worktree !== 'deleted');
    const untracked = before.find((e) => e.worktree === 'untracked');
    const modified = before.find((e) => e.index === 'unmodified' && e.worktree === 'modified');
    if (!added || !untracked || !modified) {
      throw new Error('repo 장면에 추가·untracked·수정 표본이 있어야 한다');
    }
    await client.rollbackPaths(session, [added.path, untracked.path, modified.path]);
    const after = (await client.repoState(session)).status.entries.map((e) => e.path);
    for (const e of [added, untracked, modified]) {
      expect(after).not.toContain(e.path);
    }
    expect(after.length).toBe(before.length - 3);
    expect(await client.fsReadFile(session, added.path)).toEqual({ kind: 'missing' });
    expect(await client.fsReadFile(session, untracked.path)).toEqual({ kind: 'missing' });
    expect((await client.fsReadFile(session, modified.path)).kind).toBe('text');

    const conflict = await open('conflict');
    const conflicted = (await conflict.client.repoState(conflict.session)).status.entries.find(
      (e) => e.conflict,
    );
    expect(conflicted).toBeDefined();
    expect(
      await rejectionKind(
        conflict.client.rollbackPaths(conflict.session, [conflicted?.path ?? '']),
      ),
    ).toBe('internal');
  });

  it('상태 표본과 잘리는 디렉터리, 권한 없는 디렉터리가 있다', async () => {
    const { client, session } = await open('repo');
    const icons = await client.fsListDir(session, 'src/generated/icons');
    expect(icons.kind === 'listed' && icons.truncated && icons.total === 2_347).toBe(true);
    expect(await client.fsReadFile(session, 'public/images/logo.png')).toMatchObject({
      kind: 'binary',
    });
    expect(await client.fsReadFile(session, 'dist/app.js.map')).toMatchObject({ kind: 'tooLarge' });
    expect(await client.fsReadFile(session, 'legacy/주문내역-euc-kr.csv')).toMatchObject({
      kind: 'notUtf8',
    });
    expect(await client.fsReadFile(session, 'config/current.json')).toEqual({
      kind: 'unsupported',
      fileKind: 'symlink',
    });
    expect(await client.fsReadFile(session, 'logs/dev.log')).toEqual({ kind: 'missing' });
    expect(await client.fsReadFile(session, '.cache/devserver.sock')).toEqual({
      kind: 'unsupported',
      fileKind: 'other',
    });
    expect(
      textOf(await client.fsReadFile(session, 'README.md')).split('\n').length,
    ).toBeGreaterThan(300);
    expect(
      textOf(await client.fsReadFile(session, 'docs/회의록/2026-11-18 주간 회의.md')),
    ).toContain('결정');
    expect(await client.fsListDir(session, 'secrets')).toEqual({ kind: 'denied' });
    expect(await rejectionKind(client.fsListDir(session, 'config/current.json'))).toBe('internal');
    expect(await rejectionKind(client.fsReadFile(session, '.git/HEAD'))).toBe('internal');
  });

  it('충돌 장면의 작업 트리에는 충돌 파일이 있다', async () => {
    const { client, session } = await open('conflict');
    const conflicts = await client.conflicts(session);
    const text = conflicts.find((c) => c.kind === 'bothModified');
    expect(text).toBeDefined();
    expect((await client.fsReadFile(session, text?.path ?? '')).kind).toBe('text');
  });

  it('장면이 없는 목은 파일 API 를 널 스텁 그대로 거부한다', async () => {
    const client = createMockClient({ rows: 50, progressIntervalMs: 0 });
    const opened = await client.openRepo('/mock/repo-50', ignore);
    await expect(client.fsListDir(opened.session, '')).rejects.toThrow();
  });
});

describe('현재 파일 편집 API 목', () => {
  it('폴더와 저장소에서 같은 키를 공유하고 오래된 revision 저장을 거부한다', async () => {
    const { client, session, path } = await open('folder');
    const repo = (await client.openRepo(`${path}/api-gateway`, ignore)).session;
    const fromFolder = await client.fsReadEditableFile(session, 'api-gateway/README.md');
    const fromRepo = await client.fsReadEditableFile(repo, 'README.md');
    expect(fromFolder.kind).toBe('text');
    if (fromFolder.kind !== 'text' || fromRepo.kind !== 'text') throw new Error('텍스트여야 한다');
    expect(fromRepo.fileKey).toBe(fromFolder.fileKey);
    expect(fromRepo.revision).toBe(fromFolder.revision);
    const stagedBefore = (await client.repoState(repo)).status.entries.filter(
      (entry) => entry.index !== 'unmodified',
    );
    const text = '\ufeff한글😀\r\n끝';
    const saved = await client.fsSaveFile(repo, 'README.md', fromRepo.revision, text);
    expect(saved.kind).toBe('saved');
    expect(
      (await client.repoState(repo)).status.entries.filter((entry) => entry.index !== 'unmodified'),
    ).toEqual(stagedBefore);
    expect(
      (await client.workTreeDiff(repo, 'README.md', false, false))?.hunks[0]?.lines.some(
        (line) => line.kind === 'add' && line.text.includes('한글😀'),
      ),
    ).toBe(true);
    expect(await client.fsReadFile(session, 'api-gateway/README.md')).toMatchObject({
      kind: 'text',
      text,
    });
    expect(
      await client.fsSaveFile(session, 'api-gateway/README.md', fromFolder.revision, 'late'),
    ).toEqual({ kind: 'conflict' });
    expect(await client.fsReadEditableFile(repo, 'README.md')).toMatchObject({
      kind: 'text',
      bom: true,
      lineEnding: 'crlf',
      text,
    });
  });

  it('용량·혼합 줄 끝·경로 제한을 유지하며 실패 시 원문을 보존한다', async () => {
    const { client, session } = await open('folder');
    const file = await client.fsReadEditableFile(session, 'README.md');
    if (file.kind !== 'text') throw new Error('텍스트여야 한다');
    for (const text of ['x'.repeat(1024 * 1024 + 1), 'a\nb\r\n', 'a\0b']) {
      expect(await client.fsSaveFile(session, 'README.md', file.revision, text)).toMatchObject({
        kind: 'failed',
      });
    }
    expect(await client.fsReadEditableFile(session, 'README.md')).toEqual(file);
    expect(await rejectionKind(client.fsSaveFile(session, '../x', file.revision, 'bad'))).toBe(
      'internal',
    );
    expect(await rejectionKind(client.fsReadEditableFile(99999, 'README.md'))).toBe(
      'sessionNotFound',
    );
  });
});

describe('이미지 조회', () => {
  it('실제 이미지 data URL과 상태를 반환하고 세션·경로 경계를 유지한다', async () => {
    const { client, session } = await open('folder');
    expect(await client.fsReadImage(session, 'samples/logo.png')).toMatchObject({
      kind: 'image',
      mime: 'image/png',
      size: 68,
      dataUrl: expect.stringMatching(/^data:image\/png;base64,/),
    });
    expect(await client.fsReadImage(session, 'samples/current')).toEqual({ kind: 'unsupported' });
    expect(await client.fsReadImage(session, 'README.md')).toEqual({ kind: 'unsupported' });
    expect(await client.fsReadImage(session, 'private/credentials.json')).toEqual({
      kind: 'denied',
    });
    expect(await client.fsReadImage(session, 'gone.png')).toEqual({ kind: 'missing' });
    expect(await client.fsReadImage(session, 'samples/heap-dump.hprof')).toMatchObject({
      kind: 'tooLarge',
      limit: 5 * 1024 * 1024,
    });
    expect(await rejectionKind(client.fsReadImage(session, '../secret.png'))).toBe('internal');
    expect(await rejectionKind(client.fsReadImage(session, '.git/image.png'))).toBe('internal');
    expect(await rejectionKind(client.fsReadImage(9999, 'samples/logo.png'))).toBe(
      'sessionNotFound',
    );
  });
});
