import {
  createNullClient,
  type DiffDocument,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
} from '@mgit/ipc';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../store/session-store';
import { createWorkspaceStore, fileViewDoc, worktreeDiffDoc } from '../store/workspace-store';
import { documentOf } from './diff-document-fixture';

const PATH = 'src/file.ts';
const SESSION = 71;
const HEAD = 'a'.repeat(40);

/** 디스크 내용과 diff 응답을 바꿀 수 있지만 Git 상태 코드는 계속 modified인 세션을 만든다. */
function setup() {
  const head = { state: 'attached' as const, branch: 'main', oid: HEAD };
  const state = emptyRepoState(head);
  state.status.summary.unstaged = 1;
  state.status.entries = [
    {
      path: PATH,
      index: 'unmodified',
      worktree: 'modified',
      conflict: null,
    },
  ];
  let diskContent = 'first edit';
  const workTreeDiffDocument = vi.fn(
    async (): Promise<DiffDocument> => ({
      ...documentOf(null, diskContent),
      new: { path: PATH, label: '작업 트리', content: diskContent, lineCount: 1 },
    }),
  );
  const client: IpcClient = {
    ...createNullClient(),
    workTreeDiffDocument,
    commitFileDiffDocument: vi.fn(async () => documentOf(null, 'commit')),
    compareFileDiffDocument: vi.fn(async () => documentOf(null, 'range')),
    refreshRepo: vi.fn(async () => {}),
  };
  const opened: RepoOpened = {
    session: SESSION,
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
  const workspace = createWorkspaceStore('repo');
  const diff = worktreeDiffDoc({ repoPath: '/repo', repoName: 'repo', path: PATH, staged: false });
  workspace.getState().openDoc(diff, 'pinned');
  const onRevealDoc = vi.fn(() => workspace.getState().activateDoc(diff.id));
  const store = createSessionStore(
    opened,
    client,
    new GraphRangeCache({
      fetchWindow: async () => {
        throw new Error('사용하지 않는 그래프입니다');
      },
    }),
    { profile: 'light', onRevealDoc },
  );
  return {
    store,
    client,
    workTreeDiffDocument,
    workspace,
    onRevealDoc,
    setDisk: (text: string) => {
      diskContent = text;
    },
  };
}

beforeEach(() => localStorage.clear());

describe('일반 파일 저장 후 열린 작업 트리 diff 갱신', () => {
  it('modified 상태가 그대로여도 새 내용을 읽고 활성 편집 탭은 유지한다', async () => {
    const { store, client, workspace, onRevealDoc, setDisk } = setup();
    await store.getState().openFile(PATH, false);
    const status = store.getState().status;
    const selected = store.getState().selectedFile;
    const file = fileViewDoc({ path: PATH, name: 'file.ts', repoPath: '/repo', repoName: 'repo' });
    workspace.getState().openDoc(file, 'pinned');
    onRevealDoc.mockClear();
    setDisk('saved second edit');
    // 코어가 statusChanged를 발행하지 않는 저장도 명시적 갱신으로 반영한다.
    await store.getState().refresh();
    await store.getState().reloadWorkingFile(PATH);
    expect(client.refreshRepo).toHaveBeenCalledWith(SESSION);
    expect(store.getState().status).toBe(status);
    expect(store.getState().selectedFile).toBe(selected);
    expect(store.getState().diffDocument?.new.content).toBe('saved second edit');
    expect(workspace.getState().activeDocId).toBe(file.id);
    expect(onRevealDoc).not.toHaveBeenCalled();
  });

  it.each(['staged', 'commit', 'range', 'other', 'closed'] as const)(
    '%s diff는 저장 갱신에서 다시 읽거나 선택하지 않는다',
    async (kind) => {
      const { store, client, workTreeDiffDocument, onRevealDoc } = setup();
      if (kind === 'staged') await store.getState().openFile(PATH, true);
      if (kind === 'commit') await store.getState().openCommitFile(HEAD, PATH);
      if (kind === 'range') {
        store.setState({
          range: {
            from: 0,
            to: 1,
            older: HEAD,
            newer: 'b'.repeat(40),
            base: HEAD,
            files: [],
            loading: false,
          },
        });
        await store.getState().openRangeFile(PATH);
      }
      if (kind === 'other') await store.getState().openFile('other.ts', false);
      const document = store.getState().diffDocument;
      const selected = store.getState().selectedFile;
      workTreeDiffDocument.mockClear();
      vi.mocked(client.commitFileDiffDocument).mockClear();
      vi.mocked(client.compareFileDiffDocument).mockClear();
      onRevealDoc.mockClear();
      await store.getState().reloadWorkingFile(PATH);
      expect(workTreeDiffDocument).not.toHaveBeenCalled();
      expect(client.commitFileDiffDocument).not.toHaveBeenCalled();
      expect(client.compareFileDiffDocument).not.toHaveBeenCalled();
      expect(onRevealDoc).not.toHaveBeenCalled();
      expect(store.getState().selectedFile).toBe(selected);
      expect(store.getState().diffDocument).toBe(document);
    },
  );

  it('전체 diff를 보던 상태와 조회 옵션을 저장 뒤에도 유지한다', async () => {
    const { store, workTreeDiffDocument } = setup();
    await store.getState().openFile(PATH, false);
    await store.getState().loadFullDiff();
    workTreeDiffDocument.mockClear();
    await store.getState().reloadWorkingFile(PATH);
    expect(workTreeDiffDocument).toHaveBeenCalledWith(SESSION, PATH, false, true, {
      ignoreWhitespace: false,
      context: 3,
    });
  });

  it('저장 후 재조회가 늦게 도착해도 이후에 연 커밋 diff를 덮지 않는다', async () => {
    const { store, workTreeDiffDocument } = setup();
    await store.getState().openFile(PATH, false);
    let finish!: (doc: DiffDocument) => void;
    workTreeDiffDocument.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = store.getState().reloadWorkingFile(PATH);
    await store.getState().openCommitFile(HEAD, PATH);
    finish(documentOf(null, 'late working tree'));
    await pending;
    expect(store.getState().selectedFile?.commit).toBe(HEAD);
    expect(store.getState().diffDocument?.revision).toBe('commit');
  });
});
