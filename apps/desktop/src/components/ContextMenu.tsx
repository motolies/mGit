import * as RadixMenu from '@radix-ui/react-context-menu';
import { type MouseEvent, type ReactNode, useState } from 'react';
import styles from './ContextMenu.module.css';

/** 메뉴 항목. `children` 이 있으면 하위 메뉴 */
export interface MenuItem {
  label: string;
  onSelect?: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** 이 항목 앞에 구분선 */
  separator?: boolean;
  children?: MenuItem[];
}

export interface ContextMenuAreaProps<T> {
  /** 우클릭 위치에서 대상을 찾는다. null 이면 메뉴를 열지 않는다 */
  resolveTarget: (e: MouseEvent) => T | null;
  /** 대상에 맞는 메뉴 항목 */
  items: (target: T) => MenuItem[];
  className?: string;
  children: ReactNode;
}

/** 항목 목록을 Radix 요소로 */
function renderItems(items: MenuItem[]) {
  return items.map((item, i) => {
    const key = `${i}:${item.label}`;
    const separator = item.separator ? (
      <RadixMenu.Separator key={`${key}-sep`} className={styles.separator} />
    ) : null;
    if (item.children) {
      return [
        separator,
        <RadixMenu.Sub key={key}>
          <RadixMenu.SubTrigger className={styles.item} disabled={item.disabled}>
            {item.label}
            <span className={styles.chevron}>▸</span>
          </RadixMenu.SubTrigger>
          <RadixMenu.Portal>
            <RadixMenu.SubContent className={styles.content} sideOffset={2}>
              {renderItems(item.children)}
            </RadixMenu.SubContent>
          </RadixMenu.Portal>
        </RadixMenu.Sub>,
      ];
    }
    return [
      separator,
      <RadixMenu.Item
        key={key}
        className={item.danger ? styles.itemDanger : styles.item}
        disabled={item.disabled}
        onSelect={item.onSelect}
      >
        {item.label}
      </RadixMenu.Item>,
    ];
  });
}

/**
 * 영역 하나에 컨텍스트 메뉴를 단다 (GRAPH-05, BR-01). 가상 목록에서도 트리거는 하나뿐이고,
 * 우클릭 시 `resolveTarget` 이 `event.target.closest(...)` 로 대상을 찾는다
 */
export function ContextMenuArea<T>({
  resolveTarget,
  items,
  className,
  children,
}: ContextMenuAreaProps<T>) {
  const [target, setTarget] = useState<T | null>(null);
  return (
    <RadixMenu.Root
      onOpenChange={(open) => {
        if (!open) {
          setTarget(null);
        }
      }}
    >
      <RadixMenu.Trigger asChild>
        <div
          className={className}
          data-context-area=""
          onContextMenuCapture={(e) => {
            const t = resolveTarget(e);
            // 대상이 없으면 Radix 가 메뉴를 열지 않게 막는다. 다만 더 안쪽 영역의 항목일 수 있으면 그 영역에
            // 맡긴다: 여기서 막으면 안쪽 Radix 트리거도 defaultPrevented 를 보고 메뉴를 열지 않는다
            const innermost = (e.target as HTMLElement | null)?.closest('[data-context-area]');
            if (t === null && innermost === e.currentTarget) {
              e.preventDefault();
            }
            setTarget(t);
          }}
        >
          {children}
        </div>
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          className={styles.content}
          onCloseAutoFocus={(e) => {
            // 메뉴가 닫히면 우클릭한 자리로 포커스를 돌린다. 다만 고른 항목이 포커스를 다른 곳(새로 연 문서의 목록 등)으로
            // 이미 옮겼으면 되돌리지 않는다 — 되돌리면 그 이동을 덮는다. 아무 데도 없으면(body) 지금처럼 돌린다
            const active = document.activeElement;
            if (active && active !== document.body) {
              e.preventDefault();
            }
          }}
        >
          {target !== null ? renderItems(items(target)) : null}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}
