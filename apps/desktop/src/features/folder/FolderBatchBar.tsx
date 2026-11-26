import type {
  BatchOp,
  BatchResult,
  FoundRepo,
  IpcClient,
  MergeMode,
  PushRemote,
  RepoSummary,
} from '@mgit/ipc';
import { Button, requireChecked, S } from '@mgit/ui';
import { useRef, useState } from 'react';
import { bool, raw, str, useDialogs } from '../../components/use-dialogs';
import { describeError, getFolderStore, repoNameOf, useAppStore, useFolder } from '../../store';
import { branchNameField, normalizeBranchName } from '../branch/branch-name';
import { revsAfterDelete, revsAfterRename, sameRevs } from '../branches/folder-branch-tree';
import { draftBlockedRepos, hasPendingDraft } from './batch-drafts';
import { useBatchReport } from './batch-report';
import {
  popBatchStash,
  type StashFlowDeps,
  type StashPopPreset,
  type StashSavePreset,
  saveBatchStash,
} from './batch-stash';
import styles from './FolderExtra.module.css';
import { commandDangers, formatGitCommand, parseGitCommand } from './git-command';
import { readRecentCommands, recordRecentCommand } from './recent-commands';
import { useSelectedRepos } from './use-selected-repos';

/** checkout 대상으로 고를 수 있는 저장소 하나 (브랜치 트리의 체크 목록) */
export interface CheckoutCandidate {
  path: string;
  name: string;
  /** 그 브랜치가 이미 현재 브랜치인 저장소 */
  current: boolean;
}

/** 브랜치 트리에서 고른 checkout 대상 브랜치 */
export interface CheckoutBranchTarget {
  /** 화면에 쓰는 이름 (`main`, `origin/main`) */
  name: string;
  /** 원격 브랜치면 그 원격과 브랜치 이름. 로컬 추적 브랜치로 checkout 한다 */
  remote?: { remote: string; branch: string };
}

/** "여기서 새 branch…" 의 시작점 */
export interface BranchStartPoint {
  /** 전체 ref 이름 (`refs/heads/x`, `refs/remotes/origin/x`). 같은 짧은 이름과 헷갈리지 않게 이것을 넘긴다 */
  fullName: string;
  /** 화면에 쓰는 이름 */
  name: string;
}

export type IntegrationPreviewRow = Awaited<
  ReturnType<IpcClient['folderIntegrationPreview']>
>[number];

/** 사전 조회에 실행 스냅샷이 모두 있는 저장소만 선택할 수 있다. */
export function eligibleIntegration(row: IntegrationPreviewRow): row is IntegrationPreviewRow & {
  currentBranch: string;
  head: string;
  sourceOid: string;
} {
  return row.reason === null && !!row.currentBranch && !!row.head && !!row.sourceOid;
}

/** 확인창의 저장소 선택 키는 병합 방식 필드와 충돌하지 않는다. */
export function integrationRepoKey(path: string): string {
  return `repo:${path}`;
}

/**
 * 일괄 push 에서 저장소 하나의 처지 (WS-09): 올라갈 commit 이 있다 / 업스트림이 없어 새로 지정해 게시한다(origin 자동,
 * 또는 원격을 고른다) / 건너뛴다(사유) / 상태를 모른다. 코어의 규칙(폴더 설정의 제외 → 업스트림이 있으면 보낼 commit 없음,
 * 없으면 분리 HEAD·원격 없음 → `upstream_remote`)을 요약으로 미리 본다. 실제 판단은 실행할 때 코어가 다시 한다. 요약이
 * 아직 없거나 실패했으면 모른다
 */
export type PushTarget =
  | { kind: 'push'; commits: number }
  | { kind: 'publish'; branch: string; remote: string }
  | { kind: 'choose'; branch: string; remotes: string[]; initial: string | null }
  | { kind: 'skip'; why: string }
  | { kind: 'unknown' };

/** 저장소 하나의 push 처지 (`PushTarget`) */
export function pushTarget(
  name: string,
  summary: RepoSummary | undefined,
  excluded: readonly string[],
): PushTarget {
  const t = S.folder.batch;
  if (excluded.includes(name)) {
    return { kind: 'skip', why: t.excluded };
  }
  if (summary === undefined || (summary.error !== null && summary.error !== undefined)) {
    return { kind: 'unknown' };
  }
  if (summary.ahead === null || summary.ahead === undefined) {
    return newUpstreamTarget(summary);
  }
  return summary.ahead === 0
    ? { kind: 'skip', why: t.nothingToPush }
    : { kind: 'push', commits: summary.ahead };
}

/**
 * 업스트림이 없는 저장소의 처지 (사용자 결정 "origin 자동 + 예외만 선택", 코어 `upstream_remote` 를 고르기 전 값으로).
 * 분리 HEAD·원격이 없으면 건너뛴다. 원격 목록을 읽지 못했으면 예전처럼 업스트림 없음으로 건너뛴다. origin 이 있으면
 * 그것으로 게시하고, 없으면 원격을 고르게 한다 — 하나뿐이면 그것을 미리 골라 두고, 여럿이면 비워 둔다
 */
function newUpstreamTarget(summary: RepoSummary): PushTarget {
  const t = S.folder.batch;
  const branch = summary.branch ?? null;
  if (branch === null) {
    return { kind: 'skip', why: t.detached };
  }
  const remotes = summary.remotes ?? null;
  if (remotes === null) {
    return { kind: 'skip', why: t.noUpstream };
  }
  if (remotes.length === 0) {
    return { kind: 'skip', why: t.noRemotes };
  }
  if (remotes.includes('origin')) {
    return { kind: 'publish', branch, remote: 'origin' };
  }
  return {
    kind: 'choose',
    branch,
    remotes: [...remotes],
    initial: remotes.length === 1 ? (remotes[0] ?? null) : null,
  };
}

/**
 * push 처지를 한 줄로 (`이름: commit N개` / `이름: 업스트림 새로 지정 → origin/<b>` / `이름: 업스트림 새로 지정 (<b>)` /
 * `이름: 건너뜀 (사유)` / `이름: 상태를 아직 모름`)
 */
