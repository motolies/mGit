import tokensCss from '@mgit/ui/tokens.css?raw';
import { describe, expect, it } from 'vitest';
import rowCss from '../GraphRow.module.css?raw';
import { LANE_COLOR_COUNT } from '../palette';

// 저장소 띠의 색은 레인 토큰을 배경(--bg)에 섞은 결과다 (전용 토큰 없음, LF-09).
// 그 위에 저장소 이름을 --fg 로 쓰므로, 실제 토큰 값과 실제 CSS 의 섞는 비율로 대비를 계산해 지킨다.

type Rgb = [number, number, number];

/** 선택자 블록 하나에서 `--이름: #rrggbb` 선언을 읽는다 */
function readColors(source: string, selector: string): Map<string, string> {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = css.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`tokens.css 에 ${selector} 블록이 없습니다`);
  }
  const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
  const colors = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)) {
    if (m[1] && m[2]) {
      colors.set(m[1], m[2]);
    }
  }
  return colors;
}

/** `#rrggbb` → [r, g, b] (0~255) */
function rgbOf(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) {
    throw new Error(`#rrggbb 색이 아닙니다: ${hex}`);
  }
  return [m[1], m[2], m[3]].map((part) => Number.parseInt(part ?? '', 16)) as Rgb;
}

/** WCAG 상대 휘도 */
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** 두 색의 WCAG 대비 (1~21) */
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** `color-mix(in srgb, a p%, b)` 의 결과 (둘 다 불투명) */
function mixSrgb(a: Rgb, b: Rgb, ratio: number): Rgb {
  return a.map((v, i) => Math.round(v * ratio + (b[i] ?? 0) * (1 - ratio))) as Rgb;
}

/** 띠 CSS 가 레인 색을 섞는 비율 (0~1) */
function stripMixRatio(): number {
  const m = /color-mix\(in srgb, var\(--repo-color\) (\d+)%, var\(--bg\)\)/.exec(rowCss);
  if (!m?.[1]) {
    throw new Error('GraphRow.module.css 에서 띠 색의 color-mix 를 찾지 못했습니다');
  }
  return Number(m[1]) / 100;
}

const light = readColors(tokensCss, ':root');
const THEMES: Record<string, Map<string, string>> = {
  light,
  // 다크는 라이트(:root) 위에 덮어쓴다
  dark: new Map([...light, ...readColors(tokensCss, ':root[data-theme="dark"]')]),
};

/** 토큰의 색 값. 없으면 실패시킨다 */
function token(theme: string, name: string): Rgb {
  const value = THEMES[theme]?.get(name);
  if (!value) {
    throw new Error(`${theme} 테마에 ${name} 이 없습니다`);
  }
  return rgbOf(value);
}

describe('저장소 띠 위 이름 글자의 대비 (LG-02, LF-06)', () => {
  it('계산 함수가 알려진 값과 맞는다', () => {
    expect(contrast(rgbOf('#000000'), rgbOf('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrast(rgbOf('#767676'), rgbOf('#ffffff'))).toBeCloseTo(4.54, 2);
    expect(mixSrgb(rgbOf('#ff0000'), rgbOf('#0000ff'), 0.25)).toEqual([64, 0, 191]);
  });

  it('띠는 레인 색을 배경에 옅게(절반 미만) 섞는다', () => {
    const ratio = stripMixRatio();
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(0.5);
  });

  it.each(Object.keys(THEMES))('%s 테마: 레인 10색 모두 4.5:1 을 넘는다', (theme) => {
    const ratio = stripMixRatio();
    const fg = token(theme, '--fg');
    const bg = token(theme, '--bg');
    const low: string[] = [];
    for (let lane = 0; lane < LANE_COLOR_COUNT; lane++) {
      const strip = mixSrgb(token(theme, `--graph-lane-${lane}`), bg, ratio);
      const value = contrast(fg, strip);
      if (value < 4.5) {
        low.push(`--graph-lane-${lane}: ${value.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
  });
});
