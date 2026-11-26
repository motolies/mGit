import type { BatchOp, BatchResult, FoundRepo, IpcClient, MergeMode, RepoSummary } from '@mgit/ipc';
import { Button, requireChecked, S } from '@mgit/ui';
import { useRef, useState } from 'react';
import { bool, str, useDialogs } from '../../components/use-dialogs';
import { describeError, getFolderStore, repoNameOf, useAppStore, useFolder } from '../../store';
import { editorDrafts } from '../../store/editor-drafts';
import { branchNameField, normalizeBranchName } from '../branch/branch-name';
import { useBatchReport } from './batch-report';
import styles from './FolderExtra.module.css';
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
 * 일괄 push 에서 저장소 하나의 처지 (WS-09): 올라갈 commit 이 있다 / 건너뛴다(사유) / 상태를 모른다. 코어의 건너뛰기
 * 규칙(폴더 설정의 제외 → 업스트림 없음 → 보낼 commit 없음)을 요약으로 미리 본다. 실제 판단은 실행할 때 코어가 다시
 * 한다. 요약이 아직 없거나 실패했으면 모른다
 */
export type PushTarget =
  | { kind: 'push'; commits: number }
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
    return { kind: 'skip', why: t.noUpstream };
  }
  return summary.ahead === 0
    ? { kind: 'skip', why: t.nothingToPush }
    : { kind: 'push', commits: summary.ahead };
}

/** push 처지를 한 줄로 (`이름: commit N개` / `이름: 건너뜀 (사유)` / `이름: 상태를 아직 모름`) */
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

/** push 체크 목록 */
export interface PushChecklist {
  /** 대상 순서의 모든 줄 (한 목록으로 보인다). `why` 가 있으면 꺼진 칸이다 */
  rows: { path: string; label: string; why: string | null }[];
  /** 체크할 수 있는 줄 (처음엔 체크됨) */
  candidates: PushCandidate[];
  /** 체크할 수 없는 줄 */
  skipped: PushSkipped[];
}

/**
 * push 체크 목록 (W14 사용자 요구, W19): 올라갈 commit 이 있는 저장소는 체크할 수 있는 줄(처음엔 체크됨, 글자 = `이름:
 * commit N개`), 건너뛸 저장소(업스트림 없음·보낼 commit 없음·제외됨·상태 모름)는 같은 목록의 꺼진 칸(글자 = 이름, 옆에
 * 사유). 대상 순서를 지킨다
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
  for (const { path, name } of targets) {
    const summary = summaryOf(path);
    const target = pushTarget(name, summary, excluded);
    if (target.kind === 'push') {
      const label = pushPlanLine(name, summary, excluded);
      candidates.push({ path, label });
      rows.push({ path, label, why: null });
    } else {
      const why = target.kind === 'skip' ? target.why : t.unknownState;
      skipped.push({ path, name, why });
      rows.push({ path, label: name, why });
    }
  }
  return { rows, candidates, skipped };
}

/** 체크 목록 대화상자의 값에서 체크한 저장소만 (빈 목록이면 실행하지 않는다 — 코어에서 빈 목록은 "전부") */
export function checkedPaths(
  candidates: readonly PushCandidate[],
  values: Record<string, string | boolean>,
): string[] {
  return candidates.filter((c) => bool(values, c.path)).map((c) => c.path);
}

/** 대상 저장소들: 빈 목록은 전부 (코어의 규칙과 같다) */
function targetRepos(repos: readonly FoundRepo[], paths: readonly string[]): FoundRepo[] {
  return paths.length === 0 ? [...repos] : repos.filter((r) => paths.includes(r.path));
}

