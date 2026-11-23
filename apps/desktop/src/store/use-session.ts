// 화면이 세션·폴더·워크스페이스 스토어를 구독하는 훅. React context 를 쓰지 않고 모두 앱 스토어에서 파생한다 —
// 전역 동작·단축키(`App()` 본문의 `useActions`·`useGlobalShortcuts`)가 Provider 밖에서 부르기 때문이다 (계획 5.1).
//
// 세션 훅의 두 가지 뜻을 이름으로 가른다 (W13):
// - `useIsRepoTab()`: 활성 탭이 저장소 탭인가. 저장소 탭 전용 화면·동작·단축키(툴바 동기화·undo, 상태 바의 세션 줄,
//   동작 레지스트리, 그 밖의 세션 대화상자)는 이것으로 켠다 — 폴더 탭의 숨은 세션에 대고 동작하지 않게.
// - `useHasSession()`·`useSession()`: 범위 세션(저장소 탭의 세션, 폴더 탭은 활성 저장소의 숨은 세션)이 있는가·그 상태.
//   폴더 탭에서 켜도 되는 것(허용 목록: 파일 히스토리·blame 대화상자, 세션 오류 줄)만 이것으로 켠다.

import { createNullClient, emptyRepoState, GraphRangeCache, type SessionId } from '@mgit/ipc';
import { useCallback, useRef, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { shallow, useShallow } from 'zustand/shallow';
import { activeTabKind, type TabKind } from './app-store';
import { useAppStore } from './app-store-instance';
import type { FileTreeState } from './file-tree';
import { createFolderStore, type FolderState } from './folder-store';
import { type RepoSessionLedger, scopeSessionId } from './repo-sessions';
import { getFolderStore, getSessionStore, getWorkspaceStore } from './session-registry';
import { createSessionStore, type SessionState } from './session-store';
import { createWorkspaceStore, type WorkspaceState } from './workspace-store';

/** 활성 세션이 없을 때 구독할 빈 스토어 (훅 호출 순서를 고정하기 위해) */
const NULL_STORE = createSessionStore(
  {
    session: 0,
    alreadyOpen: false,
    nestedRepos: [],
    superproject: null,
    info: {
      workTree: '',
      gitDir: '',
      commonDir: '',
      objectFormat: 'sha1',
      head: { state: 'unborn', branch: '' },
      commitGraph: { present: false },
      shallow: false,
    },
    state: emptyRepoState({ state: 'unborn', branch: '' }),
  },
  createNullClient(),
  new GraphRangeCache({ fetchWindow: () => Promise.reject(new Error('no session')) }),
);

/** 폴더 탭이 없을 때 구독할 빈 폴더 스토어 */
const NULL_FOLDER = createFolderStore({ session: 0, path: '', repos: [] }, createNullClient());

/** 파일 트리가 없는 탭에서 구독할 빈 파일 트리 (빈 폴더 스토어의 것 — 읽기를 시작하지 않는다) */
const NULL_FILE_TREE = NULL_FOLDER.getState().fileTree;

/** 워크스페이스가 없는 탭에서 구독할 빈 워크스페이스 스토어 */
const NULL_WORKSPACE = createWorkspaceStore('repo');

/** 활성 탭의 id 와 종류 (화면 틀을 고를 때). 탭이 없으면 null */
export function useActiveTab(): { id: number; kind: TabKind } | null {
  return useAppStore(
    useShallow((s) => {
      const meta = s.activeSessionId === null ? undefined : s.sessions[s.activeSessionId];
      return meta ? { id: meta.id, kind: meta.kind } : null;
    }),
  );
}

/**
 * 활성 탭이 저장소 탭인지. 저장소 탭 전용 화면·동작·단축키의 조건이다 — 폴더 탭은 활성 저장소의 숨은 세션이 열려
 * 있어도 거짓이다
 */
export function useIsRepoTab(): boolean {
  return useAppStore((s) => activeTabKind(s) === 'repo');
}

/**
 * 범위 세션 id: 저장소 탭이면 그 탭의 세션, 폴더 탭이면 활성 저장소의 숨은 세션(장부에 있을 때만), 아니면 null.
 * 활성 저장소가 바뀌기만 해서는 세션이 생기지 않는다 (기능을 요청할 때만 앱 스토어가 연다)
 */
export function useScopeSessionId(): SessionId | null {
  const activeRepo = useWorkspace((w) => w.activeRepo) ?? null;
  return useAppStore((s) => {
    const meta = s.activeSessionId === null ? undefined : s.sessions[s.activeSessionId];
    return scopeSessionId({
      tab: meta ? { id: meta.id, kind: meta.kind } : null,
      ledgers: s.repoSessions,
      activeRepo,
    });
  });
}

/** 범위 세션 상태를 선택해 구독한다. 범위 세션이 없으면 빈 상태를 준다. 객체 selector 는 얕은 비교로 안정화된다 */
export function useSession<T>(selector: (s: SessionState) => T): T {
  return useSessionOf(useScopeSessionId(), selector);
}

/**
 * 정해 준 세션의 상태를 선택해 구독한다 (범위 세션이 아니라 문서가 가리키는 세션 — 폴더 탭의 작업 트리 diff 탭, W14).
 * 세션이 없으면(null·스토어 없음) 빈 상태를 준다. 객체 selector 는 얕은 비교로 안정화된다
 */
export function useSessionOf<T>(id: SessionId | null, selector: (s: SessionState) => T): T {
  const store = (id === null ? undefined : getSessionStore(id)) ?? NULL_STORE;
  return useStore(store, useShallow(selector));
}

/** 범위 세션이 있는지: 저장소 탭이면 참, 폴더 탭은 활성 저장소의 숨은 세션이 열려 있을 때만 참 */
export function useHasSession(): boolean {
  return useScopeSessionId() !== null;
}

/** 장부가 없을 때 쓰는 빈 장부 (같은 객체를 돌려 다시 그리지 않게) */
const EMPTY_LEDGER: RepoSessionLedger = {};

/** 폴더 탭의 장부 (W15). 폴더가 아니거나 장부가 없으면 빈 장부 */
export function useLedger(folder: SessionId | null): RepoSessionLedger {
  return useAppStore((s) =>
    folder === null ? EMPTY_LEDGER : (s.repoSessions[folder] ?? EMPTY_LEDGER),
  );
}

/**
 * 폴더 탭 장부의 세션들에서 고른 값 (W15 작업 띠·힌트): 저장소 경로 → `select` 결과. 장부가 바뀌거나 장부가 가리키는
 * 세션의 상태가 바뀌면 다시 그린다 — 고른 값이 저장소마다 얕은 비교로 모두 같으면 앞의 객체를 그대로 돌려준다. 스토어가
 * 없는 세션은 빠진다. `select` 는 새 객체를 만들어도 되지만 배열·객체 필드를 새로 만들면 매번 다르다고 본다
 */
export function useLedgerSessions<T extends object>(
  folder: SessionId | null,
  select: (st: SessionState) => T,
): Readonly<Record<string, T>> {
  const ledger = useLedger(folder);
  const selectRef = useRef(select);
  selectRef.current = select;
  const cache = useRef<Readonly<Record<string, T>>>({});
  const subscribe = useCallback(
    (notify: () => void) => {
      const offs = Object.values(ledger).flatMap((entry) => {
        const store = getSessionStore(entry.session);
        return store ? [store.subscribe(notify)] : [];
      });
      return () => {
        for (const off of offs) {
          off();
        }
      };
    },
    [ledger],
  );
  const getSnapshot = useCallback(() => {
    const next: Record<string, T> = {};
    for (const [repoPath, entry] of Object.entries(ledger)) {
      const st = getSessionStore(entry.session)?.getState();
      if (st) {
        next[repoPath] = selectRef.current(st);
      }
    }
    const prev = cache.current;
    const keys = Object.keys(next);
    const same =
      keys.length === Object.keys(prev).length &&
      keys.every((key) => prev[key] !== undefined && shallow(prev[key], next[key]));
    if (same) {
      return prev;
    }
    cache.current = next;
    return next;
  }, [ledger]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 활성 탭이 폴더면 그 폴더 상태를 구독한다. 아니면 null */
export function useFolder<T>(selector: (f: FolderState) => T): T | null {
  const id = useAppStore((s) => s.activeSessionId);
  const kind = useAppStore((s) =>
    s.activeSessionId === null ? null : s.sessions[s.activeSessionId]?.kind,
  );
  const store = id !== null && kind === 'folder' ? getFolderStore(id) : undefined;
  return useStore(
    store ?? NULL_FOLDER,
    useShallow((f) => (store ? selector(f) : null)),
  );
}

/** 활성 탭의 워크스페이스 화면 상태를 구독한다. 워크스페이스가 없는 탭이면 null */
export function useWorkspace<T>(selector: (w: WorkspaceState) => T): T | null {
  const id = useAppStore((s) => s.activeSessionId);
  const store = id === null ? undefined : getWorkspaceStore(id);
  return useStore(
    store ?? NULL_WORKSPACE,
    useShallow((w) => (store ? selector(w) : null)),
  );
}

/**
 * 활성 탭의 파일 트리(프로젝트 트리·파일 보기의 상태)를 구독한다. 폴더 탭은 폴더 스토어의 것(루트 = 폴더), 저장소 탭은
 * 그 탭 세션 스토어의 것(루트 = 작업 트리 하나, W21)이다. 없으면 null
 */
export function useFileTree<T>(selector: (t: FileTreeState) => T): T | null {
  const id = useAppStore((s) => s.activeSessionId);
  const kind = useAppStore((s) =>
    s.activeSessionId === null ? null : s.sessions[s.activeSessionId]?.kind,
  );
  const store =
    id === null
      ? undefined
      : kind === 'folder'
        ? getFolderStore(id)?.getState().fileTree
        : kind === 'repo'
          ? getSessionStore(id)?.getState().fileTree
          : undefined;
  return useStore(
    store ?? NULL_FILE_TREE,
    useShallow((t) => (store ? selector(t) : null)),
  );
}
