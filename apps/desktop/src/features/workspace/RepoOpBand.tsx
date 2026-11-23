import { useMemo } from 'react';
import { showCommitChanges } from '../../actions';
import { useAppStore, useSession } from '../../store';
import { IsolatedRowView, OpBandView, OpRowView } from './OpBand';
import {
  abortConfirm,
  conflictPaths,
  conflictResolveTarget,
  conflictResolveTitle,
  isolatedDiscardConfirm,
  isolatedRow,
  repoOpRow,
} from './op-band';

/**
 * 저장소 탭의 작업 진행 띠 (WS-18, W21): 툴바 바로 아래, 폴더 탭의 띠와 같은 자리·같은 뷰(`OpBandView`·`OpRowView`).
 * 그래프 밖에 있으므로 에디터에 diff·충돌 탭이 떠 있어도, 아래 Git 도구 창이 콘솔·터미널이거나 숨겨졌거나 최대화돼도
 * 보인다. 진행 중인 작업도 격리 병합도 없으면 자리를 차지하지 않는다. 출처는 그 탭의 세션 상태뿐이다 (그래프 로드
 * 상태와 무관).
 * - 격리 병합 줄 (격리 워크트리 탭일 때, 위): 안내·"메인에 반영"(막힌 사유는 툴팁)·"버리기"(확인 뒤). 끝나면(코어가
 *   메인 경로를 돌려주면) 이 탭을 닫는다. 격리 줄은 탭이 사는 동안의 바깥 맥락이라 위에 둔다 — 작업 줄이 Continue 로
 *   사라질 때 다음 클릭이 막 켜진 "반영"에 떨어지지 않는다.
 * - 작업 줄: 라벨·충돌 수·안내·충돌 해결·Continue·Skip·Abort. 조건·확인창은 폴더 띠와 같다 (`opControls`·저장소 탭
 *   문구의 `abortConfirm`). 저장소 이름 칸은 없다 (탭이 그 저장소다).
 * - "충돌 해결"과 충돌 수: 충돌 파일이 하나면 그 파일의 머지 편집기 탭, 여럿이면 Commit 도구 창의 변경 탭(충돌 목록이
 *   맨 위 — Stash 탭을 보던 중이어도)을 연다 — 명시 클릭이므로 ⌘0 처럼 최대화를 풀고 그 영역으로 포커스를 옮긴다
 *   (`showCommitChanges`, W23)
 */
export function RepoOpBand() {
  const s = useSession((st) => ({
    id: st.id,
    op: st.op,
    conflicted: st.status.summary.conflicted,
    summary: st.status.summary,
    entries: st.status.entries,
    busy: st.busy,
    kept: st.kept.filter((k) => k.matchesCurrent).length,
    isolatedBranch: st.isolatedBranch,
    opContinue: st.opContinue,
    opSkip: st.opSkip,
    opAbort: st.opAbort,
    openConflict: st.openConflict,
    isolatedApply: st.isolatedApply,
    isolatedDiscard: st.isolatedDiscard,
  }));
  const revealCommitChanges = useAppStore((st) => st.revealCommitChanges);
  const setDockMaximized = useAppStore((st) => st.setDockMaximized);
  const closeSession = useAppStore((st) => st.closeSession);
  const op = repoOpRow(s);
  const isolated = isolatedRow(s);
  const paths = useMemo(() => conflictPaths(s.entries), [s.entries]);
  const target = conflictResolveTarget(paths);

  /** 충돌 해결: 하나면 그 파일의 머지 편집기 탭, 여럿이면(또는 아직 모르면) Commit 도구 창의 변경 탭(충돌 목록) */
  const resolve = () => {
    if (target.kind === 'file') {
      void s.openConflict(target.path);
      return;
    }
    showCommitChanges({ revealCommitChanges, setDockMaximized });
  };

  /** 격리 병합 마무리: 반영 또는 버리기가 메인 경로를 돌려주면(성공) 이 탭을 닫는다 */
  const finishIsolated = async (apply: boolean) => {
    const main = apply ? await s.isolatedApply() : await s.isolatedDiscard();
    if (main) {
      await closeSession(s.id);
    }
  };

  return (
    <OpBandView count={(isolated ? 1 : 0) + (op ? 1 : 0)}>
      {isolated ? (
        <IsolatedRowView
          branch={isolated.branch}
          applyBlocked={isolated.applyBlocked}
          discardConfirm={isolatedDiscardConfirm()}
          onApply={() => void finishIsolated(true)}
          onDiscard={() => void finishIsolated(false)}
        />
      ) : null}
      {op ? (
        <OpRowView
          kind={op.kind}
          label={op.label}
          conflicts={op.conflicts}
          busy={op.busy}
          abortConfirm={abortConfirm({ kind: op.kind, kept: op.kept })}
          onResolve={resolve}
          resolveTitle={conflictResolveTitle(target, op.conflicts)}
          onContinue={() => void s.opContinue()}
          onSkip={() => void s.opSkip()}
          onAbort={() => void s.opAbort()}
        />
      ) : null}
    </OpBandView>
  );
}