/**
 * 폴더 일괄 작업의 흐름 (MR-05·06·07, WS-09): fetch, pull, push(대상 확인), branch 만들기, checkout, 워크트리.
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

  /** 대상 표기: 고른 수 또는 전체 수 */
  const scopeOf = (paths: readonly string[]) =>
    paths.length === 0 ? t.allRepos(repos.length) : t.selected(paths.length);
  /** 쓰기 동작의 확인창에 쓰는 대상: 수와 저장소 이름 */
  const describe = (paths: readonly string[]) =>
    t.targets(
      scopeOf(paths),
      targetRepos(repos, paths)
        .map((r) => repoNameOf(r.path))
        .join(', '),
    );
  const scope = scopeOf(selected);

  /** 일괄 작업을 실행하고 결과를 알린다. 이미 실행 중이면 아무것도 하지 않는다 */
  const run = async (op: BatchOp, paths: readonly string[]): Promise<BatchResult | null> => {
    if (!runBatch || running) {
      return null;
    }
    const result = await runBatch(op, paths);
    report?.(result);
    return result;
  };

  /** fetch (MR-05). 확인 없이 바로 실행한다 */
  const fetch = (paths: readonly string[] = selected) => run({ kind: 'fetch', prune: true }, paths);

  /** pull: 코어가 폴더 설정의 방식(기본 ff-only)으로 하고 변경·진행 중 작업·업스트림 없는 저장소는 건너뛴다 */
  const pull = (paths: readonly string[] = selected) => run({ kind: 'pull' }, paths);

  /**
   * branch 업데이트 (BR-09): 로컬 branch `name` 을 저장소마다 업스트림으로 fast-forward 한다 (checkout 하지 않은 branch 도).
   * 확인 없이 바로 실행한다 — fast-forward 만 하므로 잃는 commit 이 없다. 대상은 브랜치 트리가 고른 저장소(그 branch 가
   * 있고 업스트림이 있는 저장소)이고, 빈 목록이면 실행하지 않는다 (코어에서 빈 목록은 "전부")
   */
  const updateBranch = (name: string, paths: readonly string[]) =>
    paths.length === 0 ? Promise.resolve(null) : run({ kind: 'updateBranch', name }, paths);

  /** 저장소별 현재 브랜치와 기준 OID를 확인한 뒤 선택한 저장소에만 병합·리베이스한다. */
  const integrateBranch = async (
    kind: 'merge' | 'rebase',
    source: BranchStartPoint,
    candidates: readonly { path: string; name: string }[],
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
      ).map((row) =>
        editorDrafts(row.path, { includeSaving: true }).length > 0
          ? { ...row, reason: copy.pendingEditor }
          : row,
      );
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
                initial: 'default',
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
            eligibleIntegration(row) && (selected.length === 0 || selected.includes(row.path)),
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
    if (targets.some((target) => editorDrafts(target.path, { includeSaving: true }).length > 0)) {
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
   * commit 이 있는 저장소는 체크된 채로, 건너뛸 저장소는 같은 목록에 꺼진 칸과 사유로 보인다. 체크한 저장소만 명시
   * 목록으로 넘기고, 하나도 체크하지 않으면 확인 단추가 꺼진다 (빈 목록이 "전부"로 가지 않게 — 확인이 와도 다시 거른다).
   * 요약은 부른 순간의 스토어 값을 읽는다 (커밋 직후 Commit and Push 가 부를 때 오른 ahead 를 보도록)
   */
  const push = async (paths: readonly string[] = selected) => {
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
    const v = await dialogs.prompt({
      title: t.pushTitle,
      message: plan.candidates.length > 0 ? t.pushMessage(describe(paths)) : t.pushNone,
      fields: plan.rows.map((r) => ({
        key: r.path,
        label: r.label,
        type: 'checkbox' as const,
        initial: r.why === null,
        disabled: r.why !== null,
        ...(r.why !== null ? { note: r.why } : {}),
        group: t.repoGroup(plan.rows.length),
      })),
      validate: requireChecked(
        plan.candidates.map((c) => c.path),
        t.noneChecked,
      ),
      confirmLabel: S.remote.push,
    });
    const chosen = v ? checkedPaths(plan.candidates, v) : [];
    if (chosen.length > 0) {
      await run({ kind: 'push' }, chosen);
    }
  };

  /** branch 만들기 (MR-06) */
  const createBranch = async (paths: readonly string[] = selected) => {
    const v = await dialogs.prompt({
      title: t.branchTitle,
      message: describe(paths),
      fields: [
        branchNameField({ key: 'name', label: t.branchName, required: true }),
        { key: 'checkout', label: t.branchCheckout, type: 'checkbox', initial: true },
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

  /** checkout (MR-06): 이름을 입력받는다 */
  const checkout = async (paths: readonly string[] = selected) => {
    const v = await dialogs.prompt({
      title: t.checkoutTitle,
      message: describe(paths),
      fields: [{ key: 'name', label: t.branchName, required: true }],
      confirmLabel: S.menu.checkout,
    });
    if (v) {
      await run({ kind: 'checkout', name: str(v, 'name').trim() }, paths);
    }
  };

  /** 워크트리 만들기 (MR-07): 폴더 선택(설정에 기본 폴더가 있으면 그것) → branch → 끝나면 그 폴더를 열지 묻는다 */
  const worktree = async (paths: readonly string[] = selected) => {
    const root = f?.settings?.worktreeRoot ?? (await pickDirectory(t.worktreeRoot));
    if (!root) {
      return;
    }
    const v = await dialogs.prompt({
      title: t.worktreeTitle,
      message: `${describe(paths)} → ${root}`,
      fields: [
        // 만들 수도 있고 있는 branch 를 고를 수도 있다 (공백이 든 이름은 어느 쪽이든 git 이 받지 않는다)
        branchNameField({ key: 'branch', label: t.worktreeBranch, required: true }, 'use'),
        { key: 'create', label: t.worktreeCreate, type: 'checkbox', initial: true },
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
        confirmLabel: S.home.open,
      });
      if (open) {
        await openFolderAt(root);
      }
    }
  };

  /**
   * 브랜치 트리의 checkout (BT-07): 그 브랜치를 가진 저장소를 체크 목록으로 보이고 체크한 저장소에서만
   * 실행한다. 이미 그 브랜치인 저장소는 표시하고 체크를 빼 둔다. 원격 브랜치는 분리 HEAD 로 두지 않고
   * 로컬 추적 브랜치로 checkout 한다. `note` 는 목록 위에 덧붙일 안내 문구
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
    const v = await dialogs.prompt({
      title: tl.checkoutTitle(target.name),
      message: [tl.checkoutTargets(candidates.length), note].filter(Boolean).join('\n'),
      fields: candidates.map((c) => ({
        key: c.path,
        label: c.current ? tl.checkoutCurrent(c.name) : c.name,
        type: 'checkbox' as const,
        initial: !c.current,
        group: t.repoGroup(candidates.length),
      })),
      // 하나도 체크하지 않으면 확인을 끈다 (빈 목록은 코어에서 "전부")
      validate: requireChecked(
        candidates.map((c) => c.path),
        t.noneChecked,
      ),
      confirmLabel: S.menu.checkout,
    });
    if (!v) {
      return;
    }
    const paths = candidates.filter((c) => bool(v, c.path)).map((c) => c.path);
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
        branchNameField({ key: 'name', label: t.branchName, required: true }),
        { key: 'checkout', label: t.branchCheckout, type: 'checkbox', initial: false },
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
          { key: 'name', label: S.dialog.newName, initial: from, required: true },
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
    return { result: await run({ kind: 'renameBranch', from, to }, paths), to, paths };
  };

  return {
    dialogs,
    /** 고른 저장소 (빈 목록 = 전부) */
    selected,
    scope,
    running,
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
        {f.progress ? (
          <span className={styles.progress}>
            {t.running(f.progress.label, f.progress.phase)}
            {f.progress.percent !== null ? ` ${f.progress.percent}%` : ''}
          </span>
        ) : null}
      </div>
      {flows.dialogs.element}
    </div>
  );
}
