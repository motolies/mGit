import type { GraphRangeCache, SessionId } from '@mgit/ipc';
import type { SessionStore } from './session-store';
import type { WorkspaceStore } from './workspace-store';

/** 세션에 묶인 비직렬 객체. 앱 스토어 상태에 넣지 않고 따로 보관한다 */
export interface SessionResources {
  cache: GraphRangeCache;
  store: SessionStore;
}

const registry = new Map<SessionId, SessionResources>();

/** 세션 자원을 등록한다 */
export function registerSession(id: SessionId, resources: SessionResources): void {
  registry.set(id, resources);
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
}

/** 폴더 스토어를 얻는다. 닫힌 폴더면 undefined */
export function getFolderStore(id: SessionId): FolderStore | undefined {
  return folders.get(id);
}

/** 폴더 스토어를 해제한다 */
export function disposeFolder(id: SessionId): void {
  const store = folders.get(id);
  if (store) {
    store.getState().dispose();
    folders.delete(id);
  }
}

/** 탭별 워크스페이스 화면 상태 (에디터 탭·Project 선택). 저장하지 않는다 */
const workspaces = new Map<SessionId, WorkspaceStore>();

/** 탭의 워크스페이스 스토어를 등록한다 */
export function registerWorkspace(id: SessionId, store: WorkspaceStore): void {
  workspaces.set(id, store);
}

/** 탭의 워크스페이스 스토어를 얻는다. 닫힌 탭이면 undefined */
export function getWorkspaceStore(id: SessionId): WorkspaceStore | undefined {
  return workspaces.get(id);
}

/** 탭의 워크스페이스 상태를 버린다 */
export function disposeWorkspace(id: SessionId): void {
  workspaces.delete(id);
}
