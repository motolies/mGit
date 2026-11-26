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
});
