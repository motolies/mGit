// Commit 도구 창 폴더 모드의 변경 트리 모델 (W14). 화면(`FolderCommitTree`)과 떼어 둔 순수 함수라 단위 테스트로
// 고정한다.
//
// 체크박스는 git index 를 그대로 비춘다 (계획 부록 "W14 진행 방식"): 체크 = 그 아래가 전부 stage 됨, 빔 = stage 된 것
// 없음, 중간 = 섞임(파일 하나가 index·작업 트리 양쪽에 변경이 있는 경우 포함). 누르면 빔·중간 → stage, 체크 → unstage.
// 충돌 파일은 체크할 수 없고 폴더·저장소의 세 상태 계산에서도 뺀다 — 넣으면 그 폴더는 영영 "중간" 이 되어 누를 때마다
// stage 만 반복하고 해제할 길이 없다. 그 폴더·저장소를 누르면 코어가 충돌 경로만 건너뛰고(`skipped`) 나머지를 쓴다.
// 트리 모양(디렉터리 먼저·이름순, 단일 자식 사슬 압축)은 W8 의 공용 경로 트리, 상태 문자·색은 W12 의 규칙을 쓴다.

import type { IndexTarget, OpKind, RepoChanges, RepoSummary, StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';
import type { IndexOp } from '../../store/folder-store';
import { entryInArea } from '../../store/session-store';
import { buildPathTree, compressPathTree, type PathTreeNode } from '../changes/path-tree';
import { entryStatus, type StatusTone } from '../project/file-status';

/** 체크박스의 세 상태 */
export type CheckState = 'checked' | 'unchecked' | 'mixed';

/** 파일 줄의 체크 상태. 충돌 파일은 체크할 수 없다 */
export type FileCheck = CheckState | 'conflict';

/** 충돌 항목인지 (unmerged) */
function isConflict(e: StatusEntry): boolean {
  return (
    (e.conflict !== null && e.conflict !== undefined) ||
    e.index === 'unmerged' ||
    e.worktree === 'unmerged'
  );
}

/**
 * 상태 항목 하나의 체크 상태: index 쪽에 변경이 있으면 stage 됨, 작업 트리 쪽(untracked 포함)에 변경이 있으면 stage
 * 안 됨. 둘 다면 중간(MM·AM 등), 충돌이면 `conflict`
 */
export function entryCheck(e: StatusEntry): FileCheck {
  if (isConflict(e)) {
    return 'conflict';
  }
  const staged = entryInArea(e, true);
  const unstaged = entryInArea(e, false);
  if (staged && unstaged) {
    return 'mixed';
  }
  return staged ? 'checked' : 'unchecked';
}

/** 아래 상태들을 하나로: 전부 체크면 체크, 전부 빔이면 빔, 그 밖은 중간. 셀 것이 없으면(충돌뿐) null */
export function combineChecks(states: readonly CheckState[]): CheckState | null {
  if (states.length === 0) {
    return null;
  }
  if (states.every((s) => s === 'checked')) {
    return 'checked';
  }
  return states.every((s) => s === 'unchecked') ? 'unchecked' : 'mixed';
}

/** 누르면 할 일: 체크면 unstage, 빔·중간이면 stage */
export function toggleOp(state: CheckState): IndexOp {
  return state === 'checked' ? 'unstage' : 'stage';
}

/** 저장소 줄의 대상: 그 저장소의 전부 */
export const REPO_TARGET: IndexTarget = { kind: 'all' };

/** 폴더 줄의 대상: 그 디렉터리 (저장소 기준 상대 경로, 그 아래 전부) */
export function dirTarget(path: string): IndexTarget {
  return { kind: 'paths', paths: [path] };
}

/**
 * 파일 줄의 대상. 이름이 바뀐 파일을 unstage 할 때는 새 경로와 옛 경로를 함께 넘긴다 (둘 다 풀려야 이름 변경이
 * 풀린다). stage 할 때는 새 경로만 — 옛 경로는 작업 트리와 index 어디에도 없어 `git add` 가 경로 오류를 낸다
 */
export function fileTarget(e: StatusEntry, op: IndexOp): IndexTarget {
  const paths = op === 'unstage' && e.origPath ? [e.path, e.origPath] : [e.path];
  return { kind: 'paths', paths };
}

/**
 * 파일을 열 때 어느 쪽 diff 를 볼지 (저장소 탭 변경 목록의 방식): 작업 트리 쪽에 변경이 있으면 작업 트리 diff(빔·중간 —
 * hunk 를 stage 할 곳), stage 된 것만 있으면(체크) staged diff(hunk 를 unstage 할 곳)
 */
export function opensStaged(e: StatusEntry): boolean {
  return entryInArea(e, true) && !entryInArea(e, false);
}

/** 파일 줄의 상태 표시: 색 갈래·글자·툴팁 */
export interface FileMark {
  tone: StatusTone | 'deleted';
  letter: string;
  title: string;
}

/**
 * 파일 줄의 상태 문자·색 (LF-05: 색만으로 전하지 않는다). 프로젝트 트리의 규칙(`entryStatus`, W12)을 그대로 쓰고,
 * 그 규칙이 다루지 않는 삭제(디스크에 없어 프로젝트 트리에는 행이 없다)만 여기서 더한다
 */
export function fileMark(e: StatusEntry): FileMark {
  const status = entryStatus(e);
  if (status?.letter) {
    return { tone: status.tone, letter: status.letter, title: status.title };
  }
  if (e.index === 'deleted' || e.worktree === 'deleted') {
    return { tone: 'deleted', letter: 'D', title: S.project.fileStatus.deleted };
  }
  return { tone: 'modified', letter: 'M', title: S.project.fileStatus.modified };
}

/** 트리에 거는 항목: 상태 항목과 트리용 경로 (git 이 디렉터리로 알린 `dir/` 는 끝의 `/` 를 뗀다) */
interface CommitItem {
  path: string;
  entry: StatusEntry;
}

/** 변경이 있는 저장소 하나 (트리의 맨 위 줄) */
export interface CommitRepo {
  path: string;
  name: string;
  /** 현재 브랜치. 분리 HEAD·모름이면 null */
  branch: string | null;
  detached: boolean;
  /** 저장소 색 번호 (`--graph-lane-N`). 요약을 못 읽었으면 null */
  color: number | null;
  /** 진행 중 작업 (요약). 없으면 null */
  op: OpKind | null;
  /** 요약을 읽지 못한 사유. 없으면 null */
  error: string | null;
  nodes: PathTreeNode<CommitItem>[];
  /** 변경 항목 수 */
  files: number;
  conflicts: number;
  /** 저장소 전체의 세 상태 (충돌 제외). 충돌뿐이면 null */
  check: CheckState | null;
  /** 디렉터리 경로 → 세 상태 (충돌 제외). 충돌뿐이면 null */
  dirChecks: ReadonlyMap<string, CheckState | null>;
}

/** 노드 아래의 세 상태를 세고 디렉터리마다 기록한다 (재귀). 충돌뿐이면 null */
function checkNodes(
  nodes: readonly PathTreeNode<CommitItem>[],
  dirs: Map<string, CheckState | null>,
): CheckState | null {
  const states: CheckState[] = [];
  for (const node of nodes) {
    let state: CheckState | null;
    if (node.item) {
      const check = entryCheck(node.item.entry);
      state = check === 'conflict' ? null : check;
    } else {
      state = checkNodes(node.children, dirs);
      dirs.set(node.path, state);
    }
    if (state !== null) {
      states.push(state);
    }
  }
  return combineChecks(states);
}

/**
 * 폴더 변경 목록(`folderChanges` — 변경이 있는 저장소만)을 트리 모델로 만든다. 저장소 순서는 변경 목록 순서(경로순),
 * 색·진행 중 작업·요약 실패·분리 HEAD 는 요약에서 경로로 찾는다
 */
export function buildCommitRepos(
  changes: readonly RepoChanges[],
  summaries: readonly RepoSummary[],
): CommitRepo[] {
  const byPath = new Map(summaries.map((s) => [s.path, s]));
  return changes.map((rc) => {
    const summary = byPath.get(rc.path);
    const items = rc.entries.map((entry) => ({ path: entry.path.replace(/\/+$/, ''), entry }));
    const nodes = compressPathTree(buildPathTree(items));
    const dirChecks = new Map<string, CheckState | null>();
    const check = checkNodes(nodes, dirChecks);
    return {
      path: rc.path,
      name: rc.name,
      branch: rc.branch ?? summary?.branch ?? null,
      detached: summary?.detached ?? false,
      color: summary?.color ?? null,
      op: summary?.op ?? null,
      error: summary?.error ?? null,
      nodes,
      files: rc.entries.length,
      conflicts: rc.entries.filter(isConflict).length,
      check,
      dirChecks,
    };
  });
}

/** 그릴 줄의 공통 부분 */
interface RowBase {
  /** 트리 안에서 안정된 id: 저장소 `r:<저장소>`, 디렉터리 `d:<저장소>\0<경로>`, 파일 `f:<저장소>\0<경로>` */
  id: string;
  /** 들여쓰기 깊이. 저장소가 0 */
  depth: number;
  name: string;
  /** 이 줄이 속한 저장소의 절대 경로 */
  repoPath: string;
  /** 부모 줄의 id. 저장소 줄은 null */
  parentId: string | null;
  expandable: boolean;
  expanded: boolean;
}

/** 저장소 줄 */
export interface CommitRepoRow extends RowBase {
  kind: 'repo';
  repo: CommitRepo;
  check: CheckState | null;
}

/** 디렉터리 줄 (단일 자식 사슬은 한 줄로 압축된다) */
export interface CommitDirRow extends RowBase {
  kind: 'dir';
  /** 저장소 기준 상대 경로 (압축한 사슬의 마지막 단계까지) */
  path: string;
  files: number;
  check: CheckState | null;
}

/** 파일 줄 */
export interface CommitFileRow extends RowBase {
  kind: 'file';
  entry: StatusEntry;
  check: FileCheck;
  mark: FileMark;
}

export type CommitRow = CommitRepoRow | CommitDirRow | CommitFileRow;

/** 저장소 줄의 id */
export function repoRowId(repoPath: string): string {
  return `r:${repoPath}`;
}

/** 디렉터리·파일 줄의 id */
function nodeRowId(kind: 'd' | 'f', repoPath: string, path: string): string {
  return `${kind}:${repoPath}\u0000${path}`;
}

/**
 * 트리를 그릴 줄로 편다. `collapsed` 에 든 id 의 자식은 건너뛴다 (기본은 모두 펼침). 세 상태는 모델을 만들 때 셌으므로
 * 접고 펴도 다시 세지 않는다
 */
export function commitTreeRows(
  repos: readonly CommitRepo[],
  collapsed: ReadonlySet<string>,
): CommitRow[] {
  const rows: CommitRow[] = [];
  for (const repo of repos) {
    const id = repoRowId(repo.path);
    const expanded = !collapsed.has(id);
    rows.push({
      kind: 'repo',
      id,
      depth: 0,
      name: repo.name,
      repoPath: repo.path,
      parentId: null,
      expandable: repo.nodes.length > 0,
      expanded,
      repo,
      check: repo.check,
    });
    /** 노드들을 깊이 `depth` 로 펴서 붙인다 (재귀) */
    const walk = (
      nodes: readonly PathTreeNode<CommitItem>[],
      depth: number,
      parentId: string,
    ): void => {
      for (const node of nodes) {
        if (node.item) {
          const check = entryCheck(node.item.entry);
          rows.push({
            kind: 'file',
            id: nodeRowId('f', repo.path, node.item.entry.path),
            depth,
            name: node.name,
            repoPath: repo.path,
            parentId,
            expandable: false,
            expanded: false,
            entry: node.item.entry,
            check,
            mark: fileMark(node.item.entry),
          });
          continue;
        }
        const dirId = nodeRowId('d', repo.path, node.path);
        const open = !collapsed.has(dirId);
        rows.push({
          kind: 'dir',
          id: dirId,
          depth,
          name: node.name,
          repoPath: repo.path,
          parentId,
          expandable: true,
          expanded: open,
          path: node.path,
          files: node.files,
          check: repo.dirChecks.get(node.path) ?? null,
        });
        if (open) {
          walk(node.children, depth + 1, dirId);
        }
      }
    };
    if (expanded) {
      walk(repo.nodes, 1, id);
    }
  }
  return rows;
}

/**
 * 그 저장소의 줄과 그 아래 디렉터리 줄을 접힌 목록에서 뺀다 (W15 작업 띠의 "충돌 해결": Commit 도구 창에서 그 저장소의
 * 충돌 파일이 보이게). 다른 저장소의 접힘은 그대로다
 */
export function withRepoExpanded(collapsed: readonly string[], repoPath: string): string[] {
  const dirs = nodeRowId('d', repoPath, '');
  return collapsed.filter((id) => id !== repoRowId(repoPath) && !id.startsWith(dirs));
}

/** 접을 수 있는 줄의 id 전부 (모두 접기) */
export function expandableRowIds(repos: readonly CommitRepo[]): string[] {
  const ids: string[] = [];
  /** 디렉터리 노드의 id 를 모은다 (재귀) */
  const walk = (repoPath: string, nodes: readonly PathTreeNode<CommitItem>[]) => {
    for (const node of nodes) {
      if (!node.item) {
        ids.push(nodeRowId('d', repoPath, node.path));
        walk(repoPath, node.children);
      }
    }
  };
  for (const repo of repos) {
    ids.push(repoRowId(repo.path));
    walk(repo.path, repo.nodes);
  }
  return ids;
}

/** 줄을 눌렀을 때의 호출: 어느 저장소에 무엇을 (stage·unstage) */
export interface RowToggle {
  repoPath: string;
  op: IndexOp;
  target: IndexTarget;
}

/**
 * 줄의 체크를 눌렀을 때 부를 것 (저장소 줄 = 전부, 폴더 줄 = 그 디렉터리, 파일 줄 = 그 경로 — 이름 변경은 unstage 때
 * 옛 경로도). 충돌 파일·충돌뿐인 폴더는 null (체크할 수 없다). 빈 경로 목록은 만들지 않는다
 */
export function rowToggle(row: CommitRow): RowToggle | null {
  if (row.check === null || row.check === 'conflict') {
    return null;
  }
  const op = toggleOp(row.check);
  switch (row.kind) {
    case 'repo':
      return { repoPath: row.repoPath, op, target: REPO_TARGET };
    case 'dir':
      return row.path === '' ? null : { repoPath: row.repoPath, op, target: dirTarget(row.path) };
    case 'file':
      return { repoPath: row.repoPath, op, target: fileTarget(row.entry, op) };
  }
}
