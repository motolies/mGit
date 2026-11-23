// 브랜치 트리의 공용 노드 모델과 순수 함수 (BT-12). 어느 스토어의 데이터인지 모른다 —
// 빌더(폴더: `buildFolderBranchTree`, 저장소: W22)가 자기 데이터를 이 모양으로 바꿔 준다.

/** 노드 종류. 그룹·폴더는 자식을 갖고 나머지는 잎이다 */
export type BranchNodeKind =
  | 'head'
  | 'group'
  | 'folder'
  | 'local'
  | 'remote'
  | 'tag'
  | 'worktree'
  | 'backup';

/** 업스트림과의 차이 */
export interface BranchTrack {
  ahead: number;
  behind: number;
  /** 업스트림이 원격에서 사라졌는지 */
  gone: boolean;
}

/** 행 끝의 작은 표시 (아이콘 + 툴팁) */
export interface BranchBadge {
  icon: 'worktree' | 'radarOk' | 'radarConflict';
  text?: string;
  title: string;
}

/**
 * 트리의 노드 하나. `id` 는 선택·펼침 상태의 키이고 `fullName` 은 즐겨찾기 저장 키의 일부라
 * 한 번 정한 형식을 바꾸면 저장된 값이 버려진다:
 * `'head'` | `'group:local'` | `'group:remote'` | `'remote:<원격>'` | `'ref:<전체 ref 이름>'` |
 * `'worktree:<경로>'` | `'backup:<이름>'`
 */
export interface BranchTreeNode {
  id: string;
  kind: BranchNodeKind;
  label: string;
  /** 전체 ref 이름 (`refs/heads/x`, `refs/remotes/origin/x`). ref 가 아닌 노드에는 없다 */
  fullName?: string;
  /** 있으면 펼치고 접는 노드다 */
  children?: BranchTreeNode[];
  /** 처음에 접어 둘지 */
  defaultCollapsed?: boolean;
  /** 이름 뒤에 쓰는 개수 */
  count?: number;
  /** 현재 브랜치인지. 폴더에서는 일부 저장소에서만 현재일 수 있다 */
  current?: boolean | 'partial';
  /** 현재 브랜치 표시의 툴팁. 없으면 기본 문구를 쓴다 (폴더: 어느 저장소에서 현재인지) */
  currentTitle?: string;
  favorite?: boolean;
  /** 즐겨찾기를 켜고 끌 수 있는 노드인지 */
  favoritable?: boolean;
  /** 이름 뒤 회색 글자: 폴더 `(저장소, …)`, 워크트리 main·locked, 백업 날짜 */
  suffix?: string;
  track?: BranchTrack;
  /** 업스트림 차이 표시의 툴팁 (폴더: 저장소별 수치). 행 툴팁에도 덧붙는다 */
  trackTitle?: string;
  badges?: BranchBadge[];
}

/** `HEAD (현재 브랜치)` 행의 id */
export const HEAD_NODE_ID = 'head';
/** 로컬 브랜치의 전체 ref 이름 접두 */
export const LOCAL_REF_PREFIX = 'refs/heads/';
/** 원격 브랜치의 전체 ref 이름 접두 */
export const REMOTE_REF_PREFIX = 'refs/remotes/';

/** 그룹 노드의 id */
export function groupNodeId(name: string): string {
  return `group:${name}`;
}

/** ref 노드의 id */
export function refNodeId(fullName: string): string {
  return `ref:${fullName}`;
}

/** 현재 브랜치 묶음에 드는지. 일부 저장소에서만 현재인 것도 현재로 친다 */
function isCurrent(node: BranchTreeNode): boolean {
  return node.current === true || node.current === 'partial';
}

/** 정렬 순서 (BT-02): 현재 > 즐겨찾기 > 이름 */
export function compareBranchNodes(a: BranchTreeNode, b: BranchTreeNode): number {
  return (
    Number(isCurrent(b)) - Number(isCurrent(a)) ||
    Number(b.favorite === true) - Number(a.favorite === true) ||
    a.label.localeCompare(b.label)
  );
}

/** 형제 노드를 정렬한 새 배열 (원본은 그대로 둔다) */
export function sortBranchNodes(nodes: readonly BranchTreeNode[]): BranchTreeNode[] {
  return [...nodes].sort(compareBranchNodes);
}

