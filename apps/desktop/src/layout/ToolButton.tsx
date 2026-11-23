import { Icon, type IconName } from '@mgit/ui';
import styles from './ToolButton.module.css';

export interface ToolButtonProps {
  icon: IconName;
  /** 버튼의 뜻. 아이콘만 보이므로 접근성 이름과 (따로 주지 않으면) 툴팁으로 쓴다 */
  label: string;
  /** 툴팁을 뜻과 다르게 줄 때 (꺼진 까닭 등) */
  title?: string;
  /** 켜고 끄는 버튼이면 지금 켜져 있는지 */
  pressed?: boolean;
  disabled?: boolean;
  /** -1 이면 Tab 순서에서 뺀다 (키보드로는 다른 길이 같은 일을 할 때 — 에디터 탭의 닫기는 Delete·⌘W) */
  tabIndex?: number;
  onClick: () => void;
}

/** 도구 창 머리·탭 막대에 놓는 작은 아이콘 버튼 */
export function ToolButton({
  icon,
  label,
  title,
  pressed,
  disabled,
  tabIndex,
  onClick,
}: ToolButtonProps) {
  return (
    <button
      type="button"
      className={styles.button}
      aria-label={label}
      aria-pressed={pressed}
      title={title ?? label}
      disabled={disabled}
      tabIndex={tabIndex}
      onClick={onClick}
    >
      <Icon name={icon} />
    </button>
  );
}
