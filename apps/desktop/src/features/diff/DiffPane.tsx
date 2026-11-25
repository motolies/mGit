import type { SessionId } from '@mgit/ipc';
import { S, shortHash } from '@mgit/ui';
import { useEffect } from 'react';
import { useDialogs } from '../../components/use-dialogs';
import { type SessionState, useSession, useSessionOf } from '../../store';
import { DiffPaneView } from './DiffPaneView';
import { subprojectPointers } from './subproject';

/** diff 화면이 읽는 세션 상태와 동작 */
function pickDiff(st: SessionState) {
  return {
    target: st.selectedFile,
    diff: st.diff,
    document: st.diffDocument,
    busy: st.busy,
    loading: st.diffLoading,
    error: st.diffError,
    mode: st.diffMode,
    setMode: st.setDiffMode,
    closeFile: st.closeFile,
    loadFull: st.loadFullDiff,
    applyLines: st.applyLines,
    applyHunk: st.applyHunk,
    discardLines: st.discardLines,
    discardHunk: st.discardHunk,
    options: st.diffOptions,
    setOptions: st.setDiffOptions,
    openDifftool: st.openDifftool,
    submoduleLog: st.submoduleLog,
    loadSubmoduleLog: st.loadSubmoduleLog,
  };
}

type DiffSlice = ReturnType<typeof pickDiff>;

/**
 * diff 화면의 몸통 (세션 컨테이너 공용): 받은 세션 상태로 `DiffPaneView` 에 값과 동작을 넘긴다. 작업 트리 diff 면
 * stage·되돌리기(확인창 포함), 서브모듈 포인터 diff 면 그 사이의 commit 목록, 언제나 외부 도구. `repoName` 이 있으면
 * 폴더 탭의 문서다 — 되돌리기 확인창 제목에 저장소 이름을 함께 쓰고, "← 그래프로" 대신 탭 닫기를 쓴다 (ED-03)
 */
function DiffPaneBody({ s, repoName }: { s: DiffSlice; repoName?: string }) {
  const dialogs = useDialogs();
  // 서브모듈 포인터 diff 면 그 사이의 commit 목록을 읽는다 (SUB-04)
  const pointers = subprojectPointers(s.diff);
  const targetPath = s.target?.path ?? null;
  const oldPtr = pointers?.old ?? null;
  const newPtr = pointers?.new ?? null;
  const loadSubmoduleLog = s.loadSubmoduleLog;
  useEffect(() => {
    if (targetPath && newPtr) {
      void loadSubmoduleLog(targetPath, oldPtr, newPtr);
    }
  }, [targetPath, oldPtr, newPtr, loadSubmoduleLog]);
  if (!s.target) {
    return null;
  }
  const { path, staged, commit, range } = s.target;
  // commit·범위 diff 는 읽기 전용 (stage/되돌리기 없음)
  const readOnly = commit !== null || range !== undefined;
  const areaLabel = range
    ? range.label
    : commit
      ? S.diff.commitLabel(shortHash(commit))
      : staged
        ? S.diff.stagedLabel
        : S.diff.unstagedLabel;
  /** 되돌릴 줄을 대화상자에 보여 줄 문구로 (`picked` 가 없으면 hunk 의 변경 줄 전부) */
  const changedLines = (hunk: number, picked?: readonly number[]): string[] => {
    const lines = s.diff?.hunks[hunk]?.lines ?? [];
    const chosen = lines.filter(
      (l, i) => l.kind !== 'context' && (picked === undefined || picked.includes(i)),
    );
    return chosen.map((l) => `${l.kind === 'add' ? '+' : '-'} ${l.text}`);
  };
  /** 되돌리기 전 영향 범위를 보여 주고 확인을 받는다 (CHG-04, SF-02). 폴더 탭은 어느 저장소인지 함께 보인다 */
  const confirmDiscard = (message: string, items: readonly string[]) =>
    dialogs.confirm({
      title:
        repoName === undefined ? S.diff.discardTitle(path) : S.diff.discardTitleIn(repoName, path),
      message,
      items: [...new Set(items)],
      confirmLabel: S.diff.discardConfirm,
      danger: true,
    });
  /** hunk 되돌리기 */
  const discardHunk = async (hunk: number) => {
    if (await confirmDiscard(S.diff.discardHunkMessage, changedLines(hunk))) {
      await s.discardHunk(hunk, s.document?.revision);
    }
  };
  /** 고른 줄 되돌리기. 취소하면 false 로 선택을 남긴다 */
  const discardLines = async (sel: Parameters<typeof s.discardLines>[0]) => {
    const items = sel.flatMap((x) => changedLines(x.hunk, x.lines));
    const ok = await confirmDiscard(S.diff.discardLinesMessage(items.length), items);
    if (ok) {
      await s.discardLines(sel, s.document?.revision);
    }
    return ok;
  };
  /** 외부 diff 도구 (DIFF-07) */
  const difftool = () =>
    void s.openDifftool(
      range
        ? { kind: 'range', a: range.base, b: range.newer, threeDot: false, path }
        : commit
          ? { kind: 'commit', oid: commit, path }
          : { kind: 'workTree', path, staged },
    );
  // 서브모듈 commit 목록은 지금 연 포인터 diff 의 것일 때만 보인다
  const submoduleLog =
    pointers &&
    s.submoduleLog &&
    s.submoduleLog.path === path &&
    s.submoduleLog.new === pointers.new
      ? s.submoduleLog.log
      : null;
  return (
    <>
      <DiffPaneView
        path={path}
        areaLabel={areaLabel}
        diff={s.diff}
        document={s.document}
        loading={s.loading}
        error={s.error}
        mode={s.mode}
        onModeChange={s.setMode}
        options={s.options}
        onOptionsChange={s.setOptions}
        onLoadFull={() => void s.loadFull()}
        onBack={repoName === undefined ? s.closeFile : undefined}
        onDifftool={difftool}
        submoduleLog={submoduleLog}
        actions={
          readOnly || s.loading || s.busy || !s.document
            ? undefined
            : {
                verb: staged ? 'unstage' : 'stage',
                onApplyHunk: (h) => void s.applyHunk(h, s.document?.revision),
                onApplyLines: (sel) => void s.applyLines(sel, s.document?.revision),
                ...(staged
                  ? {}
                  : {
                      onDiscardHunk: (h: number) => void discardHunk(h),
                      onDiscardLines: discardLines,
                    }),
              }
        }
      />
      {dialogs.element}
    </>
  );
}

/**
 * 중앙 diff 보기 (저장소 탭, DIFF-01·02·03 + CHG-03·04 부분 스테이징·되돌리기): 범위 세션(그 탭의 세션)의 "지금 고른
 * 파일" 을 그린다. 머리 왼쪽에 "← 그래프로"
 */
export function DiffPane() {
  return <DiffPaneBody s={useSession(pickDiff)} />;
}

/**
 * 정해 준 세션의 diff 보기 (폴더 탭의 작업 트리 diff 탭, ED-05, W14). 범위 세션(활성 저장소)이 아니라 문서의 저장소
 * 세션에 대고 stage·unstage·되돌리기를 한다 — 활성 저장소가 잠겨 다른 저장소를 가리키고 있어도 화면에 보이는 그 파일·
 * 그 저장소에만 닿는다. 되돌리기 확인창에 저장소 이름을 함께 보인다
 */
export function SessionDiffPane({
  sessionId,
  repoName,
}: {
  sessionId: SessionId;
  repoName: string;
}) {
  return <DiffPaneBody s={useSessionOf(sessionId, pickDiff)} repoName={repoName} />;
}
