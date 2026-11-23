import { describe, expect, it, vi } from 'vitest';
import type { FileTarget } from '../store/session-store';
import {
  createWorkspaceStore,
  fileViewDoc,
  OVERVIEW_DOC,
  type SessionDocTarget,
  worktreeDiffDoc,
  worktreeDiffDocId,
  worktreeDiffDocs,
} from '../store/workspace-store';

const API = '/f/api';
const WEB = '/f/web';

/** 작업 트리 diff 문서 요청 */
const diffDoc = (repoPath: string, path: string, staged = false) =>
  worktreeDiffDoc({ repoPath, repoName: repoPath.split('/').pop() ?? '', path, staged });

describe('작업 트리 diff 문서의 파생 (W14, 계획 5.2: 저장하지 않고 세션 슬롯에서)', () => {
  it('장부의 저장소마다 그 세션의 "지금 고른 파일" 이 작업 트리 파일이면 문서 하나 (커밋·범위 diff·빈 슬롯은 없음)', () => {
    const slots: Record<number, FileTarget | null> = {
      1: { path: 'src/a.ts', staged: false, commit: null },
      2: { path: 'b.ts', staged: true, commit: null },
      3: { path: 'c.ts', staged: false, commit: 'abc' },
      4: null,
      5: {
        path: 'd.ts',
        staged: false,
        commit: null,
        range: { base: 'x', newer: 'y', label: 'x..y' },
      },
    };
    const ledger = {
      [API]: { session: 1, held: true, usedAt: 1 },
      [WEB]: { session: 2, held: false, usedAt: 2 },
      '/f/c': { session: 3, held: true, usedAt: 3 },
      '/f/d': { session: 4, held: true, usedAt: 4 },
      '/f/e': { session: 5, held: true, usedAt: 5 },
      '/f/gone': { session: 9, held: true, usedAt: 6 },
    };
    const docs = worktreeDiffDocs(
      ledger,
      (s) => (s in slots ? { selectedFile: slots[s] ?? null } : null),
      (repo) => `name:${repo}`,
    );
    expect(docs).toEqual([
      {
        kind: 'worktreeDiff',
        id: worktreeDiffDocId(API),
        repoPath: API,
        repoName: `name:${API}`,
        path: 'src/a.ts',
        staged: false,
      },
      {
        kind: 'worktreeDiff',
        id: worktreeDiffDocId(WEB),
        repoPath: WEB,
        repoName: `name:${WEB}`,
        path: 'b.ts',
        staged: true,
      },
    ]);
    // 저장소당 하나: 같은 저장소의 다른 파일이면 id 가 같다 (같은 탭의 내용이 바뀐다)
    expect(diffDoc(API, 'x').id).toBe(diffDoc(API, 'y').id);
  });
});

