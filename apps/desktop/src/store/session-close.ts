import type { SessionId } from '@mgit/ipc';
import type { SessionMeta } from './app-store';

/** 상단 탭 닫기 범위: 이 탭(과 하위 탭) · 하위 탭만 · 이 탭 제외 · 모두 */
export type SessionCloseMode = 'this' | 'children' | 'others' | 'all';

export interface SessionClosePlan {
  target: SessionId;
  mode: SessionCloseMode;
  /** 확인 중 새로 열린 탭은 이 목록에 추가하지 않는다. */
  requested: readonly SessionId[];
  identities: Readonly<Record<SessionId, SessionMeta>>;
  targets: readonly SessionId[];
  protectedIds: readonly SessionId[];
  risks: readonly string[];
  signature: string;
}

/** `id` 가 `ancestor` 의 하위 탭(자식·손자…)인지. 열린 탭의 부모 사슬만 따르며 순환이면 멈춘다 */
function isDescendant(
  sessions: Readonly<Record<SessionId, SessionMeta>>,
  id: SessionId,
  ancestor: SessionId,
): boolean {
  const seen = new Set<SessionId>([id]);
  let parent = sessions[id]?.parent;
  while (parent !== null && parent !== undefined && !seen.has(parent)) {
    if (parent === ancestor) return true;
    seen.add(parent);
    parent = sessions[parent]?.parent;
  }
  return false;
}

/** 상단 탭 범위만 계산하며 child를 남기면 그 부모도 보존한다. 하위 탭만 닫기는 대상 탭을 남기고 그 아래를 모두 닫는다 */
export function sessionCloseTargets(
  order: readonly SessionId[],
  sessions: Readonly<Record<SessionId, SessionMeta>>,
  target: SessionId,
  mode: SessionCloseMode,
): SessionId[] {
  if (!sessions[target]) return [];
  if (mode === 'all') return order.filter((id) => sessions[id]);
  if (mode === 'this')
    return order.filter((id) => id === target || sessions[id]?.parent === target);
  if (mode === 'children')
    return order.filter((id) => sessions[id] && isDescendant(sessions, id, target));
  const keep = new Set<SessionId>([target]);
  let parent = sessions[target]?.parent;
  while (parent !== null && parent !== undefined && !keep.has(parent)) {
    keep.add(parent);
    parent = sessions[parent]?.parent ?? null;
  }
  return order.filter((id) => sessions[id] && !keep.has(id));
}
