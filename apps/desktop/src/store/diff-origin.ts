/** 파일 목록을 알고 연 diff의 출처. 커밋·범위·스태시는 열 때의 목록을 유지한다. */
export interface DiffOriginFile {
  path: string;
  oldPath?: string | null;
}
export type DiffOrigin = { repoPath: string; files: readonly DiffOriginFile[] } & (
  | { kind: 'worktree'; staged: boolean }
  | { kind: 'commit'; oid: string }
  | { kind: 'range'; base: string; newer: string; label: string }
  | { kind: 'stash'; oid: string }
);
/** 디렉터리 우선·이름순으로 정렬해 접힘 여부와 무관한 전체 파일 순서를 만든다. */
export function orderedDiffFiles<T extends DiffOriginFile>(files: readonly T[]): T[] {
  return [...new Map(files.map((file) => [file.path, file])).values()].sort((a, b) => {
    const left = a.path.split('/');
    const right = b.path.split('/');
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const directories = Number(right.length > i + 1) - Number(left.length > i + 1);
      if (directories) return directories;
      const name = (left[i] ?? '').localeCompare(right[i] ?? '');
      if (name) return name;
    }
    return left.length - right.length;
  });
}

let arrivalToken = 0;
/** 연속 탐색에서도 같은 요청을 두 번 적용하지 않도록 도착 식별자를 발급한다. */
export function diffArrival(direction: 1 | -1) {
  return {
    token: ++arrivalToken,
    edge: direction === 1 ? ('first' as const) : ('last' as const),
    focus: true,
  };
}

/** 목록에서 현재 파일이 사라지면 이전 순서의 가장 가까운 살아 있는 이웃을 고른다. */
export function nearestDiffFile(
  path: string | null,
  before: readonly DiffOriginFile[],
  after: readonly DiffOriginFile[],
): DiffOriginFile | undefined {
  const current = after.find((file) => file.path === path);
  if (current) return current;
  const index = before.findIndex((file) => file.path === path);
  if (index >= 0) {
    const paths = new Set(after.map((file) => file.path));
    const neighbor = [...before.slice(index + 1), ...before.slice(0, index).reverse()].find(
      (file) => paths.has(file.path),
    );
    if (neighbor) return after.find((file) => file.path === neighbor.path);
  }
  return after[0];
}
