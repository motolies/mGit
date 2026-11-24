import { formatShortcut } from '@mgit/ui';
import { defaultShortcut } from '../command-keymap';
import { useAppStore } from '../store';

/** 화면의 툴팁·메뉴도 실행과 같은 유효 키를 사용한다. null은 명시적 해제다. */
export function useCommandShortcut(id: string, fallback?: string): string | undefined {
  const override = useAppStore((s) => s.shortcutOverrides[id]);
  return override === undefined ? defaultShortcut(id, fallback) : (override ?? undefined);
}

/** 동작 이름에 실제 단축키가 있을 때만 덧붙인다. */
export function useCommandTitle(id: string, title: string, fallback?: string): string {
  const key = useCommandShortcut(id, fallback);
  return key ? `${title} (${formatShortcut(key)})` : title;
}
