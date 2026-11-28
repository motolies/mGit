import type { HTMLAttributes } from 'react';
import styles from './ToolGroup.module.css';

export interface ToolGroupProps extends HTMLAttributes<HTMLDivElement> {
  /** 묶음의 접근성 이름. 주면 `role="group"` 으로 알리고, 없으면 배치만 한다 */
  label?: string;
  /** 단추의 테두리를 겹쳐 붙인다. 하나의 컨트롤로 읽히는 묶음(배율·보기 모드)에만 쓴다 */
  segmented?: boolean;
}

/**
 * 기능이 같은 단추 묶음. 묶음 안은 촘촘하게(4px, 세그먼트는 0) 두고 묶음 사이 간격은 부모가 정한다.
 * 툴바의 방향키 이동은 부모 `role="toolbar"` 가 맡으므로 이 컴포넌트는 키 처리를 하지 않는다
 */
export function ToolGroup({ label, segmented = false, className, ...rest }: ToolGroupProps) {
  const classes = [styles.group, segmented ? styles.segmented : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div
      {...rest}
      className={classes}
      {...(label === undefined ? {} : { role: 'group', 'aria-label': label })}
    />
  );
}