export function pushPlanLine(
  name: string,
  summary: RepoSummary | undefined,
  excluded: readonly string[],
): string {
  const t = S.folder.batch;
  const target = pushTarget(name, summary, excluded);
  switch (target.kind) {
    case 'push':
      return t.pushCommits(name, target.commits);
    case 'publish':
      return t.pushPublish(name, `${target.remote}/${target.branch}`);
    case 'choose':
      return t.pushChoose(name, target.branch);
    case 'skip':
      return t.pushSkip(name, target.why);
    case 'unknown':
      return t.pushUnknown(name);
  }
}

/** push 체크 목록의 한 줄: 체크할 수 있는 저장소(올라갈 commit 이 있음)와 그 줄의 글자 */
export interface PushCandidate {
  path: string;
  label: string;
}

/** push 체크 목록에서 체크할 수 없는 저장소 하나와 사유 */
export interface PushSkipped {
  path: string;
  name: string;
  why: string;
}

/** origin 이 없는 저장소에서 새 업스트림의 원격을 고르는 칸 (체크 칸 바로 아래) */
export interface PushRemoteChoice {
  /** 저장소 이름 (칸의 이름표) */
  repo: string;
  /** 고를 수 있는 원격 */
  options: string[];
  /** 처음 고른 원격 (원격이 하나뿐일 때). 없으면 고르지 않음 */
  initial: string | null;
}

/** push 체크 목록 */
export interface PushChecklist {
  /**
   * 대상 순서의 모든 줄 (한 목록으로 보인다). `why` 가 있으면 꺼진 칸이다. `remote` 가 있으면 원격을 고르는 칸이 따라
   * 붙는다
   */
  rows: { path: string; label: string; why: string | null; remote?: PushRemoteChoice }[];
  /** 체크할 수 있는 줄 (처음엔 체크됨) */
  candidates: PushCandidate[];
  /** 체크할 수 없는 줄 */
  skipped: PushSkipped[];
  /** 업스트림을 새로 지정할 줄이 있는지 (확인창에 안내를 더한다) */
  publishes: boolean;
}

/**
 * push 체크 목록 (W14 사용자 요구, W19): 올라갈 commit 이 있는 저장소는 체크할 수 있는 줄(처음엔 체크됨, 글자 = `이름:
 * commit N개`), 업스트림이 없는 저장소는 새 업스트림을 보이는 체크할 수 있는 줄(`이름: 업스트림 새로 지정 → origin/<b>`,
 * origin 이 없으면 원격을 고르는 칸이 붙는다), 건너뛸 저장소(분리 HEAD·원격 없음·보낼 commit 없음·제외됨·상태 모름)는 같은
 * 목록의 꺼진 칸(글자 = 이름, 옆에 사유). 대상 순서를 지킨다
 */
export function pushChecklist(
  targets: readonly { path: string; name: string }[],
  summaryOf: (path: string) => RepoSummary | undefined,
  excluded: readonly string[],
): PushChecklist {
  const t = S.folder.batch;
  const rows: PushChecklist['rows'] = [];
  const candidates: PushCandidate[] = [];
  const skipped: PushSkipped[] = [];
  let publishes = false;
  for (const { path, name } of targets) {
    const summary = summaryOf(path);
    const target = pushTarget(name, summary, excluded);
    if (target.kind === 'skip' || target.kind === 'unknown') {
      const why = target.kind === 'skip' ? target.why : t.unknownState;
      skipped.push({ path, name, why });
      rows.push({ path, label: name, why });
      continue;
    }
    const label = pushPlanLine(name, summary, excluded);
    candidates.push({ path, label });
    if (target.kind === 'choose') {
      rows.push({
        path,
        label,
        why: null,
        remote: { repo: name, options: target.remotes, initial: target.initial },
      });
    } else {
      rows.push({ path, label, why: null });
    }
    publishes ||= target.kind !== 'push';
  }
  return { rows, candidates, skipped, publishes };
}

/** 체크 목록 대화상자의 값에서 체크한 저장소만 (빈 목록이면 실행하지 않는다 — 코어에서 빈 목록은 "전부") */
export function checkedPaths(
  candidates: readonly PushCandidate[],
  values: Record<string, string | boolean>,
): string[] {
  return candidates.filter((c) => bool(values, c.path)).map((c) => c.path);
}

/** push 체크 목록에서 원격을 고르는 칸의 키 (체크 칸의 키인 경로와 겹치지 않게 접두를 붙인다) */
export function pushRemoteKey(path: string): string {
  return `remote:${path}`;
}

/**
 * push 체크 목록의 확인 값 → 일괄 push 요청: 체크한 저장소(명시 목록)와, 원격을 고르는 줄 중 체크하고 원격을 고른
 * 저장소의 선택. origin 이 있는 저장소는 넘기지 않는다 — 코어가 origin 으로 보낸다. 체크했는데 원격을 고르지 않은
 * 저장소는 코어가 사유와 함께 건너뛴다. 늘 새 업스트림 규칙을 넘긴다 (업스트림이 없는 branch 도 게시한다)
 */
export function pushRequest(
  plan: PushChecklist,
  values: Record<string, string | boolean>,
): { op: BatchOp; paths: string[] } {
  const paths = checkedPaths(plan.candidates, values);
  const remotes = plan.rows.flatMap((row) => {
    if (!row.remote || !paths.includes(row.path)) {
      return [];
    }
    const remote = str(values, pushRemoteKey(row.path));
    return row.remote.options.includes(remote) ? [{ path: row.path, remote }] : [];
  });
  return { op: { kind: 'push', newUpstream: { remotes } }, paths };
}

/**
 * 확인 흐름을 다시 열 때 채울 이전 값 ("실패한 저장소만 다시 실행"). 모두 선택 사항이고, 없으면 지금까지의 처음 값이다
 */
export interface BatchPresets {
  /** push: 저장소별로 골랐던 새 업스트림 원격 (원격 칸의 처음 값) */
  push: { remotes?: readonly PushRemote[] };
  /** branch 만들기·여기서 새 branch: 이름과 checkout */
  createBranch: { name: string; checkout: boolean };
  /** 워크트리: 폴더(고르지 않고 그대로)·branch·새 branch 로 만들기 */
  worktree: { root: string; branch: string; create: boolean };
  /** 이름 바꾸기: 새 이름 */
  renameBranch: { to: string };
  /** 체크 목록의 대상을 모두 처음부터 체크한다 (트리 선택과 상관없이). 병합은 방식도 채운다 */
  checklist: { checkAll?: boolean; mode?: MergeMode };
  /** 일괄 명령: 입력 칸에 채울 명령 (`git …`) */
  runCommand: { command: string };
}