describe('워크스페이스의 세션 문서 (W14)', () => {
  it('새 세션 문서는 탭 막대 끝에 붙고 활성화하지 않는다. revealDoc 이 활성화하고 최대화를 푼다, 활성 저장소가 따라간다', () => {
    const onDocOpened = vi.fn();
    const ws = createWorkspaceStore('folder', { onDocOpened });
    ws.getState().setSessionDocs([diffDoc(API, 'a.ts')]);
    expect(ws.getState().docs.map((d) => d.id)).toEqual([OVERVIEW_DOC.id]);
    expect(ws.getState().sessionDocs.map((d) => [d.id, d.pinned])).toEqual([
      [worktreeDiffDocId(API), true],
    ]);
    expect(ws.getState().activeDocId).toBe(OVERVIEW_DOC.id);
    expect(onDocOpened).not.toHaveBeenCalled();

    ws.getState().revealDoc(worktreeDiffDocId(API));
    expect(ws.getState().activeDocId).toBe(worktreeDiffDocId(API));
    expect(ws.getState().activeRepo).toBe(API);
    expect(onDocOpened).toHaveBeenCalledTimes(1);
    // 없는 문서는 보이지 않는다
    ws.getState().revealDoc('worktreeDiff:/nope');
    expect(ws.getState().activeDocId).toBe(worktreeDiffDocId(API));
  });

  it('같은 목록이면 상태를 바꾸지 않는다 (세션 상태가 바뀔 때마다 탭 막대를 다시 그리지 않게)', () => {
    const ws = createWorkspaceStore('folder');
    ws.getState().setSessionDocs([diffDoc(API, 'a.ts')]);
    const before = ws.getState();
    ws.getState().setSessionDocs([diffDoc(API, 'a.ts')]);
    expect(ws.getState()).toBe(before);
    ws.getState().setSessionDocs([diffDoc(API, 'b.ts')]);
    expect(ws.getState().sessionDocs[0]).toMatchObject({ path: 'b.ts' });
  });

  it('보던 세션 문서가 사라지면 직전에 보던 문서로 돌아가고, 본 순서에서도 빠진다', () => {
    const ws = createWorkspaceStore('folder');
    ws.getState().openDoc(
      fileViewDoc({ path: 'web/x.ts', name: 'x.ts', repoPath: WEB, repoName: 'web' }),
      'pinned',
    );
    ws.getState().setSessionDocs([diffDoc(API, 'a.ts')]);
    ws.getState().revealDoc(worktreeDiffDocId(API));
    ws.getState().setSessionDocs([]);
    expect(ws.getState().activeDocId).toBe('file:web/x.ts');
    expect(ws.getState().recentDocIds).not.toContain(worktreeDiffDocId(API));
    // 활성 저장소도 돌아간 문서를 따라간다
    expect(ws.getState().activeRepo).toBe(WEB);
  });

  it('세션 문서를 닫으면 저장하지 않으므로 직접 빼지 않고 그 문서의 세션 슬롯을 비우게 알린다', () => {
    const closeSessionDoc = vi.fn<(doc: SessionDocTarget) => void>();
    const ws = createWorkspaceStore('folder', { closeSessionDoc });
    ws.getState().setSessionDocs([diffDoc(API, 'a.ts'), diffDoc(WEB, 'b.ts')]);
    ws.getState().closeDoc(worktreeDiffDocId(WEB));
    expect(closeSessionDoc).toHaveBeenCalledTimes(1);
    expect(closeSessionDoc.mock.calls[0]?.[0]).toMatchObject({ repoPath: WEB, path: 'b.ts' });
    expect(ws.getState().sessionDocs).toHaveLength(2);
  });

  it('활성 저장소가 잠겨 있으면 다른 저장소의 diff 탭을 눌러도 탭만 바뀌고 활성 저장소는 그대로다', () => {
    let locked = false;
    const ws = createWorkspaceStore('folder', { activeRepoLocked: () => locked });
    ws.getState().setSessionDocs([diffDoc(API, 'a.ts'), diffDoc(WEB, 'b.ts')]);
    ws.getState().revealDoc(worktreeDiffDocId(API));
    expect(ws.getState().activeRepo).toBe(API);
    locked = true;
    ws.getState().activateDoc(worktreeDiffDocId(WEB));
    expect(ws.getState().activeDocId).toBe(worktreeDiffDocId(WEB));
    expect(ws.getState().activeRepo).toBe(API);
  });

  it('Commit 도구 창의 메시지·접힌 줄·스크롤을 기억한다 (도구 창을 번갈아 띄워도 남는다)', () => {
    const ws = createWorkspaceStore('folder');
    ws.getState().setCommitMessage('fix: 로그인');
    ws.getState().setCommitCollapsed(['r:/f/api']);
    ws.getState().rememberCommitScroll(120);
    expect(ws.getState().commitMessage).toBe('fix: 로그인');
    expect(ws.getState().commitCollapsed).toEqual(['r:/f/api']);
    expect(ws.getState().commitScrollTop()).toBe(120);
  });
});
