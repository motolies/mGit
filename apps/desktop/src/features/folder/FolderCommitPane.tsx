import type { ChangedFile, CommitDetail } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useEffect } from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import type { MenuItem } from '../../components/ContextMenu';
import { repoNameOf, useFolder, useWorkspace } from '../../store';
import { sameSelection, type TimelineSelection } from '../../store/folder-store';
import { commitDiffDoc, type OpenMode } from '../../store/workspace-store';
import { ChangedFilesTree } from '../detail/ChangedFilesTree';
import { CommitDetailView } from '../detail/CommitDetailView';
import type { ContainingLine } from '../detail/ContainingBranches';
import { useRepoSessionActions } from '../workspace/repo-session-actions';
import { useCurrentFile } from '../workspace/use-current-file';
import styles from './FolderCommitPane.module.css';

/** 변경 파일 트리 | 커밋 상세 세로 분할의 저장 id (앱 전역 1벌). 키는 `react-resizable-panels:git-detail` */
const GIT_DETAIL_LAYOUT_ID = 'git-detail';
/** 위 칸(변경 파일 트리)·아래 칸(커밋 상세)의 패널 id. 저장된 배치의 키이자 DOM id 다 */
const GIT_DETAIL_FILES_ID = 'gitdetail-files';
const GIT_DETAIL_INFO_ID = 'gitdetail-info';

export interface FolderCommitPaneProps {
  /**
   * 상세의 부모·자식을 눌렀을 때: 그 커밋으로 로그를 옮기고 고른다. 로그의 스크롤은 로그 탭이 쥐고 있어
   * 바깥에서 받는다
   */
  onNavigate: (selection: TimelineSelection) => void;
}

/**
 * Git 도구 창 로그 탭의 오른쪽 칸 (폴더, CD-01·02·04·06): 위 = 고른 커밋의 변경 파일 트리, 아래 = 커밋 상세.
 * 폴더 스토어의 선택·상세를 읽어 영역 뷰에 넘기고, 파일을 누르면 에디터 공간에 커밋 diff 탭을 연다
 * (클릭 = 미리보기, 더블클릭·Enter·메뉴 = 고정). 로그 선택은 바꾸지 않는다 (선택 연동 규칙).
 * 저장소 세션을 만들지 않는다 (CD-05) — 상세·diff 모두 폴더 API 로 읽는다
 */
