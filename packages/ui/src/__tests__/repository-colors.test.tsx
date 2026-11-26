import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import rowCss from '../../../graph-view/src/GraphRow.module.css?raw';
import {
  REPOSITORY_RANGE_OPACITY,
  REPOSITORY_THEMES,
  REPOSITORY_TINT,
  RepositoryPaletteProvider,
  repositoryContrast,
  repositoryLab,
  repositoryPalette,
  repositoryRangeContrast,
  repositoryRosterKey,
  repositorySlotCount,
  repositoryTint,
  useRepositoryPalette,
} from '../repository-colors';
import tokens from '../tokens.css?raw';

type Rgb = readonly [number, number, number];
const rgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
/** 테스트도 실제 테마 토큰과 배경 혼합색의 대비를 검사한다. */
function colors(theme: 'light' | 'dark') {
  const selector = theme === 'light' ? ':root {' : ':root[data-theme="dark"] {';
  const block = tokens.slice(tokens.indexOf(selector));
  const body = block.slice(0, block.indexOf('}'));
  const read = (key: string) => {
    const value = new RegExp(`${key}: (#[a-fA-F0-9]{6})`).exec(body)?.[1];
    if (!value) throw Error(key);
    return rgb(value);
  };
  return { background: read('--bg'), foreground: read('--fg') };
}
function Probe() {
  const palette = useRepositoryPalette();
  return <output data-testid="palette">{palette?.join(',')}</output>;
}

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});
describe('저장소 전용 팔레트', () => {
  it('대비 계산은 실제 저장소 띠의 혼합률과 범위 선택 투명도를 따른다', () => {
    expect(Number(/var\(--repo-color\) (\d+)%/.exec(rowCss)?.[1]) / 100).toBe(REPOSITORY_TINT);
    expect(
      Number(
        /\.row\.inRange,\s*\.row\.inRange:hover\s*\{[^}]*opacity:\s*([\d.]+)/.exec(rowCss)?.[1],
      ),
    ).toBe(REPOSITORY_RANGE_OPACITY);
  });
  it.each([12, 20, 32])('%i개 저장소는 반복 색 없이 실제 표시색의 거리를 확보한다', (count) => {
    const palette = repositoryPalette(
      count,
      repositoryRosterKey(Array.from({ length: count }, (_, i) => `/repo/${i}`)),
    );
    for (const theme of ['light', 'dark'] as const) {
      expect(new Set(palette[theme]).size).toBe(count);
      const actual = colors(theme);
      expect(REPOSITORY_THEMES[theme]).toEqual(actual);
      const labs = palette[theme].map((color) => {
        const value = rgb(color);
        const strip = repositoryTint(value, actual.background);
        expect(repositoryContrast(strip, actual.foreground)).toBeGreaterThanOrEqual(4.5);
        expect(
          repositoryRangeContrast(strip, actual.foreground, actual.background),
        ).toBeGreaterThanOrEqual(4.5);
        expect(repositoryContrast(value, actual.background)).toBeGreaterThanOrEqual(3);
        return repositoryLab(strip);
      });
      let min = Infinity;
      labs.forEach((a, i) => {
        labs.slice(i + 1).forEach((b) => {
          min = Math.min(min, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
        });
      });
      expect(min).toBeGreaterThan(0.01);
    }
  });
  it.each([7, 12, 16])(
    '%i개 저장소는 파랑·분홍에 치우치지 않고 색상환 전체를 사용한다',
    (count) => {
      const palette = repositoryPalette(count, 'categorical');
      for (const theme of ['light', 'dark'] as const) {
        const bands = palette[theme].map((color) => {
          const [r, g, b] = rgb(color);
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const delta = max - min;
          const hue =
            ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) *
              60 +
              360) %
            360;
          return Math.floor((hue / 360) * Math.min(count, 8));
        });
        expect(new Set(bands).size).toBe(Math.min(count, 8));
      }
    },
  );
  it('256개를 넘어도 색 슬롯과 실제 RGB를 다시 순환하지 않는다', () => {
    const palette = repositoryPalette(300, 'large');
    expect(palette.light).toHaveLength(300);
    expect(new Set(palette.light).size).toBe(300);
    expect(new Set(palette.dark).size).toBe(300);
    for (const theme of ['light', 'dark'] as const)
      expect(
        new Set(
          palette[theme].map((color) =>
            repositoryTint(rgb(color), REPOSITORY_THEMES[theme].background)
              .map(Math.round)
              .join(','),
          ),
        ).size,
      ).toBe(300);
  });
  it('같은 집합은 순서와 중복에 무관하고 추가·삭제 때 새 집합으로 재배정한다', () => {
    const key = repositoryRosterKey(['/b', '/a']);
    expect(repositoryPalette(2, key)).toEqual(
      repositoryPalette(2, repositoryRosterKey(['/a', '/b', '/a'])),
    );
    expect(repositoryPalette(2, key)).not.toEqual(
      repositoryPalette(3, repositoryRosterKey(['/a', '/b', '/c'])),
    );
    expect(repositoryPalette(2, key)).not.toEqual(
      repositoryPalette(2, repositoryRosterKey(['/a', '/c'])),
    );
  });
  it('현재 전체 요약은 오래된 타임라인 슬롯을 제외하고 worktree 공유 슬롯을 유지한다', () => {
    expect(
      repositorySlotCount(
        ['/a', '/a-wt', '/b'],
        [
          { path: '/a', color: 0 },
          { path: '/a-wt', color: 0 },
          { path: '/b', color: 1 },
        ],
        [{ color: 12 }],
      ),
    ).toBe(2);
    expect(repositorySlotCount(['/a', '/b'], [], [{ color: 0 }, { color: 1 }])).toBe(2);
  });
  it('CSS와 Canvas 값이 같고 테마·집합 변경 뒤 포털용 CSS도 함께 갱신한다', async () => {
    const { rerender } = render(
      <RepositoryPaletteProvider count={20} roster="set-a">
        <Probe />
      </RepositoryPaletteProvider>,
    );
    expect(document.documentElement.style.getPropertyValue('--repo-color-19')).toBe(
      screen.getByTestId('palette').textContent?.split(',')[19],
    );
    act(() => {
      document.documentElement.dataset.theme = 'dark';
    });
    await waitFor(() =>
      expect(screen.getByTestId('palette').textContent).toBe(
        repositoryPalette(20, 'set-a').dark.join(','),
      ),
    );
    rerender(
      <RepositoryPaletteProvider count={12} roster="set-b">
        <Probe />
      </RepositoryPaletteProvider>,
    );
    expect(document.documentElement.style.getPropertyValue('--repo-color-19')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--repo-color-11')).toBe(
      repositoryPalette(12, 'set-b').dark[11],
    );
  });
});
