import type { GraphRangeCache, SessionId } from '@mgit/ipc';
import { fileEditors } from './file-editor-store';
import type { SessionStore } from './session-store';
import type { WorkspaceStore } from './workspace-store';

/** 세션에 묶인 비직렬 객체. 앱 스토어 상태에 넣지 않고 따로 보관한다 */
export interface SessionResources {
  cache: GraphRangeCache;
  store: SessionStore;
}

const registry = new Map<SessionId, SessionResources>();
const editorWatches = new Map<SessionId, () => void>();

/** 감시 이벤트가 폴더·저장소 양쪽에서 연 현재 파일에 전달되게 한다. */
function refreshEditors(): void {
  for (const id of [...registry.keys(), ...folders.keys()]) {
    void fileEditors.refreshSession(id);
  }
}

/**
 * 저장 성공 후 같은 실제 경로를 보는 모든 작업 트리 diff를 갱신한다. 저장한 세션의 경로 공간으로 실제 경로를 얻고, 저장소
 * 세션마다 그 작업 트리 기준 경로로 되돌린다
 */
export async function refreshEditedFile(id: SessionId, path: string): Promise<void> {
  const space = registry.get(id)?.store.getState().space ?? folders.get(id)?.getState().space;
  const absolute = space?.toAbs(path);
  if (!absolute) return;
  await Promise.all(
    [...registry.values()].map(({ store }) => {
      const state = store.getState();
      const relative = state.space.toRel(absolute);
      return relative === null ? Promise.resolve() : state.reloadWorkingFile(relative);
    }),
  );
}

/** 세션 자원을 등록한다 */
export function registerSession(id: SessionId, resources: SessionResources): void {
  registry.set(id, resources);
  editorWatches.get(id)?.();
  const offState = resources.store.subscribe((now, before) => {
    if (now.status !== before.status || now.refs !== before.refs) refreshEditors();
  });
  const offTree = resources.store.getState().fileTree.subscribe((now, before) => {
    if (now.epoch !== before.epoch) void fileEditors.refreshSession(id);
  });
  editorWatches.set(id, () => {
    offState();
    offTree();
  });
}

/** 세션의 그래프 캐시를 얻는다. 닫힌 세션이면 undefined */
export function getSessionCache(id: SessionId): GraphRangeCache | undefined {
  return registry.get(id)?.cache;
}

/** 세션 스토어를 얻는다. 닫힌 세션이면 undefined */
export function getSessionStore(id: SessionId): SessionStore | undefined {
  return registry.get(id)?.store;
}

/** 세션 자원을 해제하고 등록을 지운다 */
export function disposeSession(id: SessionId): void {
  editorWatches.get(id)?.();
  editorWatches.delete(id);
  const entry = registry.get(id);
  if (entry) {
    entry.cache.dispose();
    registry.delete(id);
  }
}

/** 테스트용: 모든 세션 자원을 해제한다 */
export function clearSessionRegistry(): void {
  for (const id of [...registry.keys()]) {
    disposeSession(id);
  }
}

import type { FolderStore } from './folder-store';

const folders = new Map<SessionId, FolderStore>();

/** 폴더 스토어를 등록한다 */
export function registerFolder(id: SessionId, store: FolderStore): void {
  folders.set(id, store);
  editorWatches.get(id)?.();
  const offState = store.subscribe((now, before) => {
    if (now.summaries !== before.summaries) void fileEditors.refreshSession(id);
  });
  const offTree = store.getState().fileTree.subscribe((now, before) => {
    if (now.epoch !== before.epoch) void fileEditors.refreshSession(id);
  });
  editorWatches.set(id, () => {
    offState();
    offTree();
  });
}

/** 폴더 스토어를 얻는다. 닫힌 폴더면 undefined */
export function getFolderStore(id: SessionId): FolderStore | undefined {
  return folders.get(id);
}

/** 폴더 스토어를 해제한다 */
export function disposeFolder(id: SessionId): void {
  editorWatches.get(id)?.();
  editorWatches.delete(id);
  const store = folders.get(id);
  if (store) {
    store.getState().dispose();
    folders.delete(id);
  }
}

/** 탭별 워크스페이스 화면 상태 (에디터 탭·Project 선택). 저장하지 않는다 */
const workspaces = new Map<SessionId, WorkspaceStore>();
const workspaceWatches = new Map<SessionId, () => void>();

/** 탭의 워크스페이스 스토어를 등록한다 */
export function registerWorkspace(id: SessionId, store: WorkspaceStore): void {
  workspaces.set(id, store);
  workspaceWatches.get(id)?.();
  workspaceWatches.set(
    id,
    store.subscribe((now, before) => {
      if (now.docs === before.docs && now.split === before.split) return;
      // 두 편집기 그룹(R3) 어디에도 남지 않은 파일 탭만 편집 문서를 놓는다
      const open = (id: string) =>
        now.docs.some((item) => item.id === id) ||
        (now.split?.docs.some((item) => item.id === id) ?? false);
      for (const doc of [...before.docs, ...(before.split?.docs ?? [])]) {
        if (doc.kind === 'file' && !open(doc.id)) {
          fileEditors.release(id, doc.path);
        }
      }
    }),
  );
}

/** 탭의 워크스페이스 스토어를 얻는다. 닫힌 탭이면 undefined */
export function getWorkspaceStore(id: SessionId): WorkspaceStore | undefined {
  return workspaces.get(id);
}

/** 탭의 워크스페이스 상태를 버린다 */
export function disposeWorkspace(id: SessionId): void {
  workspaceWatches.get(id)?.();
  workspaceWatches.delete(id);
  workspaces.delete(id);
}

/**
 * 파일 작업이 모든 열린 Project의 문서와 트리를 함께 갱신할 때 사용하는 세션 목록이다. `root` 는 세션 키(디렉터리 탭은 루트
 * 절대 경로)이고, 경로 변환은 그 키의 공간(`tabSpace`)으로 한다
 */
export function fileWorkspaceSessions() {
  return [...workspaces.entries()].flatMap(([id, workspace]) => {
    const repo = registry.get(id)?.store.getState();
    const folder = folders.get(id)?.getState();
    const state = repo ?? folder;
    const repoPaths = repo
      ? [repo.path, ...repo.nestedRepos]
      : (folder?.repos.map((item) => item.path) ?? []);
    return state
      ? [
          {
            id,
            workspace,
            root: state.path,
            tree: state.fileTree,
            refresh: state.refresh,
            repoPaths,
          },
        ]
      : [];
  });
}