/** 일괄 명령 입력 칸의 값을 해석한다 (값이 글자가 아니면 빈 입력) */
function parsedCommandOf(values: Readonly<Record<string, string | boolean>>) {
  return parseGitCommand(typeof values.command === 'string' ? values.command : '');
}

/**
 * 일괄 명령 입력 창의 확인을 막는 사유: 칸이 비었으면 null (필수 칸이 확인을 끈다), 해석하지 못하면 그 사유 글자
 */
export function commandInputError(values: Readonly<Record<string, string | boolean>>) {
  const text = typeof values.command === 'string' ? values.command : '';
  if (text.trim() === '') {
    return null;
  }
  const parsed = parsedCommandOf(values);
  return parsed.ok ? null : S.folder.command.errors[parsed.error];
}

/** 일괄 명령 입력 창 아래의 경고 한 줄: 위험한 명령이면 그 까닭들, 아니면 null */
export function commandInputNotice(values: Readonly<Record<string, string | boolean>>) {
  const parsed = parsedCommandOf(values);
  if (!parsed.ok) {
    return null;
  }
  const c = S.folder.command;
  const dangers = commandDangers(parsed.args);
  return dangers.length === 0 ? null : c.dangerNotice(dangers.map((d) => c.danger[d]).join(', '));
}

/** Git 도구 창의 작업 기록 탭을 보인다 (이미 보이면 그대로) */
function showTaskHistory() {
  const app = useAppStore.getState();
  if (!(app.dock.tool === 'git' && app.dock.gitTab === 'history')) {
    app.toggleDock('git', 'history');
  }
}

/** 대상 저장소들: 빈 목록은 전부 (코어의 규칙과 같다) */
function targetRepos(repos: readonly FoundRepo[], paths: readonly string[]): FoundRepo[] {
  return paths.length === 0 ? [...repos] : repos.filter((r) => paths.includes(r.path));
}

/** 두 경로 목록이 같은 저장소들인지 (순서는 보지 않는다) */
function sameRepos(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path) => b.includes(path));
}

/** 저장소 이름들을 쉼표로 (확인창·알림의 대상 표기) */
function repoNames(targets: readonly { path: string }[]): string {
  return targets.map((r) => repoNameOf(r.path)).join(', ');
}

/**
 * 폴더 일괄 작업의 흐름 (MR-05·06·07·14, WS-09): fetch, pull, push(대상 확인), branch 만들기, checkout, 워크트리, 스태시
 * 저장·꺼내기(`batch-stash.ts`), git 명령 실행(`git-command.ts`).
 * 개요의 일괄 작업 줄, Git 로그의 브랜치 트리·세로 툴바, 툴바의 Fetch·Pull·Push, 프로젝트 트리 메뉴가 같은 흐름을
 * 쓴다. 대상은 넘긴 경로이고, 넘기지 않으면 고른 저장소(트리 선택 중 저장소 — `useSelectedRepos`), 고른 것이
 * 없으면 전부다(`scope`). 돌려준 `dialogs.element` 를 화면에 두어야 대화상자가 뜬다.
 * `report` 를 주면 실행이 끝날 때마다 결과를 넘긴다 (실행하지 못했으면 null — 사유는 폴더 스토어의 `error`)
 */
