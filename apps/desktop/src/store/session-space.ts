// 세션의 파일 경로 공간 찾기 (MR-13 준비, M0b). 공간은 세션 키가 정한다: 디렉터리 세션(저장소·폴더, 키 = 절대 경로)은
// 그 디렉터리 하나이고 — 스토어의 `space` 와 같은 값이다 — 가상 그룹(키 `mgit-group:<id>`)만 폴더 스토어가 든 그룹
// 공간이 필요하다. 탭 정보(앱 스토어)만 있는 화면과 스토어만 있는 곳(숨은 가벼운 세션·파일 작업)이 같은 규칙으로 찾는다.

import type { SessionId } from '@mgit/ipc';
import { dirSpace, isGroupKey, type RootSpace } from './root-space';
import { getFolderStore, getSessionStore } from './session-registry';

/**
 * 탭(세션 id, 키)의 경로 공간. 디렉터리 키는 그 디렉터리이고 스토어를 거치지 않는다 (탭 정보를 구독하는 화면이 그대로
 * 다시 그려진다). 그룹 키는 등록된 폴더 스토어의 공간이고, 스토어가 없으면 null
 */
export function tabSpace(id: SessionId, key: string): RootSpace | null {
  return isGroupKey(key) ? (getFolderStore(id)?.getState().space ?? null) : dirSpace(key);
}

/**
 * 세션 id 의 경로 공간 (저장소·가벼운·폴더 세션): 등록된 스토어의 키로 `tabSpace` 를 찾는다. 세션 파일 API 의 상대
 * 경로를 절대 경로로 바꾸거나 그 반대에 쓴다. 닫힌 세션이면 null
 */
export function spaceOf(id: SessionId): RootSpace | null {
  const key = getSessionStore(id)?.getState().path ?? getFolderStore(id)?.getState().path;
  return key === undefined ? null : tabSpace(id, key);
}
