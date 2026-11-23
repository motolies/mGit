// branch 트리 더블클릭·Enter 의 그래프 범위 (두 탭 공용): checkout 하지 않고 그 branch 와 기본 branch(master 우선, 없으면
// main)의 로컬·원격을 함께 보인다. 저장소의 ref 사정은 탭마다 다른 재료(저장소 탭은 ref 라벨, 폴더 탭은 저장소별 branch
// 목록)에서 오므로 찾기 함수 묶음(`BranchRefLookup`)으로 받는다.

import type { FolderBranch, GraphRevs, RefLabel } from '@mgit/ipc';
import { revsOfBranchNames } from './folder-branch-tree';

/** 기본 branch 후보. 앞의 것이 있으면 그것을 쓴다 */
export const DEFAULT_BRANCH_CANDIDATES: readonly string[] = ['master', 'main'];

/** 기본 원격 branch 를 업스트림으로 찾지 못했을 때 보는 원격 */
const DEFAULT_REMOTE = 'origin';

/** 저장소 하나의 ref 찾기 (이름은 모두 짧은 이름: `main`, `origin/main`) */
export interface BranchRefLookup {
  /** 로컬 branch 가 있는지 */
  hasLocal: (name: string) => boolean;
  /** 원격 branch 가 있는지 */
  hasRemote: (name: string) => boolean;
  /** 로컬 branch 의 업스트림 (짧은 이름). 없으면 null */
  upstreamOf: (name: string) => string | null;
}

/**
 * 저장소 하나의 기본 branch 짝 (있는 것만, [로컬, 원격] 순). 기본 로컬은 후보 중 처음 있는 것(master → main), 기본
 * 원격은 그 로컬의 업스트림이 있으면 그것, 없으면 `origin/<기본>` 이 있을 때 그것. 기본 로컬이 없으면 `origin/master` →
 * `origin/main` 중 처음 있는 원격 하나다
 */
export function defaultBranchRefs(refs: BranchRefLookup): string[] {
  const local = DEFAULT_BRANCH_CANDIDATES.find((name) => refs.hasLocal(name));
  if (local === undefined) {
    const remote = DEFAULT_BRANCH_CANDIDATES.map((name) => `${DEFAULT_REMOTE}/${name}`).find(
      (name) => refs.hasRemote(name),
    );
    return remote === undefined ? [] : [remote];
  }
  const upstream = refs.upstreamOf(local);
  const fallback = `${DEFAULT_REMOTE}/${local}`;
  const remote =
    upstream !== null && refs.hasRemote(upstream)
      ? upstream
      : refs.hasRemote(fallback)
        ? fallback
        : null;
  return remote === null ? [local] : [local, remote];
}

/**
 * 더블클릭·Enter 의 범위: [그 branch, ...기본 branch 짝] 에서 중복을 뺀 것. 하나뿐이면 solo, 여럿이면 branches
 * (클릭의 범위와 같은 규칙 — 기본 branch 자신을 누르면 클릭과 같은 범위가 될 수 있다)
 */
export function branchFocusRevs(name: string, defaults: readonly string[]): GraphRevs {
  return revsOfBranchNames([...new Set([name, ...defaults])]);
}

/** ref 라벨의 업스트림을 짧은 이름으로 (`refs/remotes/origin/main` → `origin/main`). 이미 짧으면 그대로 */
function shortUpstream(upstream: string | null | undefined): string | null {
  return upstream ? upstream.replace(/^refs\/remotes\//, '') : null;
}

/** 저장소 탭: ref 라벨로 찾기 묶음을 만든다 */
export function labelRefLookup(labels: readonly RefLabel[]): BranchRefLookup {
  const of = (kind: RefLabel['kind']['kind'], name: string) =>
    labels.find((l) => l.kind.kind === kind && l.shortName === name);
  return {
    hasLocal: (name) => of('localBranch', name) !== undefined,
    hasRemote: (name) => of('remoteBranch', name) !== undefined,
    upstreamOf: (name) => shortUpstream(of('localBranch', name)?.upstream),
  };
}

/** 폴더 탭: 저장소 하나(`path`)의 찾기 묶음을 폴더 branch 목록으로 만든다 */
export function folderRefLookup(branches: readonly FolderBranch[], path: string): BranchRefLookup {
  const of = (remote: boolean, name: string) =>
    branches
      .find((b) => b.remote === remote && b.name === name)
      ?.repos.find((r) => r.path === path);
  return {
    hasLocal: (name) => of(false, name) !== undefined,
    hasRemote: (name) => of(true, name) !== undefined,
    upstreamOf: (name) => of(false, name)?.upstream ?? null,
  };
}

/**
 * 폴더 탭 더블클릭의 저장소 범위: 그 branch 가 있는 저장소(폴더 저장소 목록의 순서). 모든 저장소에 있거나 목록에서 하나도
 * 찾지 못하면 좁히지 않는다(빈 목록 = 전부) — 범위 칩이 "전부"와 같은 것을 따로 보이지 않게
 */
export function folderFocusScope(
  branch: FolderBranch,
  repos: readonly { path: string }[],
): string[] {
  const has = new Set(branch.repos.map((r) => r.path));
  const scope = repos.filter((r) => has.has(r.path)).map((r) => r.path);
  return scope.length === repos.length ? [] : scope;
}

/**
 * 폴더 탭의 기본 branch 짝: 그 branch 가 있는 저장소마다 기본 짝을 찾아 처음 나온 순서로 합친다 (저장소마다 master·main 이
 * 달라도 각 저장소의 기본이 들어간다). 코어가 저장소마다 없는 이름을 빼고 그린다
 */
export function folderDefaultRefs(
  branches: readonly FolderBranch[],
  branch: FolderBranch,
): string[] {
  const names = branch.repos.flatMap((r) => defaultBranchRefs(folderRefLookup(branches, r.path)));
  return [...new Set(names)];
}
