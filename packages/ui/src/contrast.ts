// 디자인 토큰의 WCAG 대비 계산 (LF-06, W19 ③). 테스트가 토큰 CSS 를 읽어 글자색 × 배경색 짝의 대비를 지킨다.
// 앱 코드는 쓰지 않는다 — 화면은 토큰만 쓰고, 대비는 이 계산으로 토큰 값과 쓰는 자리를 검사한다.

/** 0~255 의 [r, g, b] */
export type Rgb = [number, number, number];

/** 토큰 이름 → 값 (`--fg` → `#dfe1e5`) */
export type TokenMap = ReadonlyMap<string, string>;

/** `#rrggbb` → [r, g, b]. 다른 표기는 계산할 수 없으므로 실패시킨다 */
export function rgbOf(hex: string): Rgb {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) {
    throw new Error(`#rrggbb 색이 아닙니다: ${hex}`);
  }
  return [m[1], m[2], m[3]].map((part) => Number.parseInt(part ?? '', 16)) as Rgb;
}

/** WCAG 상대 휘도 */
export function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** 두 색의 WCAG 대비 (1~21) */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** `color-mix(in srgb, a p%, b)` 의 결과 (둘 다 불투명, `ratio` 는 a 의 몫 0~1) */
export function mixSrgb(a: Rgb, b: Rgb, ratio: number): Rgb {
  return a.map((v, i) => Math.round(v * ratio + (b[i] ?? 0) * (1 - ratio))) as Rgb;
}

/** 선택자 블록 하나에서 `--이름: 값` 선언을 읽는다. 주석은 미리 걷어 낸다 */
export function readTokenBlock(css: string, selector: string): Map<string, string> {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = source.indexOf(`${selector} {`);
  if (start < 0) {
    throw new Error(`토큰 CSS 에 ${selector} 블록이 없습니다`);
  }
  const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('}', start));
  const tokens = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    if (m[1] && m[2]) {
      tokens.set(m[1], m[2].trim());
    }
  }
  return tokens;
}

/** 두 테마의 실제 적용 값: 라이트는 `:root`, 다크는 `:root` 위에 `[data-theme="dark"]` 를 덮어쓴 것 */
export function themeTokens(css: string): { light: TokenMap; dark: TokenMap } {
  const light = readTokenBlock(css, ':root');
  const dark = readTokenBlock(css, ':root[data-theme="dark"]');
  return { light, dark: new Map([...light, ...dark]) };
}

/**
 * 색 식을 색으로 (순수 함수): `--토큰`, `#rrggbb`, `mix(--a 30%, --b)`(= `color-mix(in srgb, a 30%, b)`).
 * 토큰이 없거나 계산할 수 없는 값이면 실패시킨다
 */
export function resolveColor(expr: string, tokens: TokenMap): Rgb {
  const e = expr.trim();
  const mix = /^mix\(\s*(\S+)\s+(\d+(?:\.\d+)?)%\s*,\s*(\S+)\s*\)$/.exec(e);
  if (mix?.[1] && mix[2] && mix[3]) {
    return mixSrgb(
      resolveColor(mix[1], tokens),
      resolveColor(mix[3], tokens),
      Number(mix[2]) / 100,
    );
  }
  if (e.startsWith('--')) {
    const value = tokens.get(e);
    if (value === undefined) {
      throw new Error(`토큰이 없습니다: ${e}`);
    }
    return resolveColor(value, tokens);
  }
  return rgbOf(e);
}
