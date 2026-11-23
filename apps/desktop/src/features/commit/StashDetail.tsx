import { Button, formatDateTime, S, shortHash } from '@mgit/ui';
import { useSession } from '../../store';
import styles from '../detail/CommitDetail.module.css';
import { changeLetter } from '../detail/change-letter';
import own from './StashDetail.module.css';
import { dropStash, popStash, type StashDeps } from './stash-actions';

/**
 * 고른 stash 의 상세 (ST-03·04): 이름·해시, apply/pop/drop, 메시지, 날짜·branch·출처 경로, 바뀐 파일 목록. W23 에서 Git
 * 도구 창 상세 칸에서 Commit 도구 창 Stash 탭의 아래 칸으로 옮겼다 — 요소는 옛 것과 같고, 좁고 낮은 칸에서도 닿게 단추
 * 줄을 머리 바로 아래에 고정했다(나머지는 스크롤). 파일을 누르면 에디터에 그 파일의 diff 탭이 열린다. pop·drop 의 확인과
 * 뒤 동작은 우클릭 메뉴와 같은 함수다 (`stash-actions.ts` — pop 이 성공하면 변경 탭, drop 은 확인 뒤)
 */
export function StashDetail({ deps }: { deps: StashDeps }) {
  const s = useSession((st) => ({
    view: st.stashView,
    busy: st.busy,
    openCommitFile: st.openCommitFile,
    openPath:
      st.selectedFile?.commit === st.stashView?.entry.info.oid ? st.selectedFile?.path : null,
  }));
  const v = s.view;
  if (!v) {
    return null;
  }
  const info = v.entry.info;
  const name = S.stash.name(info.index);

  return (
    <section className={own.panel} aria-label={S.stash.title}>
      <header className={styles.header}>
        <span className={`${styles.title} ${own.title}`}>{S.stash.title}</span>
        <span className={`${styles.hash} ${own.hash}`} title={info.oid}>
          {name} · {shortHash(info.oid)}
        </span>
      </header>
      <div className={own.actions}>
        <Button
          variant="primary"
          disabled={s.busy}
          onClick={() => void deps.session.stashApply(info.oid)}
        >
          {S.stash.apply}
        </Button>
        <Button disabled={s.busy} onClick={() => void popStash(info.oid, deps)}>
          {S.stash.pop}
        </Button>
        <Button disabled={s.busy} onClick={() => void dropStash(v.entry, deps)}>
          {S.stash.drop}
        </Button>
      </div>
      <div className={styles.body}>
        <pre className={styles.message}>{info.message}</pre>
        <dl className={styles.meta}>
          <dt>{S.detail.author}</dt>
          <dd>{formatDateTime(info.time)}</dd>
          {info.branch ? (
            <>
              <dt>{S.stash.branchLabel}</dt>
              <dd>{info.branch}</dd>
            </>
          ) : null}
          {v.entry.origin ? (
            <>
              <dt>{S.stash.originLabel}</dt>
              <dd title={v.entry.origin}>{v.entry.origin}</dd>
            </>
          ) : null}
        </dl>
        <div className={styles.filesHeader}>
          {S.stash.files(v.files.length)}
          {info.includesUntracked ? ` · ${S.stash.untracked}` : ''}
        </div>
        <ul className={styles.files}>
          {v.files.map((f) => (
            <li
              key={f.path}
              className={styles.file}
              data-open={s.openPath === f.path ? 'true' : 'false'}
              title={f.path}
            >
              <button
                type="button"
                className={styles.fileButton}
                onClick={() => void s.openCommitFile(info.oid, f.path, f.oldPath ?? null)}
              >
                <span className={styles.letter} data-letter={changeLetter(f.change.kind)}>
                  {changeLetter(f.change.kind)}
                </span>
                <span className={styles.path}>{f.path}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
