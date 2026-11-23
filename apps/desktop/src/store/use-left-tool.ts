// Pull Requests 도구 창을 지금 보일 수 있는지와, 그에 따라 지금 보이는 왼쪽 도구 창 (W24, WS-17). 왼쪽 도구 창의 저장된
// 값(`leftTool`, 앱 전역 1벌)과 화면에 보이는 것을 `effectiveLeftTool` 이 가른다 — 띠·왼쪽 자리(저장소·폴더 탭)가 모두
// 이 훅으로 같은 값을 본다. 띠 단추의 접기(`toggleLeftTool`)는 같은 판단을 앱 스토어에서 그 순간의 세션 상태로 한다.
// 화면 틀(앱·폴더·저장소 워크스페이스)이 기능 폴더(`features/hosting`)를 거치지 않게 스토어 쪽에 둔다 (W28)

import type { RemoteProject } from '@mgit/ipc';
import { activeTabKind, effectiveLeftTool, type LeftTool } from './app-store';
import { useAppStore } from './app-store-instance';
import { useSessionOf } from './use-session';

/**
 * 활성 탭이 저장소 탭이고 그 세션에 원격 프로젝트가 있으면 그 호스팅 종류(GitHub/GitLab), 아니면 null. 계정 연결 여부와
 * 무관하다 (도구 창 안에서 계정 연결을 안내한다). 폴더 탭은 활성 저장소의 숨은 세션이 있어도 null 이다
 */
export function useActivePrKind(): RemoteProject['kind'] | null {
  const repoTab = useAppStore((s) => (activeTabKind(s) === 'repo' ? s.activeSessionId : null));
  return useSessionOf(repoTab, (st) => st.remoteProject?.kind ?? null);
}

/** 지금 보이는 왼쪽 도구 창 (접혀 있으면 null). 저장된 값이 Pull Requests 여도 보일 수 없는 탭이면 Project 다 */
export function useShownLeftTool(): LeftTool | null {
  const leftTool = useAppStore((s) => s.leftTool);
  const prKind = useActivePrKind();
  return effectiveLeftTool(leftTool, prKind !== null);
}
