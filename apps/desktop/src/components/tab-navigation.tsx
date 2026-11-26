import { Icon, isImeKey } from '@mgit/ui';
import { type KeyboardEvent, type RefObject, useLayoutEffect } from 'react';
import { DropdownMenu } from './DropdownMenu';
import { hasModifier, rovingIndex } from './roving';
import styles from './tab-navigation.module.css';

/** 모든 탭 줄에서 수정키·IME를 보호하며 같은 방향키 규칙을 사용한다. */
export function tabNavigationIndex(
  event: KeyboardEvent,
  index: number,
  count: number,
): number | null {
  return isImeKey(event) || hasModifier(event)
    ? null
    : rovingIndex(event.key, index, count, 'horizontal');
}

/** 활성 탭이 바뀌면 포커스를 빼앗지 않고 가로 가시 영역 안으로만 이동한다. */
export function useRevealActiveTab(
  ref: RefObject<HTMLElement | null>,
  active: string | number | null,
): void {
  useLayoutEffect(() => {
    const box = ref.current;
    const tab = box?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (active === null || !box || !tab) return;
    const reveal = () => {
      const bounds = box.getBoundingClientRect();
      const item = tab.getBoundingClientRect();
      if (item.left < bounds.left) box.scrollLeft += item.left - bounds.left;
      else if (item.right > bounds.right) box.scrollLeft += item.right - bounds.right;
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(box);
    return () => observer.disconnect();
  }, [ref, active]);
}

/** 긴 탭 줄에서도 전체 제목을 보고 선택할 수 있는 공통 목록 메뉴다. */
export function TabListMenu({
  label,
  items,
  active,
  select,
}: {
  label: string;
  items: readonly { id: string; title: string }[];
  active: string | null;
  select: (id: string) => void;
}) {
  if (items.length < 2) return null;
  return (
    <DropdownMenu
      trigger={
        <button type="button" aria-label={label} title={label} className={styles.menuTrigger}>
          <Icon name="chevronDown" />
        </button>
      }
      items={[
        {
          kind: 'radio',
          value: active ?? '',
          onChange: select,
          options: items.map(({ id, title }) => ({ value: id, label: title })),
          closeOnSelect: true,
        },
      ]}
    />
  );
}