/** 잎(자식을 갖지 않는 노드)을 화면 순서대로 모은다 */
export function leafNodes(nodes: readonly BranchTreeNode[]): BranchTreeNode[] {
  return nodes.flatMap((node) => (node.children ? leafNodes(node.children) : [node]));
}

/**
 * 검색어에 맞는 잎과 그 조상만 남긴다 (이름 부분 일치, 대소문자 무시). 빈 검색어면 그대로 준다.
 * 개수를 쓰는 그룹은 남은 잎의 수로 바꿔 화면의 숫자와 보이는 행이 어긋나지 않게 한다
 */
export function filterBranchTree(nodes: readonly BranchTreeNode[], text: string): BranchTreeNode[] {
  const q = text.trim().toLowerCase();
  if (q === '') {
    return [...nodes];
  }
  /** 한 단계의 노드를 거른다 */
  const walk = (list: readonly BranchTreeNode[]): BranchTreeNode[] =>
    list.flatMap((node) => {
      if (!node.children) {
        return node.label.toLowerCase().includes(q) ? [node] : [];
      }
      const children = walk(node.children);
      if (children.length === 0) {
        return [];
      }
      const kept: BranchTreeNode = { ...node, children };
      if (node.count !== undefined) {
        kept.count = leafNodes(children).length;
      }
      return [kept];
    });
  return walk(nodes);
}

/** 사용자가 바꾼 펼침 상태 (노드 id → 펼쳤는지). 없는 노드는 `defaultCollapsed` 를 따른다 */
export type BranchTreeExpansion = Readonly<Record<string, boolean>>;

/** 노드가 펼쳐져 있는지 */
export function isBranchNodeExpanded(
  node: BranchTreeNode,
  expansion: BranchTreeExpansion,
): boolean {
  return expansion[node.id] ?? node.defaultCollapsed !== true;
}

/** 화면에 그리는 행 하나 */
export interface BranchTreeRow {
  node: BranchTreeNode;
  /** 들여쓰기 단계 (맨 위 0) */
  depth: number;
  /** 부모 노드의 id. 맨 위면 null */
  parentId: string | null;
  /** 펼치고 접을 수 있는지 */
  expandable: boolean;
  expanded: boolean;
}

/**
 * 트리를 보이는 행 목록으로 편다. 접힌 노드의 자식은 뺀다.
 * `forceExpanded` (검색 중)면 펼침 상태와 무관하게 모두 펼친 것으로 본다
 */
export function flattenBranchTree(
  nodes: readonly BranchTreeNode[],
  expansion: BranchTreeExpansion,
  forceExpanded = false,
): BranchTreeRow[] {
  const rows: BranchTreeRow[] = [];
  /** 한 단계를 행으로 옮긴다 */
  const walk = (list: readonly BranchTreeNode[], depth: number, parentId: string | null) => {
    for (const node of list) {
      const expandable = node.children !== undefined;
      const expanded = expandable && (forceExpanded || isBranchNodeExpanded(node, expansion));
      rows.push({ node, depth, parentId, expandable, expanded });
      if (expanded && node.children) {
        walk(node.children, depth + 1, node.id);
      }
    }
  };
  walk(nodes, 0, null);
  return rows;
}

/**
 * 세로 툴바의 즐겨찾기 단추가 다룰 것 (BT-05): 고른 잎 중 즐겨찾기할 수 있는 것의 전체 ref 이름과, 그것들이 모두
 * 즐겨찾기인지(단추의 눌림). 고른 것이 없으면 `favorite` 이 null 이다 (단추를 끈다)
 */
export function selectionFavorite(
  nodes: readonly BranchTreeNode[],
  selectedIds: readonly string[],
): { favorite: boolean | null; fullNames: string[] } {
  const picked = leafNodes(nodes).filter(
    (node) => selectedIds.includes(node.id) && node.favoritable && node.fullName,
  );
  return {
    favorite: picked.length === 0 ? null : picked.every((node) => node.favorite),
    fullNames: picked.flatMap((node) => (node.fullName ? [node.fullName] : [])),
  };
}

/** 펼칠 수 있는 노드를 모두 펼치거나 접은 펼침 상태 (모두 펼치기·모두 접기) */
export function expansionForAll(
  nodes: readonly BranchTreeNode[],
  expanded: boolean,
): BranchTreeExpansion {
  const out: Record<string, boolean> = {};
  /** 한 단계의 그룹을 기록한다 */
  const walk = (list: readonly BranchTreeNode[]) => {
    for (const node of list) {
      if (node.children) {
        out[node.id] = expanded;
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}
