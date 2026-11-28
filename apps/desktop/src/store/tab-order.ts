import type { SessionId } from '@mgit/ipc';
import type { SessionMeta } from './app-store';

// 저장소 탭 세트 (폴더·저장소 탭과 거기서 연 하위 탭). 상단 탭 줄·방향키 이동·탭 목록·저장 순서가 모두 하나의
// `sessionOrder` 를 따르므로, 세트를 붙여 두는 일은 그 순서를 다시 묶는 순수 함수로 한다. 화면은 순서를 바꾸지 않고
// 이어진 같은 세트를 감싸기만 한다 (화면 순서와 키 순서가 어긋나지 않는다)

type Sessions = Readonly<Record<SessionId, SessionMeta>>;

/** 재시작 뒤 하위 탭의 부모를 되살리는 설정 키. 값은 `{ 자식 탭 경로: 부모 탭 경로 }` */
export const PREF_TAB_PARENTS = 'mgit.tabs.parents';

/** 화면에 그릴 탭 묶음 하나. 단독 탭은 `ids` 가 하나다 */
export interface TabSet {
  root: SessionId;
  ids: SessionId[];
}

/**
 * 탭의 최상위 조상. 열린 탭 안에서만 부모를 따라 오르므로 닫힌 부모에서 멈춘다(바로 위 부모가 닫혔으면 자기 자신).
 * 부모 관계가 돌면 자기 자신을 돌려준다
 */
export function tabRoot(id: SessionId, sessions: Sessions): SessionId {
  const seen = new Set<SessionId>([id]);
  let at = id;
  for (;;) {
    const parent = sessions[at]?.parent;
    if (parent === null || parent === undefined || !sessions[parent]) return at;
    if (seen.has(parent)) return id;
    seen.add(parent);
    at = parent;
  }
}

/**
 * 같은 루트의 탭이 이어지도록 순서를 안정적으로 다시 묶는다. 묶음 순서는 처음 등장한 순서이고, 묶음 안에서는 루트가
 * 먼저이며 나머지는 기존 순서를 따르되 부모를 자식보다 앞에 둔다 (저장 순서대로 다시 열 때 부모가 먼저 열린다)
 */
export function groupTabOrder(order: readonly SessionId[], sessions: Sessions): SessionId[] {
  const groups = new Map<SessionId, SessionId[]>();
  for (const id of order) {
    const root = tabRoot(id, sessions);
    const members = groups.get(root);
    if (members) members.push(id);
    else groups.set(root, [id]);
  }
  const out: SessionId[] = [];
  for (const members of groups.values()) {
    const inGroup = new Set(members);
    const placed = new Set<SessionId>();
    // 묶음 안의 부모부터 놓는다. 루트까지의 사슬은 tabRoot 가 순환 없이 끝난 것이라 멈춘다
    const place = (id: SessionId) => {
      if (placed.has(id)) return;
      placed.add(id);
      const parent = sessions[id]?.parent;
      if (parent !== null && parent !== undefined && inGroup.has(parent)) place(parent);
      out.push(id);
    };
    for (const id of members) place(id);
  }
  return out;
}

/**
 * 화면에 그릴 탭 묶음. 순서는 그대로 두고 이어진 같은 루트의 탭을 한 묶음으로 모은다 (세션이 없는 id 는 건너뛴다).
 * `groupTabOrder` 를 거친 순서면 루트마다 묶음이 하나다
 */
export function tabSets(order: readonly SessionId[], sessions: Sessions): TabSet[] {
  const sets: TabSet[] = [];
  for (const id of order) {
    if (!sessions[id]) continue;
    const root = tabRoot(id, sessions);
    const last = sets.at(-1);
    if (last && last.root === root) last.ids.push(id);
    else sets.push({ root, ids: [id] });
  }
  return sets;
}

/** 저장할 부모 경로 맵 `{ 자식 경로: 부모 경로 }`. 부모 탭이 지금 열려 있는 탭만 담아 매번 새로 만든다 */
export function tabParentPaths(
  order: readonly SessionId[],
  sessions: Sessions,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const id of order) {
    const meta = sessions[id];
    const parent =
      meta?.parent === null || meta?.parent === undefined ? undefined : sessions[meta.parent];
    if (meta && parent) map[meta.path] = parent.path;
  }
  return map;
}
