import { S } from '@mgit/ui';
import { useEffect, useMemo, useState } from 'react';
import type { MenuItem } from '../../components/ContextMenu';
import { ToolButton } from '../../layout/ToolButton';
import { ToolWindowFrame, ToolWindowNote } from '../../layout/ToolWindowFrame';
import {
  entryInArea,
  getWorkspaceStore,
  useAppStore,
  useFileTree,
  useFolder,
  useWorkspace,
} from '../../store';
import { joinRoot, parentDir } from '../../store/fs-path';
import { useBatchReport } from '../folder/batch-report';
import { useFolderBatchFlows } from '../folder/FolderBatchBar';
import {
  changeItems,
  ignoreTarget,
  joinGroups,
  openInItems,
  rollbackGroups,
} from '../project/file-actions-menu';
import { useFileActions } from '../project/use-file-actions';
import { useRepoSessionActions } from '../workspace/repo-session-actions';
import { CommitMessageBox } from './CommitMessageBox';
import { CommitToolSplit } from './CommitToolSplit';
import {
  type CommitPlanRepo,
  clearsMessage,
  commitBlocker,
  commitPlan,
  committedRepos,
  commonPlaceholder,
  ownMessage,
  planFor,
  repoCommitBlocker,
  repoMessagesFor,
  targetsSummary,
} from './commit-plan';
import {
  buildCommitRepos,
  type CommitFileRow,
  type CommitRow,
  commitTreeRows,
  expandableRowIds,
  fileTarget,
  opensStaged,
  repoRowId,
  rowToggle,
} from './commit-tree-model';
import { FolderCommitTree } from './FolderCommitTree';

/**
 * Commit 도구 창의 폴더 모드 (W14, 개요 탭의 "통합 변경" 보기를 옮겼다): 폴더 스토어의 변경 목록을 트리로 보이고, 줄의
 * 체크로 그 저장소·폴더·파일을 stage·unstage 하며(`writeIndex` — 체크는 git index 를 그대로 비춘다), 메시지를 써서
 * stage 된 것을 일괄 커밋한다(`folderCommit(폴더, 커밋될 저장소의 명시 목록, 메시지, false)`).
 * - 체크는 낙관적으로 바꾸지 않는다: 호출이 도는 동안 누른 줄을 "처리 중"으로 보이고 그 저장소의 체크를 막으며, 폴더
 *   스토어가 다시 읽은 값으로 확정한다. 실패는 사유를 알리고 표시는 그대로(이전 값) 둔다. 건너뛴 충돌 경로는 알린다.
 * - 파일을 누르면 그 저장소 세션으로 작업 트리 diff 탭을 연다 (`openDiff`). 충돌 파일은 머지 편집기 탭을 연다
 *   (`openConflict`, W15).
 * - 커밋 대상(저장소·파일 수)과 커밋되지 않을 저장소의 사유를 누르기 전에 보인다. 결과는 일괄 결과 토스트로 알리고,
 *   대상이 모두 커밋됐을 때만 메시지를 비운다. "Commit and Push…" 는 커밋된 저장소로 push 체크 목록을 연다.
 * - 저장소별 메시지: 커밋될 저장소가 둘 이상(또는 자기 메시지가 남은 저장소가 있음)이면 대상 줄을 눌러 저장소마다 공통
 *   메시지를 덮어쓴다(비우면 공통 메시지). 자기 메시지로 커밋될 저장소 수는 대상 줄에 보인다. "이 저장소만 커밋"(저장소
 *   줄 우클릭·떠 있는 창의 단추)은 대상을 그 저장소 하나로 좁힌 같은 흐름이고, 커밋 후 푸시도 같다. 커밋된 저장소의
 *   자기 메시지는 지운다.
 * 메시지·접힌 줄·스크롤은 워크스페이스 스토어에 두어 Project 도구 창과 번갈아 띄워도 남는다
 */
