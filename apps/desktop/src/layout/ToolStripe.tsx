import { Icon, type IconName, S } from '@mgit/ui';
import { useRovingToolbar } from '../components/roving';
import styles from './ToolStripe.module.css';

/** 띠의 버튼 하나 = 도구 창 하나 */
export interface StripeTool {
  id: string;
  icon: IconName;
  /** 도구 창 이름. 아이콘만 보이므로 접근성 이름과 툴팁으로 쓴다 */
  label: string;
  /** 그 도구 창이 지금 보이고 있는지 */
  active: boolean;
  /** 보이고 있으면 숨기고 아니면 보인다 */
  onToggle: () => void;
}

export interface ToolStripeProps {
  /** 위쪽 버튼: 왼쪽 도구 창들 */
  top: readonly StripeTool[];
  /** 아래쪽 버튼: 아래 도구 창들 */
  bottom: readonly StripeTool[];
}

/** 띠의 버튼 묶음 */
function StripeGroup({ tools }: { tools: readonly StripeTool[] }) {
  return (
    <div className={styles.group}>
      {tools.map((tool) => (
        <button
          key={tool.id}
          type="button"
          className={styles.button}
          aria-label={tool.label}
          aria-pressed={tool.active}
          title={tool.label}
          onClick={tool.onToggle}
        >
          <Icon name={tool.icon} />
        </button>
      ))}
    </div>
  );
}

/**
 * 왼쪽 도구 창 띠 (WS-05): 도구 창을 여닫는 아이콘 버튼 줄. 어떤 도구 창이 있는지는 목록으로만 받는다 —
 * 띠는 도구 창을 모르고, 목록에 항목을 더하면 버튼이 는다. 도구 막대(toolbar) 하나가 Tab 정지 하나다 (W19 ③):
 * 마지막으로 포커스를 받은 버튼만 Tab 으로 닿고, ↑↓·Home·End 로 옆 버튼에 포커스를 옮긴다(끝에서 돈다)
 */
export function ToolStripe({ top, bottom }: ToolStripeProps) {
  const roving = useRovingToolbar<HTMLDivElement>('vertical');
  return (
    <div
      ref={roving.ref}
      className={styles.stripe}
      role="toolbar"
      aria-label={S.workspace.stripe}
      aria-orientation="vertical"
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      <StripeGroup tools={top} />
      <StripeGroup tools={bottom} />
    </div>
  );
}
