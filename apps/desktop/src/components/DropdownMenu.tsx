import * as Radix from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import styles from './ContextMenu.module.css';

/** 드롭다운 항목. 라디오 그룹은 한 값만, 체크는 켜고 끔 */
export type DropdownItem =
  | { kind: 'label'; label: string }
  | { kind: 'separator' }
  | {
      kind: 'check';
      label: string;
      checked: boolean;
      onChange: (checked: boolean) => void;
      disabled?: boolean;
    }
  | {
      kind: 'radio';
      value: string;
      onChange: (value: string) => void;
      /** 선택지. `disabled` 면 그 선택지만 고를 수 없다 (W25 — 묶음 전체는 아래 `disabled`) */
      options: { value: string; label: string; disabled?: boolean }[];
      disabled?: boolean;
      /**
       * 참이면 고른 뒤 메뉴를 닫는다 (W25 — 고르면 다른 곳의 결과를 보여 주는 메뉴). 기본은 열어 둔다 (옵션을 여러 번
       * 바꾸는 메뉴)
       */
      closeOnSelect?: boolean;
    }
  | { kind: 'item'; label: string; onSelect: () => void; disabled?: boolean };

export interface DropdownMenuProps {
  /** 버튼 등 트리거 요소 (asChild) */
  trigger: ReactNode;
  items: DropdownItem[];
  align?: 'start' | 'end';
}

/** 항목 하나를 Radix 요소로 */
function renderItem(item: DropdownItem, i: number): ReactNode {
  const key = `${i}:${item.kind}`;
  switch (item.kind) {
    case 'label':
      return (
        <Radix.Label key={key} className={styles.label}>
          {item.label}
        </Radix.Label>
      );
    case 'separator':
      return <Radix.Separator key={key} className={styles.separator} />;
    case 'check':
      return (
        <Radix.CheckboxItem
          key={key}
          className={styles.item}
          checked={item.checked}
          disabled={item.disabled}
          onCheckedChange={(v) => item.onChange(v === true)}
          onSelect={(e) => e.preventDefault()}
        >
          <span className={styles.indicator}>
            <Radix.ItemIndicator>✓</Radix.ItemIndicator>
          </span>
          {item.label}
        </Radix.CheckboxItem>
      );
    case 'radio':
      return (
        <Radix.RadioGroup key={key} value={item.value} onValueChange={item.onChange}>
          {item.options.map((o) => (
            <Radix.RadioItem
              key={o.value}
              className={styles.item}
              value={o.value}
              disabled={item.disabled || o.disabled}
              onSelect={item.closeOnSelect ? undefined : (e) => e.preventDefault()}
            >
              <span className={styles.indicator}>
                <Radix.ItemIndicator>●</Radix.ItemIndicator>
              </span>
              {o.label}
            </Radix.RadioItem>
          ))}
        </Radix.RadioGroup>
      );
    case 'item':
      return (
        <Radix.Item
          key={key}
          className={styles.item}
          disabled={item.disabled}
          onSelect={item.onSelect}
        >
          <span className={styles.indicator} />
          {item.label}
        </Radix.Item>
      );
  }
}

/**
 * 클릭으로 여는 드롭다운 메뉴. 체크·라디오 항목은 고른 뒤에도 메뉴가 닫히지 않는다 (라디오는 `closeOnSelect` 로 닫게 할 수
 * 있다). 항목이 창 높이를 넘으면 메뉴 안에서 스크롤한다 (W25 — 넘치지 않으면 모양·크기가 그대로다)
 */
export function DropdownMenu({ trigger, items, align = 'end' }: DropdownMenuProps) {
  return (
    <Radix.Root>
      <Radix.Trigger asChild>{trigger}</Radix.Trigger>
      <Radix.Portal>
        <Radix.Content
          className={`${styles.content} ${styles.dropdown}`}
          align={align}
          sideOffset={4}
        >
          {items.map(renderItem)}
        </Radix.Content>
      </Radix.Portal>
    </Radix.Root>
  );
}
