import { type BatchResult, createNullClient, type IpcClient } from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createFolderStore, selectedRepoPaths } from '../store/folder-store';

const ROOT = '/w/acme';
const REPOS = ['api', 'api-v2', 'libs/core'].map((rel) => ({
  path: `${ROOT}/${rel}`,
  kind: 'standalone' as const,
}));

const RESULT: BatchResult = { label: 'x', results: [], succeeded: 0, skipped: 0, failed: 0 };

/** 일괄 작업을 기록하는 폴더 스토어 */
function folder() {
  const folderBatch = vi.fn<IpcClient['folderBatch']>(async () => RESULT);
  const store = createFolderStore(
    { session: 3, path: ROOT, repos: REPOS },
    { ...createNullClient(), folderSummaries: async () => [], folderBatch },
  );
  const tree = () => store.getState().fileTree.getState();
  return { store, tree, folderBatch };
}

describe('selectedRepoPaths (PT-07, WS-09)', () => {
  it('트리 선택 중 저장소 디렉터리인 행만, 저장소 목록 순서로. 이름이 접두로 겹쳐도 섞이지 않는다', () => {
    expect(
      selectedRepoPaths(ROOT, REPOS, { 'libs/core': true, api: true, 'api/src': true, '': true }),
    ).toEqual([`${ROOT}/api`, `${ROOT}/libs/core`]);
    expect(selectedRepoPaths(ROOT, REPOS, { 'api-v2': true, libs: true })).toEqual([
      `${ROOT}/api-v2`,
    ]);
    expect(selectedRepoPaths(ROOT, REPOS, {})).toEqual([]);
  });
});

describe('고른 저장소의 출처는 트리 선택 하나다 (PT-07)', () => {
  it('트리에서 저장소 행을 고르면 고른 저장소가 되고, 저장소가 아닌 행은 들지 않는다', () => {
    const { store, tree } = folder();
    tree().select('api');
    tree().toggleInSelection('libs/core');
    tree().toggleInSelection('README.md');
    expect(store.getState().selectedRepos()).toEqual([`${ROOT}/api`, `${ROOT}/libs/core`]);
  });

  it('개요의 체크(toggleSelect)는 트리 선택에 넣고 빼며 다른 선택과 기준 행은 그대로다', () => {
    const { store, tree } = folder();
    tree().select('README.md');
    store.getState().toggleSelect(`${ROOT}/api-v2`);
    expect(tree().selection).toEqual({ 'README.md': true, 'api-v2': true });
    expect(tree().selected).toBe('README.md');
    store.getState().toggleSelect(`${ROOT}/api-v2`);
    expect(tree().selection).toEqual({ 'README.md': true });
    // 폴더 밖 경로는 무시한다
    store.getState().toggleSelect('/elsewhere/x');
    expect(tree().selection).toEqual({ 'README.md': true });
  });

  it('setSelected 는 고른 저장소를 그 목록으로 맞추고 저장소가 아닌 선택은 남긴다', () => {
    const { store, tree } = folder();
    tree().select('docs');
    tree().toggleInSelection('api');
    store.getState().setSelected([`${ROOT}/libs/core`, `${ROOT}/api-v2`]);
    expect(Object.keys(tree().selection).sort()).toEqual(['api-v2', 'docs', 'libs/core']);
    store.getState().setSelected([]);
    expect(Object.keys(tree().selection)).toEqual(['docs']);
  });

  it('일괄 작업의 기본 대상이 트리 선택의 저장소다. 없으면 빈 목록(= 전부)', async () => {
    const { store, tree, folderBatch } = folder();
    await store.getState().runBatch({ kind: 'fetch', prune: true });
    expect(folderBatch).toHaveBeenLastCalledWith(3, { kind: 'fetch', prune: true }, []);
    tree().select('api');
    tree().toggleInSelection('api-v2');
    await store.getState().runBatch({ kind: 'pull' });
    expect(folderBatch).toHaveBeenLastCalledWith(3, { kind: 'pull' }, [
      `${ROOT}/api`,
      `${ROOT}/api-v2`,
    ]);
    // 넘긴 대상이 있으면 그것
    await store.getState().runBatch({ kind: 'push' }, [`${ROOT}/libs/core`]);
    expect(folderBatch).toHaveBeenLastCalledWith(3, { kind: 'push' }, [`${ROOT}/libs/core`]);
  });

  it('재스캔으로 저장소에서 빠진 디렉터리는 선택에 남아도 고른 저장소가 아니다', () => {
    const { store, tree } = folder();
    tree().select('api');
    store.getState().applyEvent({
      type: 'folderRescanned',
      session: 3,
      repos: [{ path: `${ROOT}/libs/core`, kind: 'standalone' }],
    });
    expect(tree().selection).toEqual({ api: true });
    expect(store.getState().selectedRepos()).toEqual([]);
  });

  it('변경 목록은 한 번만 미리 읽는다 (파일 상태 색)', async () => {
    const folderChanges = vi.fn<IpcClient['folderChanges']>(async () => []);
    const store = createFolderStore(
      { session: 4, path: ROOT, repos: REPOS },
      { ...createNullClient(), folderSummaries: async () => [], folderChanges },
    );
    store.getState().ensureChanges();
    store.getState().ensureChanges();
    await new Promise((r) => setTimeout(r, 0));
    expect(folderChanges).toHaveBeenCalledTimes(1);
  });
});
