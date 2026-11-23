// 파일 트리의 경로 다루기 (W11). 트리는 루트 기준 상대 경로(`/` 구분, 루트 = '')로 항목을 가리키고,
// 저장소 요약(`RepoSummary.path`)은 절대 경로로 온다. 둘을 잇는 순수 함수만 둔다.

/** 상대 경로의 상위 디렉터리. 루트 바로 아래면 '', 루트('')면 null */
export function parentDir(path: string): string | null {
  if (path === '') {
    return null;
  }
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

/** 상대 경로의 마지막 구성요소 (루트는 '') */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** 디렉터리 안 항목의 상대 경로 */
export function childPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** `path` 가 `ancestor` 자신이거나 그 아래인지. 루트('')는 모든 경로를 품는다 */
export function isWithin(path: string, ancestor: string): boolean {
  return ancestor === '' || path === ancestor || path.startsWith(`${ancestor}/`);
}

/** 루트부터 그 경로의 부모까지의 디렉터리들: `a/b/c` → `['', 'a', 'a/b']`, 루트('')는 빈 목록 */
export function ancestorDirs(path: string): string[] {
  if (path === '') {
    return [];
  }
  const parts = path.split('/');
  return parts.map((_, i) => parts.slice(0, i).join('/'));
}

/** 절대 경로 끝의 `/` 를 뗀다. 파일 시스템 루트(`/`)는 '' 가 된다 */
function trimEnd(path: string): string {
  return path.replace(/\/+$/, '');
}

/** 절대 루트와 상대 경로를 잇는다. 루트 끝의 `/` 는 하나로 본다 */
export function joinRoot(root: string, rel: string): string {
  const base = trimEnd(root);
  if (rel === '') {
    return base === '' ? '/' : base;
  }
  return `${base}/${rel}`;
}

/**
 * 절대 경로를 루트 기준 상대 경로로 바꾼다. 루트 자신이면 '', 루트 밖이면 null. 이름이 접두로 겹치는 형제
 * (`/w/api` 와 `/w/api-v2`)를 구분한다
 */
export function relativeTo(root: string, abs: string): string | null {
  const base = trimEnd(root);
  const target = trimEnd(abs);
  if (target === base) {
    return '';
  }
  const prefix = `${base}/`;
  return target.startsWith(prefix) ? target.slice(prefix.length) : null;
}

/**
 * 저장소 기준 상대 경로(`git status` 의 경로)를 루트 기준 상대 경로로 바꾼다 (PT-06). 저장소가 루트 밖이면 null.
 * 끝의 `/`(통째로 untracked 인 디렉터리를 git 이 그렇게 알린다)는 뗀다. 저장소 기준 경로가 비면 저장소 자신이다
 */
export function repoToRoot(root: string, repoPath: string, repoRel: string): string | null {
  const repo = relativeTo(root, repoPath);
  if (repo === null) {
    return null;
  }
  const rel = repoRel.replace(/\/+$/, '');
  if (rel === '') {
    return repo;
  }
  return repo === '' ? rel : `${repo}/${rel}`;
}

/**
 * 루트 기준 상대 경로를 (가장 안쪽 저장소, 그 저장소 기준 상대 경로)로 바꾼다 (W13 — 파일 히스토리·blame 의 대상,
 * 결정 19번). `repoToRoot` 의 반대다. 저장소 밖이거나 저장소 디렉터리 자신이면 null
 */
export function rootToRepo(
  root: string,
  repoPaths: readonly string[],
  rel: string,
): { repoPath: string; path: string } | null {
  const abs = joinRoot(root, rel);
  const repoPath = innermostRepo(repoPaths, abs);
  if (repoPath === null) {
    return null;
  }
  const path = relativeTo(repoPath, abs);
  return path === null || path === '' ? null : { repoPath, path };
}

/**
 * 절대 경로가 속한 가장 안쪽 저장소 (WS-07): 경로가 그 항목 자신이거나 조상인 저장소 중 가장 긴 것.
 * 어느 저장소에도 속하지 않으면 null
 */
export function innermostRepo(repoPaths: readonly string[], abs: string): string | null {
  const target = trimEnd(abs);
  let best: string | null = null;
  for (const repo of repoPaths) {
    const base = trimEnd(repo);
    const inside = target === base || target.startsWith(`${base}/`);
    if (inside && (best === null || base.length > trimEnd(best).length)) {
      best = repo;
    }
  }
  return best;
}
