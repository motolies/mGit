// D-5: 다른 파일의 status 이벤트로 보던 작업 트리 diff 를 다시 볼 때, 받은 문서가 같으면 상태를 바꾸지 않아 diff 화면이 다시
// 그려지지 않는다 (읽는 중 표시도 켜지 않는다). 내용만 바뀐 경우는 그 재조회와 편집기 저장(`reloadWorkingFile`)이 계속 잡는다
import {
  createNullClient,
  emptyRepoState,
  GraphRangeCache,
  type IpcClient,
  type RepoOpened,
  type StatusEntry,
} from '@mgit/ipc';
import { describe, expect, it, vi } from 'vitest';
import { createSessionStore } from '../store/session-store';
import { documentOf } from './diff-document-fixture';

const HEAD = 'a'.repeat(40);
const head = { state: 'attached' as const, branch: 'main', oid: HEAD };

/** 작업 트리에서 수정된 파일 하나의 status 항목 */
function modified(path: string): StatusEntry {
  return { path, origPath: null, index: 'unmodified', worktree: 'modified', conflict: null };
}

/** 그 항목들로 된 status */
function statusOf(entries: StatusEntry[]) {
  const base = emptyRepoState(head).status;
  return { ...base, entries, summary: { ...base.summary, unstaged: entries.length } };
}

/** 작업 트리 diff 의 응답을 바꿀 수 있는 가짜 클라이언트와 스토어 */
function setup() {
  let revision = 'r1';
  const workTreeDiffDocument = vi.fn(async () => documentOf(null, revision));
  const client: IpcClient = { ...createNullClient(), workTreeDiffDocument };
  const opened: RepoOpened = {
    session: 1,
    alreadyOpen: false,
    nestedRepos: [],
    superproject: null,
    info: {
      workTree: '/r',
      gitDir: '/r/.git',
      commonDir: '/r/.git',
      objectFormat: 'sha1',
      head,
      commitGraph: { present: false },
      shallow: false,
    },
    state: { ...emptyRepoState(head), status: statusOf([modified('f.txt'), modified('g.txt')]) },
  };
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  const store = createSessionStore(opened, client, cache);
  return {
    store,
    workTreeDiffDocument,
    /** 다음 조회부터 다른 내용(revision)을 돌려준다 */
    changeContent: (next: string) => {
      revision = next;
    },
  };
}

/** 마이크로태스크를 비운다 */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe('작업 트리 diff 의 조용한 재조회 (D-5)', () => {
  it('다른 파일만 바뀐 status 이벤트는 다시 묻지만, 같은 문서면 diff·읽는 중 상태를 건드리지 않는다', async () => {
    const { store, workTreeDiffDocument } = setup();
    await store.getState().openFile('f.txt', false);
    const shown = store.getState().diffDocument;
    expect(shown?.revision).toBe('r1');
    const seen: string[] = [];
    const off = store.subscribe((now, before) => {
      if (now.diffDocument !== before.diffDocument) seen.push('diffDocument');
      if (now.diff !== before.diff) seen.push('diff');
      if (now.diffLoading !== before.diffLoading) seen.push('diffLoading');
    });

    // 다른 파일(h.txt)이 새로 바뀌었다: 보던 f.txt 의 항목은 그대로
    store.getState().applyEvent({
      type: 'statusChanged',
      session: 1,
      status: statusOf([modified('f.txt'), modified('g.txt'), modified('h.txt')]),
      op: null,
    });
    await flush();
    expect(workTreeDiffDocument).toHaveBeenCalledTimes(2);
    expect(seen).toEqual([]);
    expect(store.getState().diffDocument).toBe(shown);
    off();
  });

  it('보던 파일의 내용만 바뀌었으면(항목은 그대로) 그 재조회와 편집기 저장이 새 문서를 넣는다', async () => {
    const { store, changeContent } = setup();
    await store.getState().openFile('f.txt', false);
    // 바깥에서 f.txt 를 고치고 같은 때에 다른 파일도 바뀌었다 (status 이벤트는 다른 파일 때문에 온다)
    changeContent('r2');
    store.getState().applyEvent({
      type: 'statusChanged',
      session: 1,
      status: statusOf([modified('f.txt')]),
      op: null,
    });
    await flush();
    expect(store.getState().diffDocument?.revision).toBe('r2');
    expect(store.getState().diffLoading).toBe(false);

    // 편집기 저장 뒤의 명시적 갱신 (`refreshEditedFile` → `reloadWorkingFile`)
    changeContent('r3');
    await store.getState().reloadWorkingFile('f.txt');
    expect(store.getState().diffDocument?.revision).toBe('r3');
  });
});
