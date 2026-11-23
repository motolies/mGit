import type { ContainingBranch } from '@mgit/ipc';
import { Icon, type IconName, S } from '@mgit/ui';
import { useState } from 'react';
import type { ContainingLoad } from '../../store/containing-loader';
import styles from './ContainingBranches.module.css';

/** 이 개수를 넘으면 앞쪽만 보이고 나머지는 `외 N개` 로 접는다 (HEAD 포함) */
export const CONTAINING_FOLD_AT = 10;

/** 상세 뷰가 받는 포함 브랜치 줄: 상태와 "다시 시도" 동작 */
export interface ContainingLine {
  load: ContainingLoad;
  /** 있으면 시간 초과·오류 때 "다시 시도" 를 그린다 */
  onRetry?: () => void;
}

/** 줄에 늘어놓을 이름 하나. 아이콘 색은 ref 라벨과 같은 토큰(`--ref-head`·`--ref-local`·`--ref-remote`) */
interface Item {
  key: string;
  text: string;
  tone: 'head' | 'local' | 'remote';
  icon: IconName;
  title: string;
}

/** 결과를 늘어놓을 순서의 이름들로: HEAD(포함하면) → 받은 순서(현재 브랜치 → 로컬 → 원격) */
function itemsOf(head: boolean, branches: readonly ContainingBranch[]): Item[] {
  const items: Item[] = head
    ? [{ key: 'HEAD', text: S.graph.headBadge, tone: 'head', icon: 'head', title: 'HEAD' }]
    : [];
  for (const b of branches) {
    items.push({
      key: b.name,
      text: b.shortName,
      tone: b.remote ? 'remote' : 'local',
      icon: b.remote ? 'remote' : 'branch',
      title: b.name,
    });
  }
  return items;
}

/** 시간 초과·오류 줄: 사유 한 줄 + "다시 시도" */
function Failed({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className={styles.line} data-state="failed">
      <span className={styles.muted}>{text}</span>
      {onRetry ? (
        <button type="button" className={styles.action} onClick={onRetry}>
          {S.detail.retry}
        </button>
      ) : null}
    </div>
  );
}

/**
 * 커밋을 포함하는 branch 줄 (CD-03): `branch N개에 포함: HEAD, development, origin/development, …`.
 * 읽는 중에도 한 줄을 차지해 다 읽혔을 때 아래 내용이 덜컹거리지 않는다. 10개를 넘으면 접고 `외 N개` 로
 * 펼친다(다시 접기도 된다). 이름이 길면 줄을 바꾼다. 스토어를 모르고 받은 상태만 그린다
 */
export function ContainingBranches({ load, onRetry }: ContainingLine) {
  const [expanded, setExpanded] = useState(false);
  if (load.state === 'loading') {
    return (
      <div className={styles.line} data-state="loading" aria-busy="true">
        <span className={styles.muted}>{S.detail.containingLoading}</span>
      </div>
    );
  }
  if (load.state === 'timedOut') {
    return <Failed text={S.detail.containingTimedOut} onRetry={onRetry} />;
  }
  if (load.state === 'error') {
    return <Failed text={S.detail.containingFailed(load.error)} onRetry={onRetry} />;
  }
  const items = itemsOf(load.refs.head, load.refs.branches);
  if (items.length === 0) {
    return (
      <div className={styles.line} data-state="ready">
        <span className={styles.muted}>{S.detail.containingNone}</span>
      </div>
    );
  }
  const folds = items.length > CONTAINING_FOLD_AT;
  const shown = folds && !expanded ? items.slice(0, CONTAINING_FOLD_AT) : items;
  return (
    <div className={styles.line} data-state="ready">
      <span className={styles.muted}>{S.detail.containing(items.length)}</span>
      <ul className={styles.list} aria-label={S.detail.containingList}>
        {shown.map((item, i) => (
          <li key={item.key} className={styles.item} data-tone={item.tone} title={item.title}>
            <Icon name={item.icon} className={styles.icon} />
            <span className={styles.name}>
              {item.text}
              {i < shown.length - 1 || (folds && !expanded) ? ',' : ''}
            </span>
          </li>
        ))}
        {folds ? (
          <li className={styles.item}>
            <button
              type="button"
              className={styles.action}
              aria-expanded={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded
                ? S.detail.containingLess
                : S.detail.containingMore(items.length - CONTAINING_FOLD_AT)}
            </button>
          </li>
        ) : null}
      </ul>
    </div>
  );
}
