import { describe, expect, it } from 'vitest';
import {
  BODY_PANEL,
  DEFAULT_DOCK_PERCENT,
  DOCK_PANEL,
  type DockMode,
  dockLayout,
  dockModeOf,
  dockModeOfLayout,
  dockPercentOf,
} from '../layout/BottomDock';

describe('아래 도구 창 슬롯의 분할 모양', () => {
  it('슬롯 상태에서 분할 모양을 정한다: 숨김이 최대화보다 먼저다', () => {
    expect(dockModeOf({ tool: null, maximized: false })).toBe('hidden');
    expect(dockModeOf({ tool: null, maximized: true })).toBe('hidden');
    expect(dockModeOf({ tool: 'git', maximized: false })).toBe('normal');
    expect(dockModeOf({ tool: 'terminal', maximized: false })).toBe('normal');
    expect(dockModeOf({ tool: 'terminal', maximized: true })).toBe('maximized');
  });

  it('숨김은 아래 패널을, 최대화는 위 패널을 접고 보통일 때만 기억한 높이를 쓴다', () => {
    expect(dockLayout('hidden', 30)).toEqual({ [BODY_PANEL]: 100, [DOCK_PANEL]: 0 });
    expect(dockLayout('maximized', 30)).toEqual({ [BODY_PANEL]: 0, [DOCK_PANEL]: 100 });
    expect(dockLayout('normal', 30)).toEqual({ [BODY_PANEL]: 70, [DOCK_PANEL]: 30 });
  });

  it('배치의 합은 언제나 100 이고 모양을 거꾸로 읽으면 같은 모양이다', () => {
    for (const mode of ['hidden', 'normal', 'maximized'] satisfies DockMode[]) {
      const layout = dockLayout(mode, 62.964);
      expect((layout[BODY_PANEL] ?? 0) + (layout[DOCK_PANEL] ?? 0)).toBeCloseTo(100);
      expect(dockModeOfLayout(layout)).toBe(mode);
    }
  });

  it('끌어서 접힌 배치를 알아본다', () => {
    expect(dockModeOfLayout({ [BODY_PANEL]: 100, [DOCK_PANEL]: 0 })).toBe('hidden');
    expect(dockModeOfLayout({ [BODY_PANEL]: 0, [DOCK_PANEL]: 100 })).toBe('maximized');
    expect(dockModeOfLayout({ [BODY_PANEL]: 78.443, [DOCK_PANEL]: 21.557 })).toBe('normal');
    // 패널이 빠진 배치는 슬롯이 없는 것으로 본다
    expect(dockModeOfLayout({})).toBe('hidden');
  });

  it('저장된 배치에서 보통 높이를 꺼내고, 없거나 접힌 값이면 기본 높이를 쓴다', () => {
    expect(dockPercentOf({ [BODY_PANEL]: 37.036, [DOCK_PANEL]: 62.964 })).toBe(62.964);
    expect(dockPercentOf(undefined)).toBe(DEFAULT_DOCK_PERCENT);
    expect(dockPercentOf({})).toBe(DEFAULT_DOCK_PERCENT);
    expect(dockPercentOf({ [BODY_PANEL]: 100, [DOCK_PANEL]: 0 })).toBe(DEFAULT_DOCK_PERCENT);
    expect(dockPercentOf({ [BODY_PANEL]: 0, [DOCK_PANEL]: 100 })).toBe(DEFAULT_DOCK_PERCENT);
    // 다른 패널 id 로 저장된 옛 값은 버린다
    expect(dockPercentOf({ body: 55, dock: 45 })).toBe(DEFAULT_DOCK_PERCENT);
    expect(DEFAULT_DOCK_PERCENT).toBe(45);
  });
});
