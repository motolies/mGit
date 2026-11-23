// W27 (W22 가 넘긴 판단, 성능): 폴더 탭에서 로그 행을 골라도 브랜치 트리(행 240~300 컴포넌트)가 다시 그려지지 않는다.
// 저장소 탭의 `repo-branch-rerender.test.tsx` 와 같은 방식 — `BranchTree` 를 같은 memo 규칙의 계수기로 감싸 "받은 props 가
// 얕게 달라졌는가"를 센다. 전에는 `FolderTimeline` 이 트리 콜백(활성화·열기·메뉴·즐겨찾기)을 그릴 때마다 새로 만들었다.

import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, type SessionId } from '@mgit/ipc';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { BranchTreeProps } from '../features/branches/BranchTree';
import { getFolderStore, useAppStore } from '../store';
import { DEFAULT_DOCK } from '../store/app-store';
import { createFolderStore, timelineRepoPath } from '../store/folder-store';
import {
  clearSessionRegistry,
  disposeFolder,
  disposeWorkspace,
  registerFolder,
  registerWorkspace,
} from '../store/session-registry';
import { createWorkspaceStore } from '../store/workspace-store';
import { installDialogStub, removeDialogStub, tick } from './dialog-stub';

const h = vi.hoisted(() => ({ renders: 0 }));

// 브랜치 트리를 같은 memo 규칙의 계수기로 감싼다: props 가 얕게 같으면 감싼 쪽도 다시 그리지 않는다
vi.mock('../features/branches/BranchTree', async (orig) => {
  const mod = await orig<typeof import('../features/branches/BranchTree')>();
  const { createElement, memo } = await import('react');
  return {
    ...mod,
    BranchTree: memo((props: BranchTreeProps) => {
      h.renders += 1;
      return createElement(mod.BranchTree, props);
    }),
  };
});
vi.mock('@mgit/graph-view', async (orig) => ({
  ...(await orig<typeof import('@mgit/graph-view')>()),
  GraphView: (_props: GraphViewProps) => <div data-testid="graph-view" />,
}));
vi.mock('@mgit/terminal', () => ({ TerminalView: () => <div data-testid="term" /> }));
vi.mock('../features/home/HomeScreen', () => ({ HomeScreen: () => <div data-testid="home" /> }));

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 1200 });
});

const FOLDER = '/mock/acme-platform';
const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/** 폴더 탭을 등록하고 앱 전체를 그린다 (Git 도구 창의 로그 탭). 브랜치 목록·타임라인 읽기가 끝날 때까지 기다린다 */
async function mountFolder() {
  const mock = createMockClient({ rows: 60, scene: 'folder', progressIntervalMs: 0 });
  const opened = await mock.openFolder(FOLDER, (e) =>
    getFolderStore(e.session)?.getState().applyEvent(e),
  );
  const id = opened.session;
  mounted.push(id);
  registerFolder(id, createFolderStore(opened, mock));
  registerWorkspace(id, createWorkspaceStore('folder'));
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'folder', path: FOLDER, name: 'acme-platform', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      client: mock,
      repoSessions: {},
      repoSessionOpening: {},
    }),
  );
  render(<App />);
  for (let i = 0; i < 4; i++) {
    await tick();
  }
  return { id, folder: () => getFolderStore(id)?.getState() };
}

beforeEach(() => {
  localStorage.clear();
  installDialogStub();
  h.renders = 0;
});

afterEach(() => {
  cleanup();
  removeDialogStub();
  act(() =>
    useAppStore.setState({
      sessions: {},
      sessionOrder: [],
      activeSessionId: null,
      client: originalClient,
      toasts: [],
      repoSessions: {},
      repoSessionOpening: {},
    }),
  );
  for (const id of mounted) {
    disposeFolder(id);
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('폴더 탭 브랜치 트리 재렌더 (W22 → W27)', () => {
  it('로그 행을 세 번 골라도 다시 그려지지 않고, 브랜치 목록·질의가 바뀌면 다시 그린다', async () => {
    const { id, folder } = await mountFolder();
    expect(folder()?.branches).not.toBeNull();
    expect(h.renders).toBeGreaterThan(0);
    await act(async () => {
      await folder()?.timeline.cache.ensureRange(0, 3);
    });
    await tick();
    const base = h.renders;
    const rows = folder()?.timeline.cache.slice(0, 3).rows ?? [];
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      const repoPath = timelineRepoPath(folder()?.timeline.info ?? null, row?.repo) ?? '';
      await act(async () => {
        folder()?.selectTimelineRow(repoPath, row?.oid ?? '');
      });
      await tick();
    }
    expect(folder()?.timeline.selected?.oid).toBe(rows[2]?.oid);
    expect(h.renders).toBe(base);

    // 계수기가 살아 있는지: 브랜치 목록이 바뀌면(fetch·checkout 뒤) 다시 그린다
    const list = folder()?.branches;
    if (!list) {
      throw new Error('브랜치 목록 없음');
    }
    act(() =>
      getFolderStore(id)?.setState({ branches: { ...list, branches: list.branches.slice(1) } }),
    );
    await tick();
    expect(h.renders).toBeGreaterThan(base);
  });
});
