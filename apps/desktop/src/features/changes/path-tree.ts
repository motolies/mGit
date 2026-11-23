// 파일 경로 목록을 디렉터리 트리로 만드는 순수 함수들. 작업 트리 변경 목록(`FileList`)과
// 커밋의 변경 파일 트리(`ChangedFilesTree`)가 함께 쓴다.

/** 경로 트리 노드. 파일(잎)이면 `item` 이 있고, 디렉터리면 없다 */
export interface PathTreeNode<T> {
  /** 보이는 이름. 압축한 디렉터리는 `src/main/java` 처럼 여러 단계를 `/` 로 잇는다 */
  name: string;
  /** 루트부터의 경로. 압축한 디렉터리는 마지막 단계까지의 경로다 */
  path: string;
  children: PathTreeNode<T>[];
  item?: T;
  /** 이 노드 아래의 파일 수 (파일 노드는 1) */
  files: number;
}

/** 형제 정렬: 디렉터리 먼저, 그다음 이름순 */
function compareNodes<T>(a: PathTreeNode<T>, b: PathTreeNode<T>): number {
  const da = a.item === undefined ? 0 : 1;
  const db = b.item === undefined ? 0 : 1;
  return da - db || a.name.localeCompare(b.name);
}

/** 형제를 정렬하고 디렉터리마다 파일 수를 센다 (재귀). 그 수준의 파일 수 합계를 돌려준다 */
function finish<T>(nodes: PathTreeNode<T>[]): number {
  nodes.sort(compareNodes);
  let total = 0;
  for (const node of nodes) {
    node.files = node.item === undefined ? finish(node.children) : 1;
    total += node.files;
  }
  return total;
}

/**
 * `/` 로 나뉜 경로 목록을 디렉터리 트리로 만든다 (디렉터리 먼저, 이름순). 같은 이름의 파일과 디렉터리는
 * 따로 노드가 된다. 같은 경로가 두 번 오면 처음 것만 남는다
 */
export function buildPathTree<T extends { path: string }>(items: readonly T[]): PathTreeNode<T>[] {
  const root: PathTreeNode<T> = { name: '', path: '', children: [], files: 0 };
  for (const item of items) {
    const parts = item.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isLeaf = i === parts.length - 1;
      let child = node.children.find(
        (c) => c.name === part && (isLeaf ? c.item !== undefined : c.item === undefined),
      );
      if (!child) {
        child = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          children: [],
          files: 0,
          ...(isLeaf ? { item } : {}),
        };
        node.children.push(child);
      }
      node = child;
    });
  }
  finish(root.children);
  return root.children;
}

/**
 * 자식이 디렉터리 하나뿐인 디렉터리 사슬을 한 노드로 압축한다 (`src` > `main` > `java` → `src/main/java`).
 * 자식이 파일 하나뿐인 디렉터리는 압축하지 않는다. 원래 트리는 바꾸지 않는다
 */
export function compressPathTree<T>(nodes: readonly PathTreeNode<T>[]): PathTreeNode<T>[] {
  return nodes.map((node) => {
    if (node.item !== undefined) {
      return node;
    }
    let merged = node;
    let only = merged.children.length === 1 ? merged.children[0] : undefined;
    while (only !== undefined && only.item === undefined) {
      merged = { ...only, name: `${merged.name}/${only.name}` };
      only = merged.children.length === 1 ? merged.children[0] : undefined;
    }
    return { ...merged, children: compressPathTree(merged.children) };
  });
}
