// 커밋 변경 파일 트리 (CD-01) 의 모델: 변경 파일 목록 → 압축한 디렉터리 트리 → 그릴 행.
// 화면(`ChangedFilesTree`)과 떼어 둔 순수 함수라 단위 테스트로 고정한다.

import type { ChangedFile } from '@mgit/ipc';
import { buildPathTree, compressPathTree, type PathTreeNode } from '../changes/path-tree';

/** 변경 파일 트리 노드 */
export type ChangedTreeNode = PathTreeNode<ChangedFile>;

/** 루트 행의 id (저장소 행) */
export const CHANGED_ROOT_ID = 'root';

/** 행 종류: 저장소 루트 / 디렉터리 / 파일 */
export type ChangedRowKind = 'root' | 'dir' | 'file';

/** 그릴 행 하나 */
export interface ChangedTreeRow {
  /** 트리 안에서 안정된 id: 루트 `root`, 디렉터리 `d:<경로>`, 파일 `f:<경로>` */
  id: string;
  kind: ChangedRowKind;
  /** 들여쓰기 깊이. 루트가 0 */
  depth: number;
  name: string;
  /** 루트·디렉터리 아래의 파일 수 (파일은 1) */
  files: number;
  /** 파일 행이면 그 파일 */
  file?: ChangedFile;
  expandable: boolean;
  expanded: boolean;
  /** 부모 행의 id. 루트는 null */
  parentId: string | null;
  /** 형제 수와 그 안의 순번 (1부터). 가상 스크롤로 화면 밖 행이 DOM 에 없어도 보조 기술이 위치를 알게 한다 */
  setSize: number;
  posInSet: number;
}

/**
 * 변경 파일 목록을 트리로 만든다: 디렉터리 먼저·이름순, 자식이 디렉터리 하나뿐인 사슬은 한 노드로
 * 압축한다 (`src/main/java/co/kr`). rename 은 새 경로 자리에 놓인다
 */
export function buildChangedFilesTree(files: readonly ChangedFile[]): ChangedTreeNode[] {
  return compressPathTree(buildPathTree(files));
}

/** 노드의 행 id */
function nodeId(node: ChangedTreeNode): string {
  return node.item === undefined ? `d:${node.path}` : `f:${node.path}`;
}

/**
 * 트리를 그릴 행으로 편다. 맨 위는 저장소 루트 행이고, `collapsed` 에 든 id 의 자식은 건너뛴다
 * (기본은 모두 펼침)
 */
export function changedTreeRows(
  rootName: string,
  nodes: readonly ChangedTreeNode[],
  collapsed: ReadonlySet<string>,
): ChangedTreeRow[] {
  const rootExpanded = !collapsed.has(CHANGED_ROOT_ID);
  const rows: ChangedTreeRow[] = [
    {
      id: CHANGED_ROOT_ID,
      kind: 'root',
      depth: 0,
      name: rootName,
      files: nodes.reduce((sum, node) => sum + node.files, 0),
      expandable: nodes.length > 0,
      expanded: rootExpanded,
      parentId: null,
      setSize: 1,
      posInSet: 1,
    },
  ];
  /** 노드들을 깊이 `depth` 로 펴서 붙인다 (재귀) */
  const walk = (list: readonly ChangedTreeNode[], depth: number, parentId: string) => {
    for (const [index, node] of list.entries()) {
      const id = nodeId(node);
      const isDir = node.item === undefined;
      const expanded = isDir && !collapsed.has(id);
      rows.push({
        id,
        kind: isDir ? 'dir' : 'file',
        depth,
        name: node.name,
        files: node.files,
        ...(node.item ? { file: node.item } : {}),
        expandable: isDir,
        expanded,
        parentId,
        setSize: list.length,
        posInSet: index + 1,
      });
      if (expanded) {
        walk(node.children, depth + 1, id);
      }
    }
  };
  if (rootExpanded) {
    walk(nodes, 1, CHANGED_ROOT_ID);
  }
  return rows;
}

/** 파일의 상태 (색을 고르는 이름). 화면은 이 값과 상태 문자를 함께 보인다 (LF-05) */
export type ChangedFileTone = 'added' | 'modified' | 'deleted';

/** 변경 종류 → 색. 이름 바뀜·종류 바뀜은 수정, 복사는 추가와 같은 색이다 */
export function changedFileTone(file: ChangedFile): ChangedFileTone {
  switch (file.change.kind) {
    case 'added':
    case 'copied':
      return 'added';
    case 'deleted':
      return 'deleted';
    default:
      return 'modified';
  }
}
