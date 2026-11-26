import { beforeEach, describe, expect, it } from 'vitest';
import type { IpcClient } from '../client';
import { createMockClient } from '../mock/mock-client';
import { mockReason } from '../mock/mock-l10n';
import type { RepoChanges } from '../types';

// 목의 폴더 일괄 스태시 (셋째 묶음 G): 저장하면 변경 항목이 묶음 항목으로 옮겨지고, 묶음 목록에 보이며, 꺼내면 되돌아온다.
// 변경으로 건너뛴 pull 결과에는 스태시 안내용 표시가 붙는다.

/** 폴더 장면을 연다 */
async function folderScene() {
  const client: IpcClient = createMockClient({ rows: 200, scene: 'folder', progressIntervalMs: 0 });
  const [path = ''] = await client.takeStartupPaths();
  const { session: folder } = await client.openFolder(path, () => {});
  return { client, folder };
}

/** 저장소별 변경 경로 (경로순) */
function pathsOf(changes: readonly RepoChanges[]): Record<string, string[]> {
  return Object.fromEntries(changes.map((c) => [c.path, c.entries.map((e) => e.path).sort()]));
}

beforeEach(() => {
  const g = globalThis as { __mgitMockCalls?: unknown; __mgitMockBatches?: unknown };
  g.__mgitMockCalls = {};
  g.__mgitMockBatches = [];
});

describe('목의 일괄 스태시', () => {
  it('저장하면 추적 변경이 묶음 항목으로 옮겨지고, 묶음 목록에 보이며, 꺼내면 되돌아온다', async () => {
    const { client, folder } = await folderScene();
    const before = await client.folderChanges(folder);
    const saved = await client.folderBatch(
      folder,
      { kind: 'stashPush', batch: 'm1', message: ' 정리 ', includeUntracked: false },
      [],
    );
    expect(saved.label).toBe('스태시 일괄 저장: 정리');
    const stashed = saved.results.filter((r) => r.ok && !r.skipped).map((r) => r.path);
    expect(stashed.length).toBeGreaterThan(0);
    const batches = await client.folderStashBatches(folder, []);
    expect(batches.map((b) => [b.id, b.message])).toEqual([['m1', '정리']]);
    expect(batches[0]?.repos.map((r) => r.path)).toEqual([...stashed].sort());
    // 저장한 저장소에는 미추적 파일만 남는다
    for (const c of await client.folderChanges(folder, stashed)) {
      expect(c.entries.every((e) => e.worktree === 'untracked')).toBe(true);
    }
    // 저장한 저장소는 꺼내고, 나머지는 건너뛴다 (상태를 읽지 못한 저장소는 실패)
    const popped = await client.folderBatch(folder, { kind: 'stashPop', batch: 'm1' }, []);
    for (const r of popped.results) {
      if (stashed.includes(r.path)) {
        expect(r.ok && !r.skipped).toBe(true);
      } else {
        expect(!!r.skipped || !r.ok).toBe(true);
      }
    }
    expect(popped.results.some((r) => r.skipped === mockReason.noBatchStash())).toBe(true);
    expect(await client.folderStashBatches(folder, [])).toEqual([]);
    const after = pathsOf(await client.folderChanges(folder));
    const expected = pathsOf(before);
    for (const path of stashed) {
      expect(after[path]).toEqual(expected[path]);
    }
  });

  it('요약에 stash 수가 실리고(워크트리는 원 저장소와 같은 수), 일괄 저장·꺼내기에 따라 바뀐다', async () => {
    const { client, folder } = await folderScene();
    const countOf = async () =>
      Object.fromEntries(
        (await client.folderSummaries(folder)).map((s) => [s.name, s.stashCount ?? 0]),
      );
    const before = await countOf();
    expect(before['auth-service']).toBe(2);
    expect(before['design-system']).toBe(1);
    expect(before['design-system-hotfix']).toBe(1);
    expect(before['api-gateway']).toBe(0);
    const saved = await client.folderBatch(
      folder,
      { kind: 'stashPush', batch: 'm2', message: null, includeUntracked: true },
      [],
    );
    const stashed = saved.results.filter((r) => r.ok && !r.skipped).map((r) => r.name);
    expect(stashed).toContain('auth-service');
    const after = await countOf();
    for (const name of stashed) {
      expect(after[name]).toBe((before[name] ?? 0) + 1);
    }
    await client.folderBatch(folder, { kind: 'stashPop', batch: 'm2' }, []);
    expect(await countOf()).toEqual(before);
  });

  it('변경으로 건너뛴 pull 결과에는 skippedDirty 가 붙는다', async () => {
    const { client, folder } = await folderScene();
    const pulled = await client.folderBatch(folder, { kind: 'pull' }, []);
    const dirty = pulled.results.filter((r) => r.skipped === mockReason.dirty());
    expect(dirty.length).toBeGreaterThan(0);
    expect(dirty.every((r) => r.skippedDirty === true)).toBe(true);
    expect(pulled.results.filter((r) => r.skippedDirty).length).toBe(dirty.length);
  });
});
