import { describe, expect, it } from 'vitest';
import { createMockClient } from '../mock/mock-client';
import type { WorkspaceSearchQuery } from '../types';

const query: WorkspaceSearchQuery = {
  text: 'README',
  content: false,
  regex: false,
  caseSensitive: false,
  scope: '',
  pathFilter: '',
  drafts: [],
};
/** 실제 목 워크스페이스의 파일을 찾고 같은 파일의 초안을 검색한다. */
describe('workspace search', () => {
  it('finds files and searches draft lines with scope and case controls', async () => {
    const client = createMockClient({ rows: 100, scene: 'folder', progressIntervalMs: 0 });
    const [root = ''] = await client.takeStartupPaths();
    const { session } = await client.openFolder(root, () => {});
    const result = await client.workspaceSearch(session, 'files', query);
    expect(result.hits.length).toBeGreaterThan(0);
    const path = result.hits[0]?.path ?? '';
    const draft = {
      ...query,
      text: 'Needle',
      content: true,
      caseSensitive: true,
      drafts: [{ path, text: 'first\nNeedle target\nlast' }],
    };
    const content = await client.workspaceSearch(session, 'content', draft);
    expect(content.hits.find((h) => h.path === path)).toMatchObject({
      line: 2,
      column: 1,
      text: 'Needle target',
    });
    expect(
      (await client.workspaceSearch(session, 'scope', { ...draft, scope: 'does-not-exist' })).hits,
    ).toEqual([]);
    await expect(
      client.workspaceSearch(session, 'bad', { ...draft, text: '[', regex: true }),
    ).rejects.toThrow();
  });

  it('previews, applies with a revision check, and undoes a replace', async () => {
    const client = createMockClient({ rows: 100, scene: 'folder', progressIntervalMs: 0 });
    const [root = ''] = await client.takeStartupPaths();
    const { session } = await client.openFolder(root, () => {});
    const files = await client.workspaceSearch(session, 'files', query);
    const path = files.hits.find((hit) => hit.repo !== null)?.path ?? '';
    const before = await client.fsReadEditableFile(session, path);
    if (before.kind !== 'text') throw new Error(`text file expected: ${path}`);
    const word = before.text.match(/[a-z]{3,}/)?.[0] ?? '';
    const pattern = { text: word, regex: false, caseSensitive: true, replacement: 'ZZ' };
    const preview = await client.workspaceReplacePreview(session, 'replace', {
      pattern,
      pathFilter: path,
      scope: '',
      drafts: [],
    });
    const file = preview.files.find((f) => f.path === path);
    if (!file) throw new Error('preview should include the file');
    const choice = { path, revision: file.revision, excluded: [] };
    const [applied] = await client.workspaceReplaceApply(session, { pattern, files: [choice] });
    if (applied?.kind !== 'applied') throw new Error(`applied expected: ${applied?.kind}`);
    expect(applied.replaced).toBe(file.matches);
    const after = await client.fsReadEditableFile(session, path);
    expect(after.kind === 'text' && after.text.includes('ZZ')).toBe(true);
    // 미리보기 revision 이 낡았으면 건너뛴다
    expect(await client.workspaceReplaceApply(session, { pattern, files: [choice] })).toEqual([
      { kind: 'skipped', path, reason: 'changed' },
    ]);
    const undone = await client.workspaceReplaceUndo(session, [
      { path, backup: applied.backup, revision: applied.revision },
    ]);
    expect(undone).toEqual([{ kind: 'restored', path }]);
    const restored = await client.fsReadEditableFile(session, path);
    expect(restored.kind === 'text' && restored.text).toBe(before.text);
    // 초안이 있는 파일은 사유와 함께 뺀다
    const drafted = await client.workspaceReplacePreview(session, 'draft', {
      pattern,
      pathFilter: path,
      scope: '',
      drafts: [path],
    });
    expect(drafted.excluded).toContainEqual({ path, reason: 'draft' });
  });

  it('lists every candidate file of file search (beyond its 2,000-hit cap), sorted, with repo dirs', async () => {
    const client = createMockClient({ rows: 100, scene: 'folder', progressIntervalMs: 0 });
    const [root = ''] = await client.takeStartupPaths();
    const { session } = await client.openFolder(root, () => {});
    const listed = await client.workspaceFiles(session, 'files');
    const everything = await client.workspaceSearch(session, 'all', { ...query, text: '' });
    const known = new Set(listed.files);
    expect(everything.hits.every((hit) => known.has(hit.path))).toBe(true);
    expect(listed.files.length).toBeGreaterThanOrEqual(everything.hits.length);
    expect(listed.files).toEqual([...listed.files].sort());
    expect(listed.repos.length).toBeGreaterThan(0);
    expect(listed.repos.every((repo) => !repo.startsWith('/'))).toBe(true);
    expect(listed.cancelled).toBe(false);
  });
});
