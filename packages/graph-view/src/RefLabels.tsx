import { Icon, S } from '@mgit/ui';
import styles from './RefLabels.module.css';
import { startRefDrag } from './ref-drag';
import { foldRefLabels, type RefLabelItem } from './ref-labels';

/** 라벨 하나: 종류 색의 아이콘 + 글자. 브랜치 라벨은 끌어서 다른 행에 놓을 수 있다 (GRAPH-09) */
function RefLabelView({ item }: { item: RefLabelItem }) {
  const dragName = item.dragName;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 드래그 소스일 뿐 클릭 상호작용이 아니다
    <span
      className={styles.label}
      data-tone={item.tone}
      title={item.title}
      draggable={dragName !== null}
      onDragStart={(e) => {
        if (dragName !== null) {
          startRefDrag(e, dragName);
        }
      }}
    >
      <Icon name={item.icon} className={styles.icon} />
      {/* 현재 브랜치는 아이콘 모양·색으로 HEAD 를 겸한다. 아이콘은 보조 기술에서 숨으므로 글자로도 남긴다 */}
      {item.current ? <span className={styles.srOnly}>{S.graph.headBadge} </span> : null}
      <span className={styles.text}>{item.text}</span>
    </span>
  );
}

export interface RefLabelsProps {
  items: readonly RefLabelItem[];
  /** 라벨 영역의 글자 수 예산. 넘는 라벨은 `+N` 으로 접는다. 주지 않으면 모두 보인다 */
  budget?: number;
  /**
   * 줄바꿈 배치: 커밋 상세의 ref 줄처럼 라벨을 접지 않고 여러 줄로 늘어놓는다 (CD-02).
   * 기본은 로그 행의 한 줄 배치(제목 칸 오른쪽 끝, 영역 상한 절반)다
   */
  wrap?: boolean;
}

/**
 * ref 라벨들 (LG-03, CD-02). 로그 행에서는 제목 칸의 오른쪽 끝에 붙고, 예산을 넘는 라벨은 `+N` 으로 접어
 * 툴팁에 전체를 보인다. 커밋 상세에서는 같은 모양의 라벨을 줄바꿈하며 모두 보인다.
 * 라벨이 없으면 아무것도 그리지 않는다
 */
export function RefLabels({
  items,
  budget = Number.POSITIVE_INFINITY,
  wrap = false,
}: RefLabelsProps) {
  if (items.length === 0) {
    return null;
  }
  const { shown, hidden } = foldRefLabels(items, budget);
  return (
    <span className={styles.refs} data-wrap={wrap ? 'true' : undefined}>
      {shown.map((item) => (
        <RefLabelView key={item.key} item={item} />
      ))}
      {hidden.length > 0 ? (
        <span className={styles.more} title={items.map((item) => item.text).join('\n')}>
          {S.graph.refs.more(hidden.length)}
        </span>
      ) : null}
    </span>
  );
}
