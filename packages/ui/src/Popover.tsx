import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { isImeKey } from './keys';
import styles from './Popover.module.css';

/** 팝오버를 닫는 까닭: Esc, 바깥 클릭, 포커스가 바깥 요소로 옮겨 감 (Tab 등) */
export type PopoverCloseReason = 'escape' | 'outside' | 'blur';

/** 팝오버의 자리 (`position: fixed` 기준 px) */
export interface PopoverPlacement {
  top: number;
  left: number;
  /** 열린 쪽에 남은 높이. 내용이 이보다 길면 팝오버 안에서 스크롤한다 */
  maxHeight: number;
  side: 'below' | 'above';
}

/** 기준 요소와 팝오버 사이 간격, 창 가장자리 여백 (px) */
const GAP = 4;
const MARGIN = 8;

/**
 * 팝오버의 자리를 정한다 (순수 함수). 기준 요소 아래에 열고, 아래 자리가 내용보다 모자라면서 위가 더 넓으면 위에
 * 연다. 가로는 기준 요소의 왼쪽에 맞추되 창 밖으로 넘치지 않게 안으로 민다. 높이는 열린 쪽에 남은 자리까지다
 */
export function placePopover(
  anchor: { top: number; bottom: number; left: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
): PopoverPlacement {
  const below = viewport.height - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const side = size.height > below && above > below ? 'above' : 'below';
  const maxHeight = Math.max(0, side === 'below' ? below : above);
  const height = Math.min(size.height, maxHeight);
  const top = side === 'below' ? anchor.bottom + GAP : anchor.top - GAP - height;
  const left = Math.max(MARGIN, Math.min(anchor.left, viewport.width - size.width - MARGIN));
  return { top, left, maxHeight, side };
}

/** Tab 으로 닿는 요소 (팝오버 안에서 Tab 이 끝에 닿았는지 볼 때) */
const TABBABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * 이 Tab 이 팝오버 밖으로 나가는지: 지금 포커스가 마지막(⇧Tab 이면 첫) 조작 요소이거나, 팝오버 자신이거나, 조작 요소가
 * 없으면 참
 */
function leavesPopover(popover: HTMLElement | null, backward: boolean): boolean {
  if (!popover) {
    return false;
  }
  const items = [...popover.querySelectorAll<HTMLElement>(TABBABLE)];
  const active = document.activeElement;
  if (items.length === 0 || active === popover) {
    return true;
  }
  return active === (backward ? items[0] : items[items.length - 1]);
}

export interface PopoverProps {
  open: boolean;
  /** 기준 요소 (여는 단추). 팝오버는 이 요소에 붙고, 이 요소를 누르는 것은 "바깥 클릭"으로 보지 않는다 */
  anchor: HTMLElement | null;
  /** 닫기 요청. 포커스를 단추로 돌릴지는 부르는 쪽이 까닭을 보고 정한다 */
  onClose: (reason: PopoverCloseReason) => void;
  /** 보조 기술에 알릴 이름 */
  label: string;
  /** 열 때 포커스를 줄 요소. 없으면 팝오버 자신 */
  initialFocus?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}

/**
 * 단추에 붙는 작은 떠 있는 창 (필터 드롭다운 등). `document.body` 에 그려 도구 창의 `overflow` 에 잘리지 않고,
 * 창 밖으로 넘치지 않게 자리를 잡는다(`placePopover`). 바깥 클릭·Esc·포커스가 밖으로 나가면 `onClose` 를 부른다.
 * `role="dialog"` 라서 열린 동안에는 앱의 전역 단축키가 쉬고(Esc 가 미리보기 탭 등을 닫지 않는다), 안에서 누른 Esc 는
 * 이 팝오버만 닫는다
 */
export function Popover({
  open,
  anchor,
  onClose,
  label,
  initialFocus,
  className,
  children,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<PopoverPlacement | null>(null);
  // 바깥 클릭 판정이 열린 뒤의 최신 콜백을 쓰게 한다 (리스너를 다시 걸지 않는다)
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // 자리: 그리기 전에 재서 잡고, 창 크기가 바뀌면 다시 잡는다
  useLayoutEffect(() => {
    if (!open || !anchor) {
      setPlace(null);
      return;
    }
    const measure = () => {
      const el = ref.current;
      if (!el) {
        return;
      }
      const a = anchor.getBoundingClientRect();
      setPlace(
        placePopover(
          a,
          { width: el.offsetWidth, height: el.scrollHeight },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, anchor]);

  // 열면 안쪽에 포커스를 준다
  useEffect(() => {
    if (open) {
      (initialFocus?.current ?? ref.current)?.focus();
    }
  }, [open, initialFocus]);

  // 바깥 클릭: 팝오버·기준 단추 밖을 누르면 닫는다 (단추는 스스로 열고 닫는다)
  useEffect(() => {
    if (!open) {
      return;
    }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (ref.current?.contains(target) || anchor?.contains(target))) {
        return;
      }
      closeRef.current('outside');
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, anchor]);

  if (!open) {
    return null;
  }

  /**
   * Esc 는 이 팝오버만 닫는다 (한글 조합 중의 Esc 는 입력기 몫). Tab 이 팝오버 밖으로 나가는 자리(마지막 조작 요소의 Tab,
   * 첫 조작 요소의 ⇧Tab, 조작 요소가 없을 때)에서는 닫고 여는 단추로 포커스를 돌린다 (W19 ③) — 팝오버는 문서 끝에
   * 그려지므로 그대로 두면 포커스가 문서 밖(브라우저)이나 문서 처음으로 가 버린다
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !isImeKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      closeRef.current('escape');
      return;
    }
    if (e.key === 'Tab' && leavesPopover(ref.current, e.shiftKey)) {
      e.preventDefault();
      closeRef.current('blur');
      anchor?.focus();
    }
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      // 안의 포커스 받지 않는 곳을 눌러도 포커스가 팝오버에 남게 한다 (바깥으로 나간 것으로 보지 않게)
      tabIndex={-1}
      className={[styles.popover, className ?? ''].filter(Boolean).join(' ')}
      data-side={place?.side ?? 'below'}
      style={
        place
          ? { top: place.top, left: place.left, maxHeight: place.maxHeight }
          : // 재기 전에는 투명하게 둔다 (첫 자리를 잡기 전의 깜빡임). `visibility: hidden` 은 포커스를 막으므로 쓰지 않는다
            { top: 0, left: 0, opacity: 0 }
      }
      onKeyDown={onKeyDown}
      onBlur={(e) => {
        // 포커스가 바깥 요소로 옮겨 갔을 때만 닫는다. 받는 요소가 없으면(포커스를 받지 않는 곳 클릭 등) 바깥 클릭
        // 판정에 맡긴다 — WebKit 은 단추를 눌러도 포커스를 주지 않는다
        const next = e.relatedTarget as Node | null;
        if (next && !ref.current?.contains(next) && !anchor?.contains(next)) {
          closeRef.current('blur');
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
