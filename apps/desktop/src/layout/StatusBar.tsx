import { S } from '@mgit/ui';
import { branchText, syncTexts } from '../features/project/project-rows';
import type { LoadState } from '../store';
import {
  headBranchOf,
  opLabel,
  useActiveTab,
  useAppStore,
  useFolder,
  useIsRepoTab,
  useSession,
  useWorkspace,
} from '../store';
import { baseName } from '../store/fs-path';
import styles from './StatusBar.module.css';

/** 로드 진행 문구 */
function loadText(loadState: LoadState, totalRows: number, error: string | undefined): string {
  switch (loadState) {
    case 'opening':
      return S.status.opening;
    case 'streaming':
      return S.status.loading(totalRows);
    case 'complete':
      return S.status.loaded(totalRows);
    case 'error':
      return error ?? S.error.unknown;
  }
}

/**
 * 폴더 탭의 활성 저장소 (WS-07): 이름, 브랜치, 0 이 아닌 ahead·behind. 활성 저장소는 프로젝트 트리 선택과
 * 활성 에디터 탭이 정한다 (워크스페이스 스토어). 요약을 아직 못 읽었으면 이름만 보인다. 그 폴더에서 저장소 세션을
 * 여는 중이면 "여는 중" 을 함께 보인다 (W13 — 세션 기능을 요청한 저장소가 활성 저장소가 된다)
 */
function FolderRepoStatus() {
  const activeRepo = useWorkspace((w) => w.activeRepo) ?? null;
  const summary = useFolder((st) =>
    activeRepo === null ? null : (st.summaries.find((s) => s.path === activeRepo) ?? null),
  );
  const folderId = useActiveTab()?.id ?? null;
  const opening = useAppStore((s) =>
    folderId === null ? null : (s.repoSessionOpening[folderId] ?? null),
  );
  const openingLine =
    opening !== null ? (
      <span className={styles.item} role="status">
        {S.repoSession.opening(
          opening === activeRepo && summary ? summary.name : baseName(opening),
        )}
      </span>
    ) : null;
  if (activeRepo === null) {
    return (
      <>
        <span className={styles.item}>{S.status.noActiveRepo}</span>
        {openingLine}
      </>
    );
  }
  const branch = summary ? branchText(summary) : null;
  const sync = summary && summary.error === null ? syncTexts(summary) : [];
  return (
    <>
      <span className={styles.branch} title={S.status.activeRepo(activeRepo)}>
        {summary?.name ?? baseName(activeRepo)}
      </span>
      {branch !== null ? <span className={styles.item}>{branch}</span> : null}
      {sync.length > 0 ? <span className={styles.item}>{sync.join(' ')}</span> : null}
      {openingLine}
    </>
  );
}

/**
 * 최하단 상태 바: 현재 브랜치·진행 중 작업, 변경 수, ahead·behind, 로드 진행, git 버전. 세션 줄은 저장소 탭일 때만
 * 보인다 — 폴더 탭은 활성 저장소의 요약을 보이고, 숨은 세션이 열려 있어도 그 세션의 줄을 쓰지 않는다 (W13)
 */
export function StatusBar() {
  const folderTab = useActiveTab()?.kind === 'folder';
  const repoTab = useIsRepoTab();
  const s = useSession((st) => ({
    headState: st.refs.head.state,
    headBranch: headBranchOf(st.refs),
    unbornBranch: st.refs.head.state === 'unborn' ? st.refs.head.branch : '',
    op: st.op,
    summary: st.status.summary,
    loadState: st.loadState,
    totalRows: st.totalRows,
    error: st.error,
    reloading: st.reloading,
    reloadError: st.reloadError,
  }));
  const gitVersion = useAppStore((st) => st.gitVersion);
  const gitError = useAppStore((st) => st.gitError);

  const headText =
    s.headState === 'detached'
      ? S.status.detached
      : s.headState === 'unborn'
        ? S.status.unborn(s.unbornBranch)
        : (s.headBranch ?? '');
  const op = opLabel(s.op);
  const changes: string[] = [];
  if (s.summary.conflicted > 0) {
    changes.push(S.status.conflicted(s.summary.conflicted));
  }
  if (s.summary.staged > 0) {
    changes.push(S.status.staged(s.summary.staged));
  }
  if (s.summary.unstaged > 0) {
    changes.push(S.status.unstaged(s.summary.unstaged));
  }
  if (s.summary.untracked > 0) {
    changes.push(S.status.untracked(s.summary.untracked));
  }
  const sync: string[] = [];
  if (s.summary.ahead > 0) {
    sync.push(S.status.ahead(s.summary.ahead));
  }
  if (s.summary.behind > 0) {
    sync.push(S.status.behind(s.summary.behind));
  }
  if (s.summary.stashCount > 0) {
    sync.push(S.status.stashes(s.summary.stashCount));
  }

  return (
    <footer className={styles.statusBar}>
      {folderTab ? (
        <FolderRepoStatus />
      ) : (
        <span className={styles.branch}>{repoTab ? headText : S.status.noRepo}</span>
      )}
      {repoTab && op ? <span className={styles.op}>{op}</span> : null}
      {repoTab ? (
        <span className={styles.item} data-changes={changes.length > 0 ? 'dirty' : 'clean'}>
          {changes.length > 0 ? changes.join(' · ') : S.status.noChanges}
        </span>
      ) : null}
      {repoTab && sync.length > 0 ? <span className={styles.item}>{sync.join(' ')}</span> : null}
      <span className={styles.item} data-load-state={repoTab ? s.loadState : 'none'}>
        {repoTab ? loadText(s.loadState, s.totalRows, s.error) : ''}
      </span>
      {repoTab && s.reloading ? <span className={styles.item}>{S.status.reloading}</span> : null}
      {repoTab && s.reloadError ? (
        <span className={styles.item} data-load-state="error">
          {s.reloadError}
        </span>
      ) : null}
      <span className={styles.spacer} />
      <span className={styles.item} title={gitError ?? undefined}>
        {gitVersion ? S.status.gitVersion(gitVersion) : S.status.gitUnavailable}
      </span>
    </footer>
  );
}
