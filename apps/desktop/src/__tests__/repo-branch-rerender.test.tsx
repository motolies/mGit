// W22 (W18 ② 가 넘긴 것): 저장소 탭에서 로그 행을 고르거나 status 가 바뀌어도 브랜치 트리가 다시 그려지지 않는다.
// `BranchTree` 를 같은 memo 규칙의 계수기로 감싸 "트리가 다시 그려졌는가"(받은 props 가 얕게 달라졌는가)를 센다 —
// 컨테이너가 노드 배열·콜백을 안정하게 넘기는지를 본다.

import type { GraphViewProps } from '@mgit/graph-view';
import { createMockClient, GraphRangeCache, type SessionId } from '@mgit/ipc';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import type { BranchTreeProps } from '../features/branches/BranchTree';
import { useAppStore } from '../store';
import { createRepoWorkspace, DEFAULT_DOCK, sessionRevealHooks } from '../store/app-store';
import {
  clearSessionRegistry,
  disposeWorkspace,
  registerSession,
  registerWorkspace,
} from '../store/session-registry';
import { createSessionStore } from '../store/session-store';
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

const REPO = '/mock/storefront-web';
const originalClient = useAppStore.getState().client;
let mounted: SessionId[] = [];

/** 저장소 탭을 열고 앱 전체를 그린다 (Git 도구 창의 로그 탭). 생성 때 읽기가 끝날 때까지 기다린다 */
async function mountRepo() {
  const mock = createMockClient({ rows: 60, scene: 'repo', progressIntervalMs: 0 });
  const opened = await mock.openRepo(REPO, () => {});
  const id = opened.session;
  mounted.push(id);
  const cache = new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('x')) });
  const store = createSessionStore(
    opened,
    mock,
    cache,
    sessionRevealHooks(useAppStore.getState, id),
  );
  store.setState({ loadState: 'complete', totalRows: 60 });
  registerSession(id, { cache, store });
  registerWorkspace(id, createRepoWorkspace(id, useAppStore.getState));
  act(() =>
    useAppStore.setState({
      sessions: { [id]: { id, kind: 'repo', path: REPO, name: 'storefront-web', parent: null } },
      sessionOrder: [id],
      activeSessionId: id,
      dock: DEFAULT_DOCK,
      leftTool: 'project',
      client: mock,
      conflictLeave: null,
    }),
  );
  render(<App />);
  await tick();
  await act(async () => {
    await store.getState().loadBackups();
    await store.getState().loadRadar();
  });
  await tick();
  await tick();
  return { id, store };
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
      conflictLeave: null,
    }),
  );
  for (const id of mounted) {
    disposeWorkspace(id);
  }
  mounted = [];
  clearSessionRegistry();
});

describe('브랜치 트리 재렌더 (W18 ② → W22)', () => {
  it('로그 행 선택·status 변경·WIP 선택에는 다시 그려지지 않고, ref 가 바뀌면 다시 그린다', async () => {
    const { id, store } = await mountRepo();
    expect(h.renders).toBeGreaterThan(0);
    const base = h.renders;
    const oids = store
      .getState()
      .refs.labels.slice(0, 3)
      .map((l) => l.target);
    // 로그에서 행을 세 번 고른다 (상세가 바뀐다)
    for (const oid of oids) {
      act(() => store.getState().selectCommit(oid));
      await tick();
    }
    // status 가 바뀐다 (작업 트리 변경 수)
    const status = store.getState().status;
    act(() =>
      store.getState().applyEvent({
        type: 'statusChanged',
        session: id,
        status: {
          ...status,
          summary: { ...status.summary, unstaged: status.summary.unstaged + 3 },
        },
        op: null,
      }),
    );
    await tick();
    act(() => store.getState().selectWip());
    await tick();
    expect(h.renders).toBe(base);

    // 계수기가 살아 있는지: ref 가 바뀌면(브랜치 삭제 등) 다시 그린다
    const refs = store.getState().refs;
    act(() =>
      store.getState().applyEvent({
        type: 'refsChanged',
        session: id,
        refs: { ...refs, labels: refs.labels.slice(1) },
      }),
    );
    await tick();
    expect(h.renders).toBeGreaterThan(base);
  });
});
