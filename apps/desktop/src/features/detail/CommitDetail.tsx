import type { CommitDetail as CommitDetailData } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { useEffect } from 'react';
import { ContextMenuArea } from '../../components/ContextMenu';
import { useRovingToolbar } from '../../components/roving';
import { useSession } from '../../store';
import styles from './CommitDetail.module.css';
import { CommitDetailView } from './CommitDetailView';
import { changeLetter } from './change-letter';

/**
 * 저장소 탭 상세의 변경 파일 평면 목록 (우클릭: diff·blame·히스토리·외부 도구). 목록이 Tab 정지 하나다 (W27 — 큰 목록의
 * 공용 규칙): 파일 단추 사이를 ↑↓·Home·End·PageUp·PageDown 으로 옮긴다(끝에서 멈춘다). 지금 단추만 `tabindex="0"` 이라
 * 로그의 Enter·⌘3(`focusTargetIn`)이 이 목록에 닿는다 — 폴더 탭의 변경 파일 트리와 같은 자리
 */
function CommitFileList({ detail: d }: { detail: CommitDetailData }) {
  const s = useSession((st) => ({
    openCommitFile: st.openCommitFile,
    openBlame: st.openBlame,
    openFileHistory: st.openFileHistory,
    openDifftool: st.openDifftool,
    openPath: st.selectedFile?.commit === st.selectedCommit ? st.selectedFile?.path : null,
  }));
  const roving = useRovingToolbar<HTMLUListElement>('vertical', { wrap: false });
  return (
    <>
      <div className={styles.filesHeader}>{S.detail.files(d.files.length)}</div>
      {d.files.length === 0 ? (
        <div className={styles.loading}>{S.detail.noFiles}</div>
      ) : (
        <ContextMenuArea<string>
          resolveTarget={(e) =>
            (e.target as HTMLElement | null)?.closest('[data-path]')?.getAttribute('data-path') ??
            null
          }
          items={(path) => {
            const file = d.files.find((f) => f.path === path);
            const deleted = file?.change.kind === 'deleted';
            return [
              {
                label: S.menu.showDiff,
                onSelect: () => void s.openCommitFile(d.oid, path, file?.oldPath ?? null),
              },
              {
                label: S.menu.blame,
                separator: true,
                disabled: deleted,
                onSelect: () => void s.openBlame(path, d.oid),
              },
              { label: S.menu.fileHistory, onSelect: () => void s.openFileHistory(path) },
              {
                label: S.menu.difftool,
                onSelect: () => void s.openDifftool({ kind: 'commit', oid: d.oid, path }),
              },
            ];
          }}
        >
          {/* 목록 안 단추 사이의 화살표 이동을 목록이 받는다 (W27) */}
          <ul
            ref={roving.ref}
            className={styles.files}
            onKeyDown={roving.onKeyDown}
            onFocus={roving.onFocus}
          >
            {d.files.map((f) => (
              <li
                key={f.path}
                className={styles.file}
                data-path={f.path}
                data-open={s.openPath === f.path ? 'true' : 'false'}
                title={f.oldPath ? `${f.path} ${S.changes.renamedFrom(f.oldPath)}` : f.path}
              >
                <button
                  type="button"
                  className={styles.fileButton}
                  onClick={() => void s.openCommitFile(d.oid, f.path, f.oldPath ?? null)}
                >
                  <span className={styles.letter} data-letter={changeLetter(f.change.kind)}>
                    {changeLetter(f.change.kind)}
                  </span>
                  <span className={styles.path}>{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </ContextMenuArea>
      )}
    </>
  );
}

/**
 * 우측 패널 (저장소 탭): 선택한 커밋의 상세 (GRAPH-04). 세션 스토어를 읽어 `CommitDetailView` 에 값과 동작
 * (해시 복사, 부모·자식으로 이동, 서명, 포함 branch 줄)을 넘기고, 변경 파일은 평면 목록을 파일 자리에 넣는다.
 * W21 에서 같은 틀의 트리로 옮긴다
 */
export function CommitDetail() {
  const s = useSession((st) => ({
    oid: st.selectedCommit,
    detail: st.detail,
    loading: st.detailLoading,
    headOid: st.refs.head.state === 'unborn' ? null : st.refs.head.oid,
    jumpToCommit: st.jumpToCommit,
    signature: st.detailSignature,
    containing: st.containing,
    showContaining: st.showContaining,
    retryContaining: st.retryContaining,
  }));
  // 포함 branch (CD-03): 상세가 뜬 커밋만 스토어에 알린다 (스토어가 디바운스 뒤에 읽는다)
  const showContaining = s.showContaining;
  const shownOid = s.detail?.oid ?? null;
  useEffect(() => {
    showContaining(shownOid);
  }, [showContaining, shownOid]);
  // 패널이 내려가면 예약한 읽기를 거둔다
  useEffect(() => () => showContaining(null), [showContaining]);
  if (!s.oid) {
    return null;
  }
  const d = s.detail;
  const oid = s.oid;
  return (
    <aside className={styles.panel}>
      {!d ? (
        <div className={styles.loading}>{s.loading ? S.detail.loading : ''}</div>
      ) : (
        <CommitDetailView
          detail={d}
          isHead={s.headOid === d.oid}
          onCopyHash={() => navigator.clipboard.writeText(oid)}
          onNavigate={(target) => void s.jumpToCommit(target)}
          signature={s.signature}
          files={<CommitFileList detail={d} />}
          containing={{
            // 스토어의 상태가 보이는 커밋의 것이 아니면 아직 "읽는 중" 이다
            load: s.containing?.of === d.oid ? s.containing : { state: 'loading' },
            onRetry: s.retryContaining,
          }}
        />
      )}
    </aside>
  );
}
