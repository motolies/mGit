import type { SessionId } from '@mgit/ipc';
import type { SessionMeta } from './app-store';

export type SessionCloseMode = 'this' | 'others' | 'all';

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

/** 상단 탭 범위만 계산하며 child를 남기면 그 부모도 보존한다. */
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
  const keep = new Set<SessionId>([target]);
  let parent = sessions[target]?.parent;
  while (parent !== null && parent !== undefined && !keep.has(parent)) {
    keep.add(parent);
    parent = sessions[parent]?.parent ?? null;
  }
  return order.filter((id) => sessions[id] && !keep.has(id));
}