export function FolderCommitTool() {
  const f = useFolder((st) => ({
    id: st.id,
    changes: st.changes,
    summaries: st.summaries,
    changesLoading: st.changesLoading,
    changesError: st.changesError,
    loading: st.loading,
    batchRunning: st.batchRunning,
    indexWrites: st.indexWrites,
    writeIndex: st.writeIndex,
    commitAll: st.commitAll,
    refresh: st.refresh,
    ensureChanges: st.ensureChanges,
  }));
  const ws = useWorkspace((w) => ({
    message: w.commitMessage,
    setMessage: w.setCommitMessage,
    repoMessages: w.commitRepoMessages,
    setRepoMessage: w.setCommitRepoMessage,
    collapsed: w.commitCollapsed,
    setCollapsed: w.setCommitCollapsed,
    rememberScroll: w.rememberCommitScroll,
    scrollTop: w.commitScrollTop,
    reveal: w.commitReveal,
    ackReveal: w.ackCommitReveal,
  }));
  const notice = useAppStore((s) => s.notice);
  const openRepositoryAt = useAppStore((s) => s.openRepositoryAt);
  const repoActions = useRepoSessionActions();
  const report = useBatchReport();
  const flows = useFolderBatchFlows(report);
  // 저장소 → 누른 줄 id ("처리 중" 표시). 호출이 도는 것 자체는 폴더 스토어의 `indexWrites` 가 기억한다
  const [clicked, setClicked] = useState<Readonly<Record<string, string>>>({});
  const [committing, setCommitting] = useState(false);
  // 파일 메뉴 동작 (Finder·터미널·변경 되돌리기·ignore): 쓰기는 그 저장소의 가벼운 세션에 대고, 끝나면 프로젝트 트리를
  // 다시 읽는다 (같은 탭의 트리 — 감시하지 않으므로. 이 창의 목록은 폴더 스토어가 코어의 폴더 변경 알림으로 다시 읽는다)
  const reloadTree = useFileTree((t) => t.reload);
  const fileActions = useFileActions({
    rollback: (repoPath, paths) => repoActions?.rollback(repoPath, paths) ?? Promise.resolve(false),
    ignoreAdd: (repoPath, patterns) =>
      repoActions?.ignoreAdd(repoPath, patterns) ?? Promise.resolve(false),
    after: () => void reloadTree?.(),
    repoName: (repoPath) => f?.summaries.find((s) => s.path === repoPath)?.name ?? repoPath,
  });

  // 변경 목록을 아직 안 읽었으면 한 번 읽는다 (그 뒤로는 폴더 스토어의 갱신이 함께 다시 읽는다)
  const ensureChanges = f?.ensureChanges;
  useEffect(() => ensureChanges?.(), [ensureChanges]);

  const changes = f?.changes;
  const summaries = f?.summaries;
  const repos = useMemo(
    () => buildCommitRepos(changes ?? [], summaries ?? []),
    [changes, summaries],
  );
  const collapsedIds = ws?.collapsed;
  const collapsed = useMemo(() => new Set(collapsedIds ?? []), [collapsedIds]);
  const rows = useMemo(() => commitTreeRows(repos, collapsed), [repos, collapsed]);
  const plan = useMemo(() => commitPlan(changes ?? [], summaries ?? []), [changes, summaries]);
  const indexWrites = f?.indexWrites;
  const busyRepos = useMemo(() => new Set(Object.keys(indexWrites ?? {})), [indexWrites]);
  // 처리 중인 줄: 누른 줄, 모르면(도구 창을 다시 띄웠다) 그 저장소 줄
  const processing = useMemo(
    () => new Set([...busyRepos].map((repo) => clicked[repo] ?? repoRowId(repo))),
    [busyRepos, clicked],
  );

  if (!f || !ws) {
    return null;
  }

  const locked = f.batchRunning || committing;
  const repoName = (path: string) => repos.find((r) => r.path === path)?.name ?? path;

  /** 줄의 체크를 누른다: stage·unstage 를 부르고 결과(실패·건너뛴 충돌)를 알린다 */
  const toggleCheck = async (row: CommitRow, requestedOp?: 'stage' | 'unstage') => {
    const toggle = rowToggle(row);
    if (toggle === null || locked || busyRepos.has(toggle.repoPath)) {
      return;
    }
    setClicked((prev) => ({ ...prev, [toggle.repoPath]: row.id }));
    const op = requestedOp ?? toggle.op;
    const target = row.kind === 'file' ? fileTarget(row.entry, op) : toggle.target;
    const outcome = await f.writeIndex(toggle.repoPath, op, target);
    setClicked(({ [toggle.repoPath]: _done, ...rest }) => rest);
    const name = repoName(toggle.repoPath);
    if (outcome.kind === 'failed') {
      notice({ kind: 'error', title: S.commitTool.writeFailed(name), message: outcome.error });
    } else if (outcome.kind === 'done' && outcome.result.skipped.length > 0) {
      notice({
        kind: 'info',
        title: S.commitTool.skipped(name, outcome.result.skipped.length),
        message: outcome.result.skipped.map((s) => s.path).join('\n'),
      });
    }
  };

  /** 파일을 연다: 그 저장소 세션의 작업 트리 diff 탭, 충돌 파일이면 머지 편집기 탭 (W15) */
  const open = (row: CommitFileRow) => {
    if (row.check === 'conflict') {
      repoActions?.openConflict(row.repoPath, row.entry.path);
      return;
    }
    repoActions?.openDiff(row.repoPath, row.entry.path, opensStaged(row.entry));
  };

  /** 줄을 펼치거나 접는다 (접힌 줄은 워크스페이스 스토어에 남는다) */
  const toggleExpand = (row: CommitRow) => {
    const next = new Set(collapsed);
    if (next.has(row.id)) {
      next.delete(row.id);
    } else {
      next.add(row.id);
    }
    ws.setCollapsed([...next]);
  };

  /**
   * 파일 줄의 파일 동작 묶음: 변경 묶음(그 파일의 변경 되돌리기, untracked 면 ignore — 저장소 세션을 쓸 수 있을 때)과 열기
   * 묶음(Finder·터미널). 지워진 파일은 디스크에 없으므로 부모 폴더를 연다. 충돌 파일은 되돌리기가 빠진다
   */
  const fileGroups = (row: CommitFileRow): MenuItem[][] => {
    const e = row.entry;
    const gone = e.worktree === 'deleted' || e.index === 'deleted';
    const abs = joinRoot(row.repoPath, gone ? (parentDir(e.path) ?? '') : e.path);
    const target = { repoPath: row.repoPath, path: e.path };
    const changes = repoActions
      ? changeItems(
          {
            rollback: rollbackGroups([target], () => [e]),
            ignore: ignoreTarget(target, false, [e]),
          },
          fileActions.actions,
        )
      : [];
    return [changes, openInItems(abs, fileActions.actions)];
  };

  const blocker = commitBlocker(
    plan,
    ws.message,
    { running: locked, pending: busyRepos.size > 0 },
    ws.repoMessages,
  );
  /** "이 저장소만 커밋"을 막는 사유 (그 저장소의 stage·unstage 만 기다린다). 누를 수 있으면 null */
  const repoBlocker = (repoPath: string) =>
    repoCommitBlocker(
      plan,
      repoPath,
      ws.message,
      { running: locked, pending: busyRepos.has(repoPath) },
      ws.repoMessages,
    );

  /**
   * 커밋한다 (명시 목록, stage 된 것만). 자기 메시지가 있는 저장소는 그 메시지로(없으면 옛 호출 그대로 공통 메시지만).
   * 계획의 대상 전부가 모두 커밋됐을 때만 공통 메시지를 비우고, 커밋된 저장소의 자기 메시지는 지운다. `thenPush` 면
   * 커밋된 저장소로 push 확인 (업스트림이 없는 branch 는 그 확인창이 새 업스트림을 정한다)
   */
  const commit = async (targets: readonly CommitPlanRepo[], thenPush: boolean) => {
    if (targets.length === 0) {
      return;
    }
    setCommitting(true);
    const paths = targets.map((r) => r.path);
    const own = repoMessagesFor(targets, ws.repoMessages);
    const result = await (own.length === 0
      ? f.commitAll(paths, ws.message, false)
      : f.commitAll(paths, ws.message, false, own));
    setCommitting(false);
    report(result);
    const pushed = result ? committedRepos(result) : [];
    const store = getWorkspaceStore(f.id)?.getState();
    if (result && targets.length === plan.repos.length && clearsMessage(result)) {
      store?.setCommitMessage('');
    }
    store?.clearCommitRepoMessages(pushed);
    if (thenPush && pushed.length > 0) {
      await flows.push(pushed);
    }
  };

  /** 계획의 대상 전부를 커밋한다 (커밋 단추·⌘Enter·Commit and Push…) */
  const commitAll = (thenPush: boolean) => {
    if (blocker === null) {
      void commit(plan.repos, thenPush);
    }
  };

  /** 그 저장소 하나만 커밋한다 (같은 흐름, 대상만 좁힌다) */
  const commitOne = (repoPath: string, thenPush: boolean) => {
    const one = planFor(plan, repoPath);
    if (one !== null && repoBlocker(repoPath) === null) {
      void commit(one.repos, thenPush);
    }
  };

  /** 저장소 줄 메뉴의 "이 저장소만 커밋"·"이 저장소만 커밋 후 푸시…" (막혔으면 꺼지고 사유가 툴팁) */
  const commitOneItems = (repoPath: string): MenuItem[] => {
    const reason = repoBlocker(repoPath) ?? undefined;
    const disabled = reason !== undefined;
    return [
      {
        label: S.commitTool.commitOnly,
        disabled,
        disabledReason: reason,
        onSelect: () => commitOne(repoPath, false),
      },
      {
        label: S.commitTool.commitOnlyAndPush,
        disabled,
        disabledReason: reason,
        onSelect: () => commitOne(repoPath, true),
      },
    ];
  };

  /**
   * 줄의 우클릭 메뉴: 파일 열기(충돌 파일은 "충돌 해결" — 머지 편집기 탭), 저장소 탭으로 열기. 진행 중 작업이 있는
   * 저장소의 stage 된 파일은 저장소 탭의 변경 목록처럼 "충돌 상태로 되돌리기" 두 가지를 더한다 (W15, 그 저장소 세션에 대고).
   * 파일은 변경 되돌리기·ignore·Finder·터미널이 뒤에 붙는다. 저장소는 "이 저장소만 커밋" 두 가지가 앞에, Finder·터미널이
   * 뒤에 붙는다
   */
  const menu = (row: CommitRow): MenuItem[] => {
    const openTab: MenuItem = {
      label: S.project.openAsTab,
      onSelect: () => void openRepositoryAt(row.repoPath, f.id),
    };
    if (row.kind === 'file' && row.check === 'conflict') {
      return joinGroups([
        [{ label: S.commitTool.resolveConflict, onSelect: () => open(row) }, openTab],
        ...fileGroups(row),
      ]);
    }
    if (row.kind === 'file') {
      const inOp = (repos.find((r) => r.path === row.repoPath)?.op ?? null) !== null;
      const path = row.entry.path;
      const unresolve: MenuItem[] =
        inOp && repoActions && entryInArea(row.entry, true)
          ? [
              {
                label: S.conflict.unresolveRemake,
                separator: true,
                onSelect: () => repoActions.unresolve(row.repoPath, path, 'remake'),
              },
              {
                label: S.conflict.unresolveKeep,
                onSelect: () => repoActions.unresolve(row.repoPath, path, 'keepWorktree'),
              },
            ]
          : [];
      return joinGroups([
        [
          { label: S.menu.showDiff, commandId: 'file.showDiff', onSelect: () => open(row) },
          openTab,
          ...unresolve,
        ],
        ...fileGroups(row),
      ]);
    }
    return row.kind === 'dir'
      ? []
      : joinGroups([
          commitOneItems(row.repoPath),
          [openTab],
          openInItems(row.repoPath, fileActions.actions),
        ]);
  };

  // 저장소별 메시지 칸: 커밋될 저장소가 둘 이상이거나 자기 메시지가 남은 대상이 있을 때만 (하나뿐이면 공통 메시지로 충분)
  const ownCount = plan.repos.filter((r) => ownMessage(ws.repoMessages, r.path) !== null).length;
  const repoMessages =
    plan.repos.length >= 2 || ownCount > 0
      ? {
          rows: plan.repos.map((r) => ({
            ...r,
            message: ws.repoMessages[r.path] ?? '',
            blocked: repoBlocker(r.path),
          })),
          placeholder: commonPlaceholder(ws.message),
          onChange: ws.setRepoMessage,
          onCommitOne: (repoPath: string) => commitOne(repoPath, false),
        }
      : null;

  const t = S.commitTool;
  const tools = (
    <>
      <ToolButton
        icon="expandAll"
        label={t.expandAll}
        disabled={repos.length === 0}
        onClick={() => ws.setCollapsed([])}
      />
      <ToolButton
        icon="collapseAll"
        label={t.collapseAll}
        disabled={repos.length === 0}
        onClick={() => ws.setCollapsed(expandableRowIds(repos))}
      />
      <ToolButton
        icon="refresh"
        label={t.refresh}
        disabled={f.loading}
        onClick={() => void f.refresh()}
      />
    </>
  );

  // 작업 띠의 "충돌 해결"이 보이라고 한 저장소 줄 (W19). 줄이 아직 없으면(변경 목록을 읽는 중) 생길 때까지 기다린다
  const pending = ws.reveal;
  const revealIndex =
    pending === null ? -1 : rows.findIndex((r) => r.id === repoRowId(pending.repoPath));
  const reveal =
    pending !== null && revealIndex >= 0 ? { index: revealIndex, seq: pending.seq } : null;

  return (
    <ToolWindowFrame title={S.commitTool.title} tools={tools}>
      <CommitToolSplit
        changes={
          f.changesError !== null && repos.length === 0 ? (
            <ToolWindowNote text={t.failed(f.changesError)} error />
          ) : repos.length === 0 ? (
            <ToolWindowNote text={f.changesLoading || f.loading ? t.loading : t.empty} />
          ) : (
            <FolderCommitTree
              // 폴더 탭마다 새로 마운트해 다른 폴더의 선택·스크롤이 섞이지 않게 한다
              key={f.id}
              rows={rows}
              busyRepos={busyRepos}
              processing={processing}
              locked={locked}
              onToggleCheck={(row) => void toggleCheck(row)}
              onToggleExpand={toggleExpand}
              onOpen={open}
              onIndex={(row, op) => void toggleCheck(row, op)}
              onDiscard={(row) =>
                fileActions.actions.rollback(
                  rollbackGroups([{ repoPath: row.repoPath, path: row.entry.path }], () => [
                    row.entry,
                  ]),
                )
              }
              menu={menu}
              initialScrollTop={ws.scrollTop()}
              onScrollTopChange={ws.rememberScroll}
              reveal={reveal}
              onRevealed={ws.ackReveal}
            />
          )
        }
        commit={
          <CommitMessageBox
            message={ws.message}
            onMessageChange={ws.setMessage}
            targets={targetsSummary(plan, ws.repoMessages)}
            repoMessages={repoMessages}
            skipped={plan.skipped.map((s) => t.skipLine(s.name, t.skip[s.reason]))}
            blocked={blocker === null ? null : t[blocker]}
            committing={committing}
            onCommit={() => commitAll(false)}
            onCommitAndPush={() => commitAll(true)}
          />
        }
      />
      {flows.dialogs.element}
      {fileActions.element}
    </ToolWindowFrame>
  );
}
