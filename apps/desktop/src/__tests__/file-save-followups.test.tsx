// 자동 저장 한 번에 따라붙는 후속 작업 (반응성 G1): 저장 뒤에는 그 파일의 디렉터리 하나만 다시 읽고, Git 상태는 감시에
// 맡기며(ref 를 다시 읽는 전체 새로고침 없음), 편집기의 Blame·HEAD 원문을 다시 묻지 않는다. 감시가 죽은 경우의 대체
// 경로와 명시적 새로고침은 예전처럼 다시 읽는다.
import {
  createNullClient,
  emptyRepoState,
  type FsDirListing,
  type FsEditableFile,
  type FsSaveResult,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
  type StatusEntry,
} from '@mgit/ipc';
import { act, cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileViewDoc, WATCH_GRACE_MS } from '../features/workspace/FileViewDoc';
import { useAppStore } from '../store';
import { setEditorPreferences } from '../store/editor-preferences';
import { markExplicitRefresh } from '../store/explicit-refresh';
import { type EditorFile, fileEditors } from '../store/file-editor-store';
import {
  disposeSession,
  disposeWorkspace,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
import { createWorkspaceStore } from '../store/workspace-store';
import { installDialogStub, removeDialogStub } from './dialog-stub';

const PATH = 'src/file.ts';

beforeAll(() => {
  installDialogStub();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterAll(removeDialogStub);

let session = 8800;
beforeEach(() => {
  session += 1;
  vi.useFakeTimers();
  setEditorPreferences({
    printWidth: 200,
    currentBlame: true,
    allBlame: false,
    changeMarkers: true,
    formatOnSave: false,
  });
});
afterEach(async () => {
  cleanup();
  await fileEditors.discard(session);
  fileEditors.releaseSession(session);
  disposeWorkspace(session);
  disposeSession(session);
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** 디렉터리 목록 응답 */
const listing = (entries: { name: string; kind: 'dir' | 'file' }[]): FsDirListing => ({
  kind: 'listed',
  entries: entries.map((e) => ({ ...e, size: 1, mtimeMs: 1, openable: e.kind === 'file' })),
  total: entries.length,
  truncated: false,
  nonUtf8Names: 0,
});

/** 저장소 탭에 파일 하나를 편집기로 열고 트리의 루트·`src` 를 펼쳐 둔다. `modified` 면 저장 전부터 바뀐 파일이다 */
async function mount({ modified }: { modified: boolean }) {
  const id = session;
  let revision = 1;
  const read = vi.fn(
    async (): Promise<FsEditableFile> => ({
      kind: 'text',
      text: 'const a = 1;\n',
      size: 13,
      bom: false,
      lineEnding: 'lf',
      fileKey: `save-${id}`,
      revision: String(revision),
    }),
  );
  const client: IpcClient = {
    ...createNullClient(),
    fsReadEditableFile: read,
    fsFileStamps: vi.fn(async (_s, paths: string[]) => paths.map(() => String(revision))),
    fsSaveFile: vi.fn(async (): Promise<FsSaveResult> => {
      revision += 1;
      return { kind: 'saved', revision: String(revision) };
    }),
    fsListDir: vi.fn(async (_s, dir: string) =>
      dir === ''
        ? listing([{ name: 'src', kind: 'dir' }])
        : listing([{ name: 'file.ts', kind: 'file' }]),
    ),
    refreshRepo: vi.fn(async () => {}),
    blameContents: vi.fn(async () => []),
    revisionFileContent: vi.fn(async () => 'const a = 1;\n'),
  };
  const head = { state: 'attached' as const, branch: 'main', oid: 'a'.repeat(40) };
  const state = emptyRepoState(head);
  const entry: StatusEntry = {
    path: PATH,
    index: 'unmodified',
    worktree: 'modified',
    conflict: null,
  };
  if (modified) state.status.entries = [entry];
  const opened: RepoOpened = {
    session: id,
    alreadyOpen: false,
    nestedRepos: [],
    superproject: null,
    profile: 'light',
    info: {
      workTree: '/repo',
      gitDir: '/repo/.git',
      commonDir: '/repo/.git',
      objectFormat: 'sha1',
      head,
      commitGraph: { present: false },
      shallow: false,
    },
    state,
  };
  const cache = new GraphRangeCache({
    fetchWindow: async () => {
      throw new Error('사용하지 않는 그래프입니다');
    },
  });
  const store = createSessionStore(opened, client, cache, { profile: 'light' });
  registerSession(id, { cache, store });
  const workspace = createWorkspaceStore('repo');
  registerWorkspace(id, workspace);
  const doc = {
    kind: 'file' as const,
    id: `file:${PATH}`,
    path: PATH,
    name: 'file.ts',
    repoPath: '/repo',
    repoName: 'repo',
  };
  workspace.getState().openDoc(doc, 'pinned');
  act(() => {
    useAppStore.setState({
      client,
      sessions: { [id]: { id, kind: 'repo', path: '/repo', name: 'repo', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
    });
  });
  const tree = store.getState().fileTree;
  await act(async () => {
    tree.getState().open();
    tree.getState().setExpanded('src', true);
    await vi.advanceTimersByTimeAsync(0);
  });
  render(
    <FileViewDoc
      doc={doc}
      repoTools={{ repoName: 'repo', path: PATH, onHistory: () => {}, onBlame: () => {} }}
    />,
  );
  // 열 때의 Blame·HEAD 원문 조회(입력이 0.5초 멈춘 뒤)까지 끝낸다
  for (let i = 0; i < 2; i += 1) {
    // 응답 뒤의 상태 갱신이 다음 act 에서야 그려지므로 두 번 나눠 흘린다
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
  const editor = fileEditors.get(id, PATH) as EditorFile;
  /** 글자를 넣고 자동 저장(1초 뒤)이 끝날 때까지 */
  const typeAndSave = async () => {
    act(() =>
      fileEditors.update(
        editor,
        editor.state.update({ changes: { from: 0, insert: '// x\n' } }).state,
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
  };
  const listed = () => vi.mocked(client.fsListDir).mock.calls.map(([, dir]) => dir);
  const opening = {
    blame: vi.mocked(client.blameContents).mock.calls.length,
    head: vi.mocked(client.revisionFileContent).mock.calls.length,
  };
  /** 연 뒤로 더 나간 Blame·HEAD 원문 조회 수 */
  const requeried = () => ({
    blame: vi.mocked(client.blameContents).mock.calls.length - opening.blame,
    head: vi.mocked(client.revisionFileContent).mock.calls.length - opening.head,
  });
  return { id, client, store, tree, entry, typeAndSave, listed, opening, requeried };
}

describe('자동 저장 뒤 후속 작업 (G1)', () => {
  it('그 디렉터리 하나만 다시 읽고, 전체 새로고침·Blame·HEAD 원문 재조회를 하지 않는다', async () => {
    const t = await mount({ modified: true });
    // 파일을 열면 Blame·HEAD 원문을 각 한 번 묻는다 (저장소 세션이 정해진 뒤 한 번)
    expect(t.opening).toEqual({ blame: 1, head: 1 });
    const before = t.listed().length;
    const epoch = t.tree.getState().epoch;
    await t.typeAndSave();
    expect(t.client.fsSaveFile).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WATCH_GRACE_MS + 1000);
    });
    expect(t.listed().slice(before)).toEqual(['src']);
    expect(t.tree.getState().epoch).toBe(epoch);
    expect(t.client.refreshRepo).not.toHaveBeenCalled();
    expect(t.requeried()).toEqual({ blame: 0, head: 0 });
  });

  it('깨끗하던 파일인데 감시가 상태를 다시 읽지 않으면(감시가 죽음) 그때만 전체 새로고침을 한다', async () => {
    const t = await mount({ modified: false });
    await t.typeAndSave();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WATCH_GRACE_MS - 100);
    });
    expect(t.client.refreshRepo).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(t.client.refreshRepo).toHaveBeenCalledTimes(1);
  });

  it('깨끗하던 파일의 상태가 감시로 곧 바뀌면 전체 새로고침을 하지 않는다', async () => {
    const t = await mount({ modified: false });
    await t.typeAndSave();
    const status = { ...t.store.getState().status, entries: [t.entry] };
    act(() => t.store.getState().applyEvent({ type: 'statusChanged', session: t.id, status }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(WATCH_GRACE_MS + 1000);
    });
    expect(t.client.refreshRepo).not.toHaveBeenCalled();
  });

  it('명시적 새로고침은 트리 전체를 다시 읽고 Blame·HEAD 원문도 다시 묻는다', async () => {
    const t = await mount({ modified: true });
    const before = t.listed().length;
    await act(async () => {
      markExplicitRefresh(t.id);
      await t.tree.getState().reload();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(t.listed().slice(before).sort()).toEqual(['', 'src']);
    expect(t.requeried()).toEqual({ blame: 1, head: 1 });
  });

  it('트리만 다시 읽는 일(창 포커스·ref 변경)로는 Blame·HEAD 원문을 다시 묻지 않는다', async () => {
    const t = await mount({ modified: true });
    await act(async () => {
      await t.tree.getState().reload();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(t.requeried()).toEqual({ blame: 0, head: 0 });
  });
});
