import styles from './Icon.module.css';
import { type IconName, iconClassName } from './icon-set';

export interface IconProps {
  /** 의미 이름. 세트의 실제 아이콘 이름은 icon-set.ts 가 정한다 */
  name: IconName;
  className?: string;
}

/**
 * 아이콘 하나를 그린다. 크기는 --icon-size, 색은 글자색을 따른다.
 * 장식으로만 다루므로 보조 기술에서 숨긴다 — 뜻은 감싸는 버튼의 aria-label 이나 옆 글자가 전한다.
 */
export function Icon({ name, className }: IconProps) {
  const classes = [iconClassName(name), styles.icon, className ?? ''].filter(Boolean).join(' ');
  return <span aria-hidden="true" className={classes} />;
}