export function FolderCommitPane({ onNavigate }: FolderCommitPaneProps) {
  const f = useFolder((st) => ({
    selected: st.timeline.selected,
    detail: st.timeline.detail,
    info: st.timeline.info,
    cache: st.timeline.cache,
    reloadDetail: st.reloadTimelineDetail,
    containing: st.timeline.containing,
    showContaining: st.showContaining,
    retryContaining: st.retryContaining,
  }));
  const editCurrent = useCurrentFile();
  const openDoc = useWorkspace((w) => w.openDoc);
  // Blame·파일 히스토리·외부 도구는 그 커밋의 저장소 세션으로 연다 (W13 — 요청할 때만 열린다)
  const repoActions = useRepoSessionActions();
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: GIT_DETAIL_LAYOUT_ID });

  const selected = f?.selected ?? null;
  const state = f?.detail ?? null;
  // 지금 선택의 상세만 보인다 (선택이 바뀐 직후 옛 상세를 그리지 않는다)
  const current = state && sameSelection(state.of, selected) ? state : null;
  const detail = current?.state === 'ready' ? current.detail : null;
  const repo = selected ? f?.info?.repos.find((r) => r.path === selected.repoPath) : undefined;
  const repoName = repo?.name ?? (selected ? repoNameOf(selected.repoPath) : '');

  // 포함 branch (CD-03): 상세가 뜬 커밋만 스토어에 알린다. 스토어가 디바운스 뒤에 읽으므로 상세 응답을
  // 막지 않고, 로그를 빠르게 훑는 동안(상세가 바뀌는 동안)은 읽지 않는다
  const showContaining = f?.showContaining;
  const shownRepo = detail && selected ? selected.repoPath : null;
  const shownOid = detail && selected ? detail.oid : null;
  useEffect(() => {
    showContaining?.(
      shownRepo !== null && shownOid !== null ? { repoPath: shownRepo, oid: shownOid } : null,
    );
  }, [showContaining, shownRepo, shownOid]);
  // 칸이 내려가면(로그 탭을 떠나면) 예약한 읽기를 거둔다. 읽어 둔 것은 스토어에 남는다
  useEffect(() => () => showContaining?.(null), [showContaining]);

  /** 상세 뷰에 넘길 포함 branch 줄. 스토어의 상태가 지금 보이는 커밋의 것이 아니면 "읽는 중" 이다 */
  const containingLine = (d: CommitDetail): ContainingLine => {
    const entry = f?.containing ?? null;
    const shown = selected === null ? null : { repoPath: selected.repoPath, oid: d.oid };
    return {
      load: entry !== null && sameSelection(entry.of, shown) ? entry : { state: 'loading' },
      onRetry: () => f?.retryContaining(),
    };
  };

  /** 변경 파일의 diff 를 에디터 공간에 연다 (미리보기 / 고정) */
  const open = (d: CommitDetail, file: ChangedFile, mode: OpenMode) => {
    if (!selected || !openDoc) {
      return;
    }
    openDoc(
      commitDiffDoc({
        repoPath: selected.repoPath,
        repoName,
        oid: d.oid,
        path: file.path,
        oldPath: file.oldPath ?? null,
        merge: d.parents.length > 1,
      }),
      mode,
    );
  };

  /**
   * 변경 파일의 우클릭 메뉴 (CD-04): 저장소 탭의 같은 메뉴(diff·blame·히스토리·외부 도구)와 같은 뜻에 경로 복사.
   * 대상은 그 커밋의 저장소다 — 활성 저장소가 아니어도 요청하면 그 저장소가 활성 저장소가 된다. 지운 파일은 그 커밋에
   * 내용이 없어 blame 을 막는다
   */
  const fileMenu =
    (d: CommitDetail) =>
    (file: ChangedFile): MenuItem[] => {
      const repoPath = selected?.repoPath ?? null;
      const session: MenuItem[] =
        repoActions && repoPath !== null
          ? [
              {
                label: S.menu.blame,
                separator: true,
                disabled: file.change.kind === 'deleted',
                onSelect: () => repoActions.blame(repoPath, file.path, d.oid),
              },
              {
                label: S.menu.fileHistory,
                onSelect: () => repoActions.history(repoPath, file.path),
              },
              {
                label: S.menu.difftool,
                onSelect: () =>
                  repoActions.difftool(repoPath, { kind: 'commit', oid: d.oid, path: file.path }),
              },
            ]
          : [];
      return [
        { label: S.menu.showDiff, onSelect: () => open(d, file, 'pinned') },
        {
          label: S.fileView.editCurrent,
          disabled: repoPath === null,
          onSelect: () => {
            if (repoPath !== null) editCurrent(repoPath, file.path, repoName);
          },
        },
        ...session,
        {
          label: S.menu.copyPath,
          separator: session.length > 0,
          onSelect: () => void navigator.clipboard.writeText(file.path).catch(() => {}),
        },
      ];
    };

  /**
   * 분리 HEAD 표시: 고른 행이 그 저장소의 HEAD 인지. 로그가 읽어 둔 행에서 찾는다 (상세의 행 번호가 낡았으면
   * 커밋이 달라 거짓이 된다)
   */
  const isHead = (d: CommitDetail): boolean => {
    const at = d.row ?? null;
    if (at === null || !f) {
      return false;
    }
    const row = f.cache.slice(at, at + 1).rows[0];
    return row?.oid === d.oid && row.isHead;
  };

  /** 위 칸: 상태에 맞는 안내 또는 변경 파일 트리 */
  const filesArea = () => {
    if (!selected) {
      return <div className={styles.message}>{S.detail.pickCommit}</div>;
    }
    if (current?.state === 'error') {
      return (
        <div className={styles.message} role="alert">
          <span>{S.detail.failed(current.error ?? '')}</span>
          <Button onClick={() => f?.reloadDetail()}>{S.detail.retry}</Button>
        </div>
      );
    }
    if (!detail) {
      return <div className={styles.message}>{S.detail.loading}</div>;
    }
    if (detail.files.length === 0) {
      return <div className={styles.message}>{S.detail.noFiles}</div>;
    }
    return (
      <ChangedFilesTree
        // 커밋이 바뀌면 펼침·선택을 새로 시작한다
        key={`${selected.repoPath}\u0000${detail.oid}`}
        files={detail.files}
        root={{ name: repoName, color: repo?.color ?? null }}
        onPreview={(file) => open(detail, file, 'preview')}
        onOpen={(file) => open(detail, file, 'pinned')}
        menu={fileMenu(detail)}
      />
    );
  };

  return (
    <div className={styles.pane} tabIndex={-1} data-panel="git-detail">
      <Group orientation="vertical" defaultLayout={defaultLayout} onLayoutChanged={onLayoutChanged}>
        <Panel
          id={GIT_DETAIL_FILES_ID}
          defaultSize="60%"
          minSize="44px"
          style={{ overflow: 'hidden' }}
        >
          <div className={styles.files}>
            <div className={styles.bar}>
              <span className={styles.title}>{S.detail.changedFiles}</span>
            </div>
            {filesArea()}
          </div>
        </Panel>
        <Separator className={styles.separator} aria-label={S.detail.resize} />
        <Panel
          id={GIT_DETAIL_INFO_ID}
          defaultSize="40%"
          minSize="44px"
          style={{ overflow: 'hidden' }}
        >
          <div className={styles.info}>
            {detail && selected ? (
              <CommitDetailView
                detail={detail}
                isHead={isHead(detail)}
                onCopyHash={() => navigator.clipboard.writeText(detail.oid)}
                // 상세의 커밋이 지금 로그에 있을 때만 부모·자식으로 옮긴다 (없으면 옮길 행이 없다)
                onNavigate={
                  (detail.row ?? null) === null
                    ? undefined
                    : (oid) => onNavigate({ repoPath: selected.repoPath, oid })
                }
                containing={containingLine(detail)}
              />
            ) : null}
          </div>
        </Panel>
      </Group>
    </div>
  );
}
