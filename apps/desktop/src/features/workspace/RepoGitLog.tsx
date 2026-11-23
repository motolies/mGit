import { Button, S } from '@mgit/ui';
import { useMemo } from 'react';
import { showCommitChanges } from '../../actions';
import { GitLogSplit, useGitLogSide } from '../../layout/GitLogSplit';
import { useAppStore, useSession } from '../../store';
import { BranchToolbar } from '../branches/BranchToolbar';
import { BranchTree } from '../branches/BranchTree';
import { useRepoBranchTree } from '../branches/use-repo-branch-tree';
import { CommitDetail } from '../detail/CommitDetail';
import { RangeDetail } from '../detail/RangeDetail';
import { GraphPane } from '../graph/GraphPane';
import styles from './RepoGitLog.module.css';

/**
 * 고른 commit 이 없을 때의 상세 칸 (CD-09): 작업 트리 변경 요약(staged·변경·untracked·충돌 수)과 "Commit 도구 창 열기".
 * 옛 오른쪽 칸의 변경 사항 목록은 왼쪽 Commit 도구 창으로 옮겨 갔다. "Commit 도구 창 열기"는 변경 탭을 연다 (Stash 탭을
 * 보던 중이어도 — W23)
 */
function WorkTreeSummary() {
  const summary = useSession((st) => st.status.summary);
  const revealCommitChanges = useAppStore((st) => st.revealCommitChanges);
  const setDockMaximized = useAppStore((st) => st.setDockMaximized);
  const t = S.workspace.repoLog;
  const counts = [
    { key: 'staged', text: S.status.staged(summary.staged), n: summary.staged },
    { key: 'unstaged', text: S.status.unstaged(summary.unstaged), n: summary.unstaged },
    { key: 'untracked', text: S.status.untracked(summary.untracked), n: summary.untracked },
    { key: 'conflict', text: S.status.conflicted(summary.conflicted), n: summary.conflicted },
  ];
  const clean = counts.every((c) => c.n === 0);
  return (
    <div className={styles.empty}>
      <span>{t.pickCommit}</span>
      <h3 className={styles.summaryTitle}>{t.changes}</h3>
      {clean ? (
        <span>{S.status.noChanges}</span>
      ) : (
        <ul className={styles.counts} aria-label={t.changes}>
          {counts.map((c) => (
            <li
              key={c.key}
              data-zero={c.n === 0 ? 'true' : 'false'}
              data-tone={c.key === 'conflict' && c.n > 0 ? 'conflict' : undefined}
            >
              {c.text}
            </li>
          ))}
        </ul>
      )}
      <Button onClick={() => showCommitChanges({ revealCommitChanges, setDockMaximized })}>
        {t.openCommitTool}
      </Button>
    </div>
  );
}

/**
 * 저장소 탭 Git 도구 창 로그 탭의 오른쪽 칸 (CD-09): 범위를 골랐으면 범위 상세, commit 을 골랐으면 commit 상세(부모·자식
 * 이동·서명·파일 메뉴·포함 branch), 아무것도 안 골랐으면 작업 트리 변경 요약. 스태시 상세는 그리지 않는다 — W23 에서
 * Commit 도구 창의 Stash 탭으로 옮겼고 로그의 선택과 독립이다. 영역 이름은 `git-detail` (⌘3)
 */
function RepoDetailPane() {
  const s = useSession((st) => ({
    range: st.range !== null,
    commit: st.selectedCommit !== null,
  }));
  return (
    <div className={styles.detail} tabIndex={-1} data-panel="git-detail">
      {s.range ? <RangeDetail /> : s.commit ? <CommitDetail /> : <WorkTreeSummary />}
    </div>
  );
}

/**
 * 저장소 탭 Git 도구 창의 로그 탭 (WS-15·LG-14, W21·W22): 폴더 탭과 같은 틀(`GitLogSplit`)에 세로 툴바(BT-05) + [왼쪽 칸 |
 * 그래프(머리줄·필터·찾기 그대로) | 상세]. 왼쪽 칸은 브랜치 트리 하나다 (W22 — 옛 사이드바의 로컬·원격·태그·워크트리·
 * 백업). 옛 사이드바의 나머지는 모두 옮겼다: 스태시 → Commit 도구 창(W23), PR → Pull Requests 도구 창(W24), superproject·
 * 모듈·서브모듈·중첩 저장소 → Project 도구 창(W25).
 * 칸 크기·왼쪽 칸 펼침은 폴더 탭의 로그 탭과 같은 저장 키를 쓴다 (앱 전역 1벌)
 */
export function RepoGitLog() {
  const side = useGitLogSide();
  const branches = useRepoBranchTree(side);
  const t = S.workspace.repoLog;
  // 그래프·상세는 브랜치 트리의 상태와 무관하다. 같은 요소를 넘겨, 브랜치 쪽이 바뀌어(작업 실행 중 등) 이 컴포넌트가 다시
  // 그려질 때 함께 다시 그려지지 않게 한다
  const log = useMemo(() => <GraphPane />, []);
  const detail = useMemo(() => <RepoDetailPane />, []);
  return (
    <GitLogSplit
      side={side}
      toolbar={<BranchToolbar {...branches.toolbar} />}
      branches={<BranchTree key={branches.key} {...branches.tree} />}
      log={log}
      detail={detail}
      resizeBranchesLabel={t.resizeSide}
      resizeDetailLabel={t.resizeDetail}
    >
      {branches.dialogs}
    </GitLogSplit>
  );
}
