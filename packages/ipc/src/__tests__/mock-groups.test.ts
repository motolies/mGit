import { describe, expect, it } from 'vitest';
import { createMockClient } from '../mock/mock-client';
import { mockAssignAlias, mockValidAlias } from '../mock/mock-groups';
import { createNullClient } from '../mock/null-client';
import type { FsDirListing, SessionEvent } from '../types';

/** 이벤트를 버린다 */
const ignore = () => {};

/** 폴더 장면 클라이언트와 장면 폴더의 저장소 경로들 */
async function scene() {
  const client = createMockClient({ rows: 200, scene: 'folder', progressIntervalMs: 0 });
  const [folder = ''] = await client.takeStartupPaths();
  const { repos } = await client.openFolder(folder, ignore);
  return { client, folder, repos: repos.map((r) => r.path) };
}

/** 나열된 이름들. 나열이 아니면 실패 */
function names(listing: FsDirListing): string[] {
  if (listing.kind !== 'listed') throw new Error(`나열이 아니다: ${listing.kind}`);
  return listing.entries.map((e) => e.name);
}

describe('목 가상 그룹 (MR-13 M1)', () => {
  it('별칭 규칙은 코어와 같다: 폴더 이름 → -상위폴더 → -2… (대소문자 무시)', () => {
    expect(mockAssignAlias([], '/a/x/api')).toBe('api');
    expect(mockAssignAlias(['API'], '/b/y/api')).toBe('api-y');
    expect(mockAssignAlias(['api', 'api-y'], '/c/y/api')).toBe('api-y-2');
    expect(mockAssignAlias(['api'], '/api')).toBe('api-2');
    expect(mockAssignAlias([], '/w/.git')).toBe('repo');
    for (const bad of ['', '.', '..', '.git', 'a/b', 'a\0b'])
      expect(mockValidAlias(bad)).toBe(false);
  });

  it('장면에는 고정된 그룹 하나가 있고, 없는 멤버는 missing 이다', async () => {
    const { client, repos } = await scene();
    const [group] = await client.groupsList();
    expect(group?.pinned).toBe(true);
    expect(group?.members.map((m) => m.state)).toEqual(['present', 'present', 'missing']);
    expect(group?.members.slice(0, 2).map((m) => m.path)).toEqual(repos.slice(0, 2));
  });

  it('경로 확인은 폴더를 저장소들로 펼치고 중복·모르는 경로를 거부하며, 만들기는 거부가 있으면 실패한다', async () => {
    const { client, folder, repos } = await scene();
    const [a = '', b = ''] = repos;
    const checks = await client.groupCheckPaths(null, [a, `${a}/src`, '/mock/nowhere']);
    expect(checks.map((c) => [c.path, c.issue ?? null])).toEqual([
      [a, null],
      [a, 'duplicate'],
      ['/mock/nowhere', 'missing'],
    ]);
    const expanded = await client.groupCheckPaths(null, [folder]);
    expect(expanded.map((c) => c.path)).toEqual(repos);
    await expect(client.groupCreate('bad', [a, '/mock/nowhere'])).rejects.toThrow();
    const created = await client.groupCreate('  Pair  ', [a, b]);
    expect(created.name).toBe('Pair');
    await expect(client.groupCreate('pair', [a])).rejects.toThrow();
    expect((await client.groupsList()).map((g) => g.id)).toContain(created.id);
  });

  it('그룹을 열면 경로가 세션 키이고 파일 경로는 별칭 공간이다 (맨 위 나열, 맨 위 읽기·모르는 별칭 거부, 없는 멤버 없음)', async () => {
    const { client, repos } = await scene();
    const [group] = await client.groupsList();
    if (!group) throw new Error('그룹이 없다');
    const opened = await client.openGroup(group.id, ignore);
    expect(opened.path).toBe(`mgit-group:${group.id}`);
    expect(opened.repos.map((r) => r.path)).toEqual(repos.slice(0, 2));
    expect(opened.group?.members.map((m) => m.alias)).toEqual(group.members.map((m) => m.alias));
    expect((await client.openGroup(group.id, ignore)).session).toBe(opened.session);
    expect((await client.folderSummaries(opened.session)).map((s) => s.path)).toEqual(
      repos.slice(0, 2),
    );

    const top = await client.fsListDir(opened.session, '', null);
    expect(names(top)).toEqual(group.members.map((m) => m.alias).sort());
    const first = group.members[0]?.alias ?? '';
    expect(names(await client.fsListDir(opened.session, first, null)).length).toBeGreaterThan(0);
    expect(await client.fsListDir(opened.session, 'legacy-tools', null)).toEqual({
      kind: 'missing',
    });
    for (const bad of ['', `${first}/..`, 'nope/x', `/${first}`, `${first}/.git/config`]) {
      await expect(client.fsReadFile(opened.session, bad)).rejects.toThrow();
    }
    // 검색·⌘P (M3): 있는 멤버의 파일이 `별칭/…` 로 오고, 저장소는 멤버 별칭이다 (사라진 멤버는 건너뛴다)
    const listed = await client.workspaceFiles(opened.session, 'files-group');
    const present = group.members.filter((m) => m.state === 'present').map((m) => m.alias);
    expect(listed.repos).toEqual([...present].sort());
    expect(listed.files.length).toBeGreaterThan(0);
    expect(listed.files.every((f) => present.some((a) => f.startsWith(`${a}/`)))).toBe(true);
    const firstFile = listed.files[0] ?? '';
    expect((await client.fsReadFile(opened.session, firstFile)).kind).not.toBe('missing');
    const found = await client.workspaceSearch(opened.session, 'search-group', {
      text: '',
      content: false,
      regex: false,
      caseSensitive: false,
      pathFilter: '',
      scope: first,
      drafts: [],
    });
    expect(found.hits.length).toBeGreaterThan(0);
    expect(found.hits.every((h) => h.path.startsWith(`${first}/`) && h.repo === first)).toBe(true);
  });

  it('열린 그룹을 고치면 그 자리에서 반영하고(목록 → 모습 이벤트, 새 별칭 경로) 지우기는 닫은 뒤에만 된다', async () => {
    const { client } = await scene();
    const [group] = await client.groupsList();
    if (!group) throw new Error('그룹이 없다');
    const events: SessionEvent[] = [];
    const { session } = await client.openGroup(group.id, (e) => events.push(e));
    const [first, ...rest] = group.members;
    if (!first) throw new Error('멤버가 없다');
    const renamed = await client.groupUpdate(group.id, {
      name: 'Other',
      members: [{ alias: 'renamed', path: first.path }, ...rest],
    });
    expect(renamed.name).toBe('Other');
    expect(events.map((e) => e.type)).toEqual(['folderRescanned', 'groupChanged']);
    const changed = events[1];
    expect(changed?.type === 'groupChanged' && changed.group.members[0]?.alias).toBe('renamed');
    expect(names(await client.fsListDir(session, '', null))).toContain('renamed');
    await expect(client.fsListDir(session, first.alias, null)).rejects.toThrow();
    // 고정만 바꾸면 이벤트가 없다
    expect((await client.groupUpdate(group.id, { pinned: false })).pinned).toBe(false);
    expect(events).toHaveLength(2);
    await expect(client.groupDelete(group.id)).rejects.toThrow();
    await client.closeFolder(session);
    await client.groupDelete(group.id);
    expect(await client.groupsList()).toEqual([]);
  });

  it('그룹의 여러 파일 바꾸기는 검색처럼 별칭 경로로 미리보고, 그 경로로 적용·되돌리기 한다', async () => {
    const { client } = await scene();
    const [group] = await client.groupsList();
    if (!group) throw new Error('그룹이 없다');
    const { session } = await client.openGroup(group.id, ignore);
    const first = group.members[0]?.alias ?? '';
    const listed = await client.workspaceFiles(session, 'files-group');
    let path = '';
    let before = '';
    for (const file of listed.files.filter((f) => f.startsWith(`${first}/`))) {
      const read = await client.fsReadEditableFile(session, file);
      if (read.kind === 'text' && /[a-z]{3,}/.test(read.text)) {
        path = file;
        before = read.text;
        break;
      }
    }
    const word = before.match(/[a-z]{3,}/)?.[0] ?? '';
    const pattern = { text: word, regex: false, caseSensitive: true, replacement: 'ZZ' };
    const preview = await client.workspaceReplacePreview(session, 'replace-group', {
      pattern,
      pathFilter: path,
      scope: '',
      drafts: [],
    });
    const file = preview.files.find((f) => f.path === path);
    if (!file) throw new Error(`미리보기에 ${path} 가 있어야 한다`);
    expect(file.repo).toBe(first);
    expect(preview.files.every((f) => f.path.includes('/'))).toBe(true);
    const choice = { path, revision: file.revision, excluded: [] };
    const [applied, top] = await client.workspaceReplaceApply(session, {
      pattern,
      files: [choice, { path: '', revision: 'r', excluded: [] }],
    });
    if (applied?.kind !== 'applied') throw new Error(`적용돼야 한다: ${applied?.kind}`);
    expect(top?.kind).toBe('failed');
    const after = await client.fsReadEditableFile(session, path);
    expect(after.kind === 'text' && after.text.includes('ZZ')).toBe(true);
    const undone = await client.workspaceReplaceUndo(session, [
      { path, backup: applied.backup, revision: applied.revision },
    ]);
    expect(undone).toEqual([{ kind: 'restored', path }]);
    const restored = await client.fsReadEditableFile(session, path);
    expect(restored.kind === 'text' && restored.text).toBe(before);
    // 초안은 별칭 경로로 받는다
    const drafted = await client.workspaceReplacePreview(session, 'draft-group', {
      pattern,
      pathFilter: path,
      scope: first,
      drafts: [path],
    });
    expect(drafted.excluded).toContainEqual({ path, reason: 'draft' });
  });

  it('그룹 재스캔은 코어처럼 folderRescanned 뒤에 groupChanged(멤버 상태)를 보낸다', async () => {
    const { client } = await scene();
    const [group] = await client.groupsList();
    if (!group) throw new Error('그룹이 없다');
    const events: string[] = [];
    const { session } = await client.openGroup(group.id, (e) => events.push(e.type));
    await client.folderRescan(session);
    expect(events).toEqual(['folderRescanned', 'groupChanged']);
  });

  it('널 클라이언트는 그룹이 없다', async () => {
    const client = createNullClient();
    expect(await client.groupsList()).toEqual([]);
    expect(await client.groupCheckPaths(null, ['/x'])).toEqual([]);
    await expect(client.openGroup('g000000000001', ignore)).rejects.toThrow();
  });
});