export function useFolderBatchFlows(report?: (result: BatchResult | null) => void) {
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const f = useFolder((st) => ({
    id: st.id,
    path: st.path,
    repos: st.repos,
    summaries: st.summaries,
    settings: st.settings,
    running: st.batchRunning,
    runBatch: st.runBatch,
    inspectIntegration: st.inspectIntegration,
  }));
  const selected = useSelectedRepos();
  const notice = useAppStore((s) => s.notice);
  const pickDirectory = useAppStore((s) => s.pickDirectory);
  const openFolderAt = useAppStore((s) => s.openFolderAt);
  const dialogs = useDialogs();
  const t = S.folder.batch;
  const repos = f?.repos ?? [];
  const running = (f?.running ?? false) || preparing;
  const runBatch = f?.runBatch;
  const folderId = f?.id ?? null;

  /**
   * 대상 표기: 빈 목록은 전체 수, 트리에서 고른 저장소 그대로면 고른 수(`선택 N개`), 그 밖에 넘긴 목록(Commit and Push 의
   * 커밋된 저장소, 실패한 저장소만 다시 실행, 트리 메뉴의 그 행)은 사용자가 고른 것이 아니므로 저장소 수(`저장소 N개`)
   */
  const scopeOf = (paths: readonly string[]) =>
    paths.length === 0
      ? t.allRepos(repos.length)
      : sameRepos(paths, selected)
        ? t.selected(paths.length)
        : S.folder.repos(paths.length);
  /** 쓰기 동작의 확인창에 쓰는 대상: 수와 저장소 이름 */
  const describe = (paths: readonly string[]) =>
    t.targets(scopeOf(paths), repoNames(targetRepos(repos, paths)));
  const scope = scopeOf(selected);
  /** 대상 중 편집기 초안이 있는 저장소 이름 (작업 트리를 바꾸는 작업의 확인창에 미리 알린다) */
  const draftedNames = (paths: readonly string[]): string[] =>
    targetRepos(repos, paths)
      .filter((r) => hasPendingDraft(r.path))
      .map((r) => repoNameOf(r.path));

  /**
   * 일괄 작업을 실행하고 결과를 알린다. 이미 실행 중이면 아무것도 하지 않는다. 작업 트리 파일을 바꾸는 작업은 대상 저장소에
   * 저장하지 않았거나 저장 중인 편집기 초안이 있으면 실행하지 않고 그 저장소를 알린다 (`batch-drafts.ts` — 확인창 뒤에
   * 생긴 초안도 여기서 막는다). 지금 branch 는 누른 순간의 요약에서 읽는다 (branch 업데이트가 checkout 된 branch 인지)
   */
  const run = async (op: BatchOp, paths: readonly string[]): Promise<BatchResult | null> => {
    if (!runBatch || running) {
      return null;
    }
    const summaries =
      (folderId === null ? undefined : getFolderStore(folderId)?.getState().summaries) ??
      f?.summaries ??
      [];
    const blocked = draftBlockedRepos(
      op,
      targetRepos(repos, paths),
      (path) => summaries.find((s) => s.path === path)?.branch,
    );
    if (blocked.length > 0) {
      notice({
        kind: 'error',
        title: t.draftsBlockedTitle,
        message: t.draftsBlocked(repoNames(blocked)),
      });
      return null;
    }
    const result = await runBatch(op, paths);
    report?.(result);
    return result;
  };

  /**
   * 로컬 branch 이름 바꾸기·삭제 뒤 로그 범위를 맞춘다 (브랜치 칸에서 시작한 것과 작업 기록의 "실패한 저장소만 다시
   * 실행" 이 함께 쓴다). 요약·브랜치를 다시 읽고, 범위에 걸린 옛 이름이 어느 저장소에도 남지 않았으면 이름 바꾸기는 새
   * 이름으로 바꾸고 삭제는 범위에서 뺀다 — 사라진 이름으로 걸린 로그가 비지 않게. 이름 바꾸기에서 옛 이름이 남았으면
   * (바꾸지 않은 저장소) 새 이름을 더한다. 범위는 다시 읽은 뒤의 질의를 스토어에서 읽는다. `to` 가 null 이면 삭제다
   */
  const followBranchInLog = async (from: string, to: string | null) => {
    const store = folderId === null ? undefined : getFolderStore(folderId);
    if (!store) {
      return;
    }
    await store.getState().refresh();
    const live = store.getState();
    if (!live.branches) {
      return;
    }
    const remains = live.branches.branches.some((b) => !b.remote && b.name === from);
    const query = live.timeline.query;
    const next =
      to !== null
        ? revsAfterRename(query.revs, from, to, remains)
        : remains
          ? query.revs
          : revsAfterDelete(query.revs, from);
    if (!sameRevs(query.revs, next)) {
      void live.setTimelineQuery({ ...query, revs: next });
    }
  };

  /** fetch (MR-05). 확인 없이 바로 실행한다 */
  const fetch = (paths: readonly string[] = selected) => run({ kind: 'fetch', prune: true }, paths);

  /**
   * pull: 코어가 폴더 설정의 방식(기본 ff-only)으로 하고 변경·진행 중 작업·업스트림 없는 저장소는 건너뛴다. 대상에 편집기
   * 초안이 있으면 실행하지 않는다 (`run`)
   */
  const pull = (paths: readonly string[] = selected) => run({ kind: 'pull' }, paths);

  /**
   * branch 업데이트 (BR-09): 로컬 branch `name` 을 저장소마다 업스트림으로 fast-forward 한다 (checkout 하지 않은 branch 도).
   * 확인 없이 바로 실행한다 — fast-forward 만 하므로 잃는 commit 이 없다. 대상은 브랜치 트리가 고른 저장소(그 branch 가
   * 있고 업스트림이 있는 저장소)이고, 빈 목록이면 실행하지 않는다 (코어에서 빈 목록은 "전부"). 그 branch 가 checkout 된
   * 저장소에 편집기 초안이 있으면 실행하지 않는다 (`run`)
   */
  const updateBranch = (name: string, paths: readonly string[]) =>
    paths.length === 0 ? Promise.resolve(null) : run({ kind: 'updateBranch', name }, paths);

  /** 저장소별 현재 브랜치와 기준 OID를 확인한 뒤 선택한 저장소에만 병합·리베이스한다. */
  const integrateBranch = async (
    kind: 'merge' | 'rebase',
    source: BranchStartPoint,
    candidates: readonly { path: string; name: string }[],
    preset: BatchPresets['checklist'] = {},
  ) => {
    if (
      folderId === null ||
      !f?.inspectIntegration ||
      running ||
      preparingRef.current ||
      candidates.length === 0
    )
      return;
    const live = getFolderStore(folderId)?.getState();
    if (!live || live.batchRunning) return;
    const copy = S.folder.integration;
    preparingRef.current = true;
    setPreparing(true);
    let rows: IntegrationPreviewRow[];
    try {
      rows = (
        await live.inspectIntegration(
          source.fullName,
          candidates.map((repo) => repo.path),
        )
      ).map((row) => (hasPendingDraft(row.path) ? { ...row, reason: copy.pendingEditor } : row));
    } catch (error) {
      notice({ kind: 'error', title: copy.previewFailed, message: describeError(error) });
      return;
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
    if (
      !getFolderStore(folderId) ||
      useAppStore.getState().activeSessionId !== folderId ||
      getFolderStore(folderId)?.getState().batchRunning
    )
      return;
    const eligible = rows.filter(eligibleIntegration);
    const values = await dialogs.prompt({
      title: kind === 'merge' ? copy.mergeTitle(source.name) : copy.rebaseTitle(source.name),
      message: [
        copy.partialResults,
        kind === 'rebase' ? copy.rebaseWarning : copy.mergeExplanation,
        ...(source.fullName.startsWith('refs/remotes/') ? [copy.remoteSnapshot] : []),
      ].join('\n'),
      danger: kind === 'rebase',
      fields: [
        ...(kind === 'merge'
          ? [
              {
                key: 'mode',
                label: copy.mode,
                type: 'select' as const,
                initial: preset.mode ?? 'default',
                options: [
                  { value: 'default', label: copy.defaultMode },
                  { value: 'noFf', label: S.menu.mergeIntoNoFf },
                  { value: 'ffOnly', label: S.menu.mergeIntoFfOnly },
                  { value: 'squash', label: S.menu.mergeIntoSquash },
                ],
              },
            ]
          : []),
        ...rows.map((row) => ({
          key: integrationRepoKey(row.path),
          label:
            kind === 'merge'
              ? copy.mergeDirection(row.name, source.name, row.currentBranch ?? copy.noBranch)
              : copy.rebaseDirection(row.name, row.currentBranch ?? copy.noBranch, source.name),
          type: 'checkbox' as const,
          initial:
            eligibleIntegration(row) &&
            (preset.checkAll || selected.length === 0 || selected.includes(row.path)),
          disabled: !eligibleIntegration(row),
          note: [row.path, row.reason ?? (!eligibleIntegration(row) ? copy.incomplete : null)]
            .filter(Boolean)
            .join(' · '),
          group: t.repoGroup(rows.length),
        })),
      ],
      validate: requireChecked(
        eligible.map((row) => integrationRepoKey(row.path)),
        eligible.length === 0 ? copy.noneEligible : t.noneChecked,
      ),
      notice: (values) => (kind === 'merge' && values.mode === 'squash' ? copy.squashNotice : null),
      confirmLabel: kind === 'merge' ? copy.mergeRun : copy.rebaseRun,
    });
    if (!values || !getFolderStore(folderId) || useAppStore.getState().activeSessionId !== folderId)
      return;
    const targets = eligible
      .filter((row) => bool(values, integrationRepoKey(row.path)))
      .map(({ path, currentBranch, head, sourceOid }) => ({
        path,
        currentBranch,
        head,
        sourceOid,
      }));
    if (targets.length === 0) return;
    // 확인창을 띄운 뒤 포맷·편집·저장이 시작된 경우 원문을 덮거나 자동 저장을 강제하지 않는다.
    if (targets.some((target) => hasPendingDraft(target.path))) {
      notice({ kind: 'error', title: copy.previewFailed, message: copy.editorChanged });
      return;
    }
    if (kind === 'merge') {
      const value = str(values, 'mode');
      const mode: MergeMode =
        value === 'noFf' || value === 'ffOnly' || value === 'squash' ? value : 'default';
      await run(
        { kind: 'merge', reference: source.fullName, mode, targets },
        targets.map((target) => target.path),
      );
    } else
      await run(
        { kind: 'rebase', reference: source.fullName, targets },
        targets.map((target) => target.path),
      );
  };

  /**
   * push (WS-09, W14·W19): 항상 저장소 체크 목록을 거친다 (checkout 체크 목록과 같은 부품·같은 묶음 모양). 올라갈
   * commit 이 있는 저장소와 업스트림이 없어 새로 지정할 저장소는 체크된 채로, 건너뛸 저장소는 같은 목록에 꺼진 칸과
   * 사유로 보인다. origin 이 없는 저장소는 체크 칸 아래에서 원격을 고른다. 체크한 저장소만 명시 목록으로 넘기고, 하나도
   * 체크하지 않으면 확인 단추가 꺼진다 (빈 목록이 "전부"로 가지 않게 — 확인이 와도 다시 거른다). 요약은 부른 순간의
   * 스토어 값을 읽는다 (커밋 직후 Commit and Push 가 부를 때 오른 ahead·새 branch 를 보도록)
   */
  const push = async (paths: readonly string[] = selected, preset: BatchPresets['push'] = {}) => {
    const live = folderId === null ? undefined : getFolderStore(folderId)?.getState();
    if (running || live?.batchRunning) {
      return;
    }
    const summaries = live?.summaries ?? f?.summaries ?? [];
    const byPath = new Map(summaries.map((s) => [s.path, s]));
    const excluded = live?.settings?.exclude ?? f?.settings?.exclude ?? [];
    const plan = pushChecklist(
      targetRepos(repos, paths).map((r) => ({ path: r.path, name: repoNameOf(r.path) })),
      (path) => byPath.get(path),
      excluded,
    );
    const group = t.repoGroup(plan.rows.length);
    /** 다시 열 때 그 저장소에서 골랐던 원격 (지금도 고를 수 있을 때만) */
    const presetRemote = (path: string, options: readonly string[]) => {
      const remote = preset.remotes?.find((choice) => choice.path === path)?.remote;
      return remote !== undefined && options.includes(remote) ? remote : null;
    };
    const v = await dialogs.prompt({
      title: t.pushTitle,
      message: [
        plan.candidates.length > 0 ? t.pushMessage(describe(paths)) : t.pushNone,
        ...(plan.publishes ? [t.pushPublishNote] : []),
      ].join('\n'),
      fields: plan.rows.flatMap((r) => [
        {
          key: r.path,
          label: r.label,
          type: 'checkbox' as const,
          initial: r.why === null,
          disabled: r.why !== null,
          ...(r.why !== null ? { note: r.why } : {}),
          group,
        },
        ...(r.remote
          ? [
              {
                key: pushRemoteKey(r.path),
                label: t.pushRemote(r.remote.repo),
                type: 'select' as const,
                initial: presetRemote(r.path, r.remote.options) ?? r.remote.initial ?? '',
                options: [
                  { value: '', label: t.pushRemoteNone },
                  ...r.remote.options.map((name) => ({ value: name, label: name })),
                ],
                note: t.pushRemoteNote,
                group,
              },
            ]
          : []),
      ]),
      validate: requireChecked(
        plan.candidates.map((c) => c.path),
        t.noneChecked,
      ),
      confirmLabel: S.remote.push,
    });
    const request = v ? pushRequest(plan, v) : null;
    if (request && request.paths.length > 0) {
      await run(request.op, request.paths);
    }
  };

  /** branch 만들기 (MR-06) */
  const createBranch = async (
    paths: readonly string[] = selected,
    preset?: BatchPresets['createBranch'],
  ) => {
    const v = await dialogs.prompt({
      title: t.branchTitle,
      message: describe(paths),
      fields: [
        branchNameField({
          key: 'name',
          label: t.branchName,
          required: true,
          ...(preset ? { initial: preset.name } : {}),
        }),
        {
          key: 'checkout',
          label: t.branchCheckout,
          type: 'checkbox',
          initial: preset?.checkout ?? true,
        },
      ],
      confirmLabel: S.dialog.create,
    });
    if (v) {
      await run(
        { kind: 'createBranch', name: str(v, 'name').trim(), checkout: bool(v, 'checkout') },
        paths,
      );
    }
  };

  /** checkout (MR-06): 이름을 입력받는다. 대상에 편집기 초안이 있는 저장소가 있으면 확인창에 미리 알린다 */
  const checkout = async (paths: readonly string[] = selected) => {
    const drafted = draftedNames(paths);
    const v = await dialogs.prompt({
      title: t.checkoutTitle,
      message: [
        describe(paths),
        ...(drafted.length > 0 ? [t.draftsNote(drafted.join(', '))] : []),
      ].join('\n'),
      fields: [{ key: 'name', label: t.branchName, required: true }],
      confirmLabel: S.menu.checkout,
    });
    if (v) {
      await run({ kind: 'checkout', name: str(v, 'name').trim() }, paths);
    }
  };

  /** 워크트리 만들기 (MR-07): 폴더 선택(설정에 기본 폴더가 있으면 그것) → branch → 끝나면 그 폴더를 열지 묻는다 */
  const worktree = async (
    paths: readonly string[] = selected,
    preset?: BatchPresets['worktree'],
  ) => {
    const root = preset?.root ?? f?.settings?.worktreeRoot ?? (await pickDirectory(t.worktreeRoot));
    if (!root) {
      return;
    }
    const v = await dialogs.prompt({
      title: t.worktreeTitle,
      message: `${describe(paths)} → ${root}`,
      fields: [
        // 만들 수도 있고 있는 branch 를 고를 수도 있다 (공백이 든 이름은 어느 쪽이든 git 이 받지 않는다)
        branchNameField(
          {
            key: 'branch',
            label: t.worktreeBranch,
            required: true,
            ...(preset ? { initial: preset.branch } : {}),
          },
          'use',
        ),
        {
          key: 'create',
          label: t.worktreeCreate,
          type: 'checkbox',
          initial: preset?.create ?? true,
        },
      ],
      confirmLabel: S.dialog.create,
    });
    if (!v) {
      return;
    }
    const r = await run(
      {
        kind: 'worktree',
        branch: str(v, 'branch').trim(),
        destRoot: root,
        createBranch: bool(v, 'create'),
      },
      paths,
    );
    if (r && r.succeeded > 0) {
      const open = await dialogs.confirm({
        title: t.openWorktrees,
        message: root,
        confirmLabel: t.openWorktreesRun,
      });
      if (open) {
        await openFolderAt(root);
      }
    }
  };

  /**
   * 브랜치 트리의 checkout (BT-07): 그 브랜치를 가진 저장소를 체크 목록으로 보이고 체크한 저장소에서만
   * 실행한다. 이미 그 브랜치인 저장소는 표시하고 체크를 빼 둔다. 편집기 초안이 있는 저장소는 사유와 함께 꺼진 칸이다
   * (일괄 병합·리베이스와 같다). 원격 브랜치는 분리 HEAD 로 두지 않고 로컬 추적 브랜치로 checkout 한다. `note` 는 목록
   * 위에 덧붙일 안내 문구
   */
  const checkoutBranch = async (
    target: CheckoutBranchTarget,
    candidates: readonly CheckoutCandidate[],
    note?: string,
  ) => {
    if (candidates.length === 0 || running) {
      return;
    }
    const tl = S.folder.timeline;
    const rows = candidates.map((c) => ({ ...c, drafted: hasPendingDraft(c.path) }));
    const eligible = rows.filter((c) => !c.drafted);
    const v = await dialogs.prompt({
      title: tl.checkoutTitle(target.name),
      message: [tl.checkoutTargets(candidates.length), note].filter(Boolean).join('\n'),
      fields: rows.map((c) => ({
        key: c.path,
        label: c.current ? tl.checkoutCurrent(c.name) : c.name,
        type: 'checkbox' as const,
        initial: !c.current && !c.drafted,
        disabled: c.drafted,
        ...(c.drafted ? { note: S.folder.integration.pendingEditor } : {}),
        group: t.repoGroup(candidates.length),
      })),
      // 하나도 체크하지 않으면 확인을 끈다 (빈 목록은 코어에서 "전부")
      validate: requireChecked(
        eligible.map((c) => c.path),
        eligible.length === 0 ? S.folder.integration.noneEligible : t.noneChecked,
      ),
      confirmLabel: S.menu.checkout,
    });
    if (!v) {
      return;
    }
    const paths = eligible.filter((c) => bool(v, c.path)).map((c) => c.path);
    // 빈 목록은 코어에서 "전부"를 뜻한다. 아무것도 고르지 않았으면 실행하지 않는다
    if (paths.length > 0) {
      await run(
        target.remote
          ? { kind: 'checkoutRemote', ...target.remote }
          : { kind: 'checkout', name: target.name },
        paths,
      );
    }
  };

  /**
   * 브랜치 트리의 "여기서 새 branch…": 고른 브랜치를 시작점으로 새 브랜치를 만든다. 그 브랜치를 가진
   * 저장소를 체크 목록으로 보이고(처음엔 모두 체크) 체크한 저장소에서만 만든다. 새 브랜치는 시작점이
   * 원격 브랜치여도 그것을 추적하지 않는다 (코어가 `--no-track` 으로 만든다)
   */
  const createBranchFrom = async (
    start: BranchStartPoint,
    targets: readonly { path: string; name: string }[],
    preset?: BatchPresets['createBranch'],
  ) => {
    if (targets.length === 0 || running) {
      return;
    }
    const tl = S.folder.timeline;
    // 저장소 체크 칸의 키. 이름·checkout 칸의 키와 겹치지 않게 접두를 붙인다
    const repoKey = (path: string) => `repo:${path}`;
    const v = await dialogs.prompt({
      title: tl.newBranchFromTitle(start.name),
      message: tl.newBranchFromTargets(targets.length),
      // 옵션(이름·checkout)과 대상 저장소 체크 칸을 묶음으로 나눈다 (W19)
      fields: [
        branchNameField({
          key: 'name',
          label: t.branchName,
          required: true,
          ...(preset ? { initial: preset.name } : {}),
        }),
        {
          key: 'checkout',
          label: t.branchCheckout,
          type: 'checkbox',
          initial: preset?.checkout ?? false,
        },
        ...targets.map((r) => ({
          key: repoKey(r.path),
          label: r.name,
          type: 'checkbox' as const,
          initial: true,
          group: t.repoGroup(targets.length),
        })),
      ],
      validate: requireChecked(
        targets.map((r) => repoKey(r.path)),
        t.noneChecked,
      ),
      confirmLabel: S.dialog.create,
    });
    if (!v) {
      return;
    }
    const paths = targets.filter((r) => bool(v, repoKey(r.path))).map((r) => r.path);
    // 빈 목록은 코어에서 "전부"를 뜻한다. 아무것도 고르지 않았으면 실행하지 않는다
    if (paths.length > 0) {
      await run(
        {
          kind: 'createBranch',
          name: str(v, 'name').trim(),
          checkout: bool(v, 'checkout'),
          startPoint: start.fullName,
        },
        paths,
      );
    }
  };

  /**
   * 브랜치 트리의 이름 변경 (로컬 branch): 새 이름(지금 이름으로 채움, 정규화)과 그 branch 를 가진 저장소의 체크 목록(처음엔
   * 모두 체크)을 받아 체크한 저장소에서 일괄로 바꾼다. 새 이름이 지금 이름과 같거나 체크한 저장소가 없으면 확인을 끈다.
   * 새 이름이 이미 있는 저장소는 코어가 건너뛴다. 결과(실행하지 않았으면 null)와 새 이름을 돌려준다
   */
  const renameBranch = async (
    from: string,
    targets: readonly { path: string; name: string }[],
    preset?: BatchPresets['renameBranch'],
  ): Promise<{ result: BatchResult | null; to: string; paths: string[] } | null> => {
    if (targets.length === 0 || running) {
      return null;
    }
    const tl = S.folder.timeline;
    // 저장소 체크 칸의 키. 이름 칸의 키와 겹치지 않게 접두를 붙인다
    const repoKey = (path: string) => `repo:${path}`;
    const repos = requireChecked(
      targets.map((r) => repoKey(r.path)),
      t.noneChecked,
    );
    const v = await dialogs.prompt({
      title: tl.renameTitle(from),
      message: tl.renameTargets(targets.length),
      fields: [
        branchNameField(
          { key: 'name', label: S.dialog.newName, initial: preset?.to ?? from, required: true },
          'rename',
        ),
        ...targets.map((r) => ({
          key: repoKey(r.path),
          label: r.name,
          type: 'checkbox' as const,
          initial: true,
          group: t.repoGroup(targets.length),
        })),
      ],
      validate: (values) =>
        normalizeBranchName(typeof values.name === 'string' ? values.name : '') === from
          ? tl.renameSame
          : repos(values),
      confirmLabel: S.dialog.rename,
    });
    if (!v) {
      return null;
    }
    const to = str(v, 'name');
    const paths = targets.filter((r) => bool(v, repoKey(r.path))).map((r) => r.path);
    // 빈 목록은 코어에서 "전부"를 뜻한다. 아무것도 고르지 않았거나 이름이 그대로면 실행하지 않는다
    if (paths.length === 0 || to === '' || to === from) {
      return null;
    }
    const result = await run({ kind: 'renameBranch', from, to }, paths);
    // 바꾼 저장소가 있으면 로그 범위의 옛 이름을 따라 바꾼다 (다시 실행에서도)
    if (result?.results.some((r) => r.ok && !r.skipped)) {
      await followBranchInLog(from, to);
    }
    return { result, to, paths };
  };

  /** 로컬 브랜치는 사용 중인 저장소를 제외하고 선택한 곳에서만 안전 삭제한다. */
  const deleteBranch = async (
    name: string,
    candidates: readonly CheckoutCandidate[],
    preset: BatchPresets['checklist'] = {},
  ) => {
    if (folderId === null || running || preparingRef.current || candidates.length === 0)
      return null;
    const live = getFolderStore(folderId)?.getState();
    if (!live || live.batchRunning) return null;
    const copy = S.folder.localDeletion;
    const excluded = live.settings?.exclude ?? [];
    const rows = candidates.map((repo) => ({
      ...repo,
      reason: excluded.includes(repo.name) ? t.excluded : repo.current ? copy.current : null,
    }));
    const eligible = rows.filter((repo) => repo.reason === null);
    preparingRef.current = true;
    setPreparing(true);
    try {
      const values = await dialogs.prompt({
        title: copy.title(name),
        message: copy.message,
        danger: true,
        fields: rows.map((repo) => ({
          key: integrationRepoKey(repo.path),
          label: repo.name,
          type: 'checkbox' as const,
          initial:
            repo.reason === null &&
            (preset.checkAll || selected.length === 0 || selected.includes(repo.path)),
          disabled: repo.reason !== null,
          note: [repo.path, repo.reason].filter(Boolean).join(' · '),
          group: t.repoGroup(rows.length),
        })),
        validate: requireChecked(
          eligible.map((repo) => integrationRepoKey(repo.path)),
          eligible.length === 0 ? copy.noneEligible : t.noneChecked,
        ),
        confirmLabel: copy.confirm,
      });
      const current = getFolderStore(folderId)?.getState();
      if (
        !values ||
        !current ||
        current.batchRunning ||
        useAppStore.getState().activeSessionId !== folderId
      )
        return null;
      const paths = eligible
        .filter((repo) => bool(values, integrationRepoKey(repo.path)))
        .map((repo) => repo.path);
      if (paths.length === 0) return null;
      const result = await current.runBatch({ kind: 'deleteBranch', name }, paths);
      report?.(result);
      // 지운 저장소가 있으면 로그 범위를 맞춘다(다시 읽기 포함, 다시 실행에서도). 없으면 다시 읽기만 한다
      if (result?.succeeded) {
        await followBranchInLog(name, null);
      } else {
        await current.refresh();
      }
      return result;
    } catch (error) {
      notice({ kind: 'error', title: copy.title(name), message: describeError(error) });
      return null;
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  };

  /** 일괄 스태시 흐름의 재료: 실행·대화상자·대상 표기·초안 저장소와, 누른 순간의 스토어에서 읽는 묶음 목록·제외 저장소 */
  const stashDeps: StashFlowDeps = {
    dialogs,
    run,
    describe,
    draftedNames,
    listBatches: async (paths) => {
      const live = folderId === null ? undefined : getFolderStore(folderId)?.getState();
      return live ? live.listStashBatches(paths) : [];
    },
    excluded: () =>
      (folderId === null ? undefined : getFolderStore(folderId)?.getState().settings?.exclude) ??
      f?.settings?.exclude ??
      [],
    notice,
  };

  /** 일괄 스태시 저장 (셋째 묶음 G): 메시지·미추적 파일 포함을 받아 변경이 있는 저장소마다 한 묶음으로 저장한다 */
  const stashSave = (paths: readonly string[] = selected, preset?: StashSavePreset) =>
    running ? Promise.resolve(null) : saveBatchStash(stashDeps, paths, preset);

  /** 일괄 스태시 꺼내기: 묶음을 고르고 그 묶음의 스태시가 남은 저장소 체크 목록을 거쳐 저장소마다 꺼낸다 */
  const stashPop = (paths: readonly string[] = selected, preset?: StashPopPreset) =>
    running ? Promise.resolve(null) : popBatchStash(stashDeps, paths, preset);

  /**
   * 선택한 저장소들에 git 명령 실행 (MR-14): 명령을 입력받는다 (처음 값은 다시 실행의 명령이나 이 폴더의 가장 최근 명령,
   * 최근 명령은 칸의 제안 목록). 셸 문법·닫히지 않은 따옴표는 확인을 끄고, 위험한 명령은 입력 창 아래에 경고한 뒤 실행 전에
   * 한 번 더 확인한다. 저장소마다 그 작업 트리에서 실행하고(동시 실행 수·취소·작업 기록은 다른 일괄 작업과 같다) 끝나면
   * 작업 기록 탭을 열어 저장소별 종료 코드·출력을 보인다. 자격 증명이 든 명령은 최근 목록에 남기지 않는다
   */
  const runCommand = async (
    paths: readonly string[] = selected,
    preset?: BatchPresets['runCommand'],
  ): Promise<BatchResult | null> => {
    const folderPath = f?.path ?? null;
    if (running || folderPath === null) {
      return null;
    }
    const c = S.folder.command;
    const recent = readRecentCommands(folderPath);
    const v = await dialogs.prompt({
      title: c.title,
      message: [describe(paths), c.note].join('\n'),
      fields: [
        {
          key: 'command',
          label: c.label,
          required: true,
          initial: preset?.command ?? recent[0] ?? '',
          placeholder: c.placeholder,
          suggestions: recent,
        },
      ],
      validate: commandInputError,
      notice: commandInputNotice,
      confirmLabel: c.run,
    });
    const parsed = v ? parseGitCommand(raw(v, 'command')) : null;
    if (!parsed?.ok) {
      return null;
    }
    const dangers = commandDangers(parsed.args);
    if (dangers.length > 0) {
      const ok = await dialogs.confirm({
        title: c.dangerTitle,
        message: c.dangerMessage(formatGitCommand(parsed.args), describe(paths)),
        items: dangers.map((d) => c.danger[d]),
        confirmLabel: c.dangerRun,
        danger: true,
      });
      if (!ok) {
        return null;
      }
    }
    recordRecentCommand(folderPath, parsed.args);
    const result = await run({ kind: 'runCommand', args: parsed.args }, paths);
    if (result) {
      showTaskHistory();
    }
    return result;
  };

  return {
    dialogs,
    /** 고른 저장소 (빈 목록 = 전부) */
    selected,
    scope,
    running,
    /** 확인 없이 바로 실행한다 (실패한 저장소만 다시 실행의 확인 없는 작업) */
    run,
    fetch,
    pull,
    updateBranch,
    integrateBranch,
    push,
    createBranch,
    checkout,
    worktree,
    checkoutBranch,
    createBranchFrom,
    renameBranch,
    deleteBranch,
    stashSave,
    stashPop,
    runCommand,
  };
}

/**
 * 일괄 작업 툴바 + 진행 (MR-05·06·07). 대상은 고른 저장소(트리 선택), 없으면 전부다. 결과는 다른 진입점처럼 토스트로
 * 알리고, 자세한 저장소별 결과는 Git 도구 창의 작업 기록 탭에 남는다
 */
export function FolderBatchBar() {
  const f = useFolder((st) => ({
    setSelected: st.setSelected,
    progress: st.batchProgress,
    cancelling: st.batchCancelling,
    cancelBatch: st.cancelBatch,
  }));
  const flows = useFolderBatchFlows(useBatchReport());
  if (!f) {
    return null;
  }
  const t = S.folder.batch;

  return (
    <div className={styles.batch}>
      <div className={styles.batchRow}>
        <span className={styles.scope}>{flows.scope}</span>
        {flows.selected.length > 0 ? (
          <Button onClick={() => f.setSelected([])}>{t.none}</Button>
        ) : null}
        <span className={styles.sep} />
        <Button disabled={flows.running} onClick={() => void flows.fetch()}>
          {t.fetch}
        </Button>
        <Button disabled={flows.running} onClick={() => void flows.pull()}>
          {t.pull}
        </Button>
        <Button disabled={flows.running} onClick={() => void flows.push()}>
          {t.push}
        </Button>
        <span className={styles.sep} />
        <Button disabled={flows.running} onClick={() => void flows.createBranch()}>
          {t.branch}
        </Button>
        <Button disabled={flows.running} onClick={() => void flows.checkout()}>
          {t.checkout}
        </Button>
        <Button disabled={flows.running} onClick={() => void flows.worktree()}>
          {t.worktree}
        </Button>
        <span className={styles.sep} />
        <Button disabled={flows.running} onClick={() => void flows.stashSave()}>
          {t.stashSave}
        </Button>
        <Button disabled={flows.running} onClick={() => void flows.stashPop()}>
          {t.stashPop}
        </Button>
        <span className={styles.sep} />
        <Button disabled={flows.running} onClick={() => void flows.runCommand()}>
          {S.folder.command.button}
        </Button>
        {f.progress ? (
          <>
            <span className={styles.progress}>
              {t.running(f.progress.label, f.progress.phase)}
              {f.progress.percent !== null ? ` ${f.progress.percent}%` : ''}
            </span>
            <Button
              disabled={f.cancelling}
              onClick={() => void f.cancelBatch()}
              title={t.cancelTip}
            >
              {f.cancelling ? t.cancelling : t.cancel}
            </Button>
          </>
        ) : null}
      </div>
      {flows.dialogs.element}
    </div>
  );
}
