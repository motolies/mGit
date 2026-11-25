import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guardFileEditorClose, useFileCloseStore } from '../store/file-editor-close';
import { fileEditors } from '../store/file-editor-store';
import { createWorkspaceStore, fileViewDoc } from '../store/workspace-store';

vi.mock('../store/file-editor-store', () => ({
  fileEditors: {
    flush: vi.fn(),
    hasDirty: vi.fn(),
    documents: vi.fn(),
    discard: vi.fn(),
  },
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fileEditors.flush).mockResolvedValue(true);
  vi.mocked(fileEditors.hasDirty).mockReturnValue(false);
  vi.mocked(fileEditors.documents).mockReturnValue([]);
  vi.mocked(fileEditors.discard).mockResolvedValue(undefined);
  useFileCloseStore.setState({ pending: null });
});

describe('현재 파일 닫기 보호', () => {
  it('저장 응답 전에는 닫기를 완료하지 않는다', async () => {
    let finish!: (ok: boolean) => void;
    vi.mocked(fileEditors.flush).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const close = guardFileEditorClose([{ session: 1, path: 'a.txt' }]);
    let done = false;
    void close.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    finish(true);
    expect(await close).toBe(true);
    expect(fileEditors.flush).toHaveBeenCalledWith(1, 'a.txt');
  });

  it('저장 실패 후 취소하면 초안을 폐기하지 않는다', async () => {
    vi.mocked(fileEditors.flush).mockResolvedValue(false);
    const close = guardFileEditorClose();
    await vi.waitFor(() => expect(useFileCloseStore.getState().pending).not.toBeNull());
    useFileCloseStore.getState().choose('cancel');
    expect(await close).toBe(false);
    expect(fileEditors.discard).not.toHaveBeenCalled();
  });

  it('재시도가 성공해야 닫고 명시적으로 고른 경우에만 폐기한다', async () => {
    vi.mocked(fileEditors.flush).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const retry = guardFileEditorClose([{ session: 2 }]);
    await vi.waitFor(() => expect(useFileCloseStore.getState().pending).not.toBeNull());
    useFileCloseStore.getState().choose('retry');
    expect(await retry).toBe(true);
    vi.mocked(fileEditors.flush).mockResolvedValue(false);
    const discard = guardFileEditorClose([{ session: 2 }]);
    await vi.waitFor(() => expect(useFileCloseStore.getState().pending).not.toBeNull());
    useFileCloseStore.getState().choose('discard');
    expect(await discard).toBe(true);
    expect(fileEditors.discard).toHaveBeenCalledWith(2, undefined);
  });

  it('중복 닫기 요청은 기존 확인을 덮어쓰지 않는다', async () => {
    vi.mocked(fileEditors.flush).mockResolvedValue(false);
    const first = guardFileEditorClose();
    await vi.waitFor(() => expect(useFileCloseStore.getState().pending).not.toBeNull());
    const pending = useFileCloseStore.getState().pending;
    expect(await guardFileEditorClose()).toBe(false);
    expect(useFileCloseStore.getState().pending).toBe(pending);
    useFileCloseStore.getState().choose('cancel');
    await first;
  });

  it('문서 닫기 확인 중 다른 탭을 열어도 최신 탭 상태를 유지한다', async () => {
    let finish!: (ok: boolean) => void;
    const store = createWorkspaceStore('repo', {
      beforeCloseFile: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const first = fileViewDoc({ path: 'a.txt', name: 'a.txt', repoPath: null, repoName: null });
    const second = fileViewDoc({ path: 'b.txt', name: 'b.txt', repoPath: null, repoName: null });
    store.getState().openDoc(first, 'pinned');
    store.getState().closeDoc(first.id);
    expect(store.getState().docs).toHaveLength(1);
    store.getState().openDoc(second, 'pinned');
    finish(true);
    await vi.waitFor(() => expect(store.getState().docs.map((doc) => doc.id)).toEqual([second.id]));
    expect(store.getState().activeDocId).toBe(second.id);
  });
});
