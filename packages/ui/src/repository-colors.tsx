import {
  createContext,
  type ReactNode,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

type Rgb = readonly [number, number, number];
type Lab = readonly [number, number, number];
export interface RepositoryPalette {
  light: readonly string[];
  dark: readonly string[];
}
// tokens.css 기본 테마와 함께 대비 검사한다. 색은 배경과 30%로 섞어 저장소 띠에 표시한다.
export const REPOSITORY_THEMES = {
  light: { background: [255, 255, 255] as Rgb, foreground: [28, 31, 38] as Rgb },
  dark: { background: [30, 31, 34] as Rgb, foreground: [223, 225, 229] as Rgb },
};
export const REPOSITORY_TINT = 0.3;
export const REPOSITORY_RANGE_OPACITY = 0.85;
const cache = new Map<string, RepositoryPalette>();
const Context = createContext<readonly string[] | null>(null);

/** sRGB 채널을 선형 광량으로 바꾼다. */
function linear(channel: number): number {
  const n = channel / 255;
  return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
}
/** WCAG 상대 휘도 대비이다. */
export function repositoryContrast(a: Rgb, b: Rgb): number {
  const luminance = (rgb: Rgb) =>
    0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** 실제 CSS color-mix의 sRGB 혼합색이다. */
export function repositoryTint(rgb: Rgb, background: Rgb): Rgb {
  return rgb.map(
    (n, i) => n * REPOSITORY_TINT + (background[i] ?? 0) * (1 - REPOSITORY_TINT),
  ) as unknown as Rgb;
}
/** 범위 선택 행의 85% 합성에서도 저장소 이름 대비를 유지한다. */
export function repositoryRangeContrast(strip: Rgb, foreground: Rgb, background: Rgb): number {
  const mix = (color: Rgb) =>
    color.map(
      (n, i) =>
        n * REPOSITORY_RANGE_OPACITY + (background[i] ?? 0) * (1 - REPOSITORY_RANGE_OPACITY),
    ) as unknown as Rgb;
  return repositoryContrast(mix(strip), mix(foreground));
}
/** OKLab 원저자의 공개 행렬을 사용한다: https://bottosson.github.io/posts/oklab/#converting-from-linear-srgb-to-oklab */
export function repositoryLab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(linear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
/** 색 거리의 제곱을 계산해 후보 비교에서 제곱근을 피한다. */
function distance(a: Lab, b: Lab): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}
/** HSL 후보를 정수 sRGB로 만든다. */
function hsl(h: number, s: number, l: number): Rgb {
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [channel(0), channel(8), channel(4)];
}
/** 팔레트 후보·CSS용 색을 직렬화한다. */
function hex(rgb: Rgb): string {
  return `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}
/** 저장소 집합은 정렬하고 중복을 제거하므로 탐색·필터 순서와 무관하다. */
export function repositoryRosterKey(paths: readonly string[]): string {
  return JSON.stringify([...new Set(paths)].sort());
}
/** 집합과 개수에 기반한 결정적인 시작점이다. */
function hash(text: string): number {
  let n = 2166136261;
  for (const c of text) {
    n = Math.imul(n ^ (c.codePointAt(0) ?? 0), 16777619);
  }
  return n >>> 0;
}

/**
 * 10색 순환 대신 실제 배경의 지각 거리를 넓히는 저장소 전용 팔레트를 만든다.
 * 처음 최대 8색은 색상환 구간을 고르게 쓰고, 처음 128색은 두 테마의 최소 거리를 최대화한다. 큰 집합은 고유한 후보를 이어 사용해 O(N²) UI 지연을 막는다.
 * 고유 RGB가 사람에게 항상 구별된다는 뜻은 아니므로 저장소 이름을 항상 함께 표시한다.
 */
export function repositoryPalette(count: number, roster: string): RepositoryPalette {
  const size = Math.max(0, Math.min(65536, Math.floor(count)));
  const key = `${size}:${roster}`;
  const known = cache.get(key);
  if (known) return known;
  if (size === 0) return { light: [], dark: [] };
  const seed = hash(key);
  let randomState = seed;
  // hue와 명도가 같은 수열에 묶이지 않도록 독립된 결정적 난수 표본을 사용한다.
  const random = () => {
    randomState = (randomState + 0x6d2b79f5) | 0;
    let value = Math.imul(randomState ^ (randomState >>> 15), 1 | randomState);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  const poolSize = Math.max(512, Math.min(4096, size * 4));
  const candidates: { light: string; dark: string; hue: number; labs: [Lab, Lab] }[] = [];
  const usedLight = new Set<string>();
  const usedDark = new Set<string>();
  const usedLightStrip = new Set<string>();
  const usedDarkStrip = new Set<string>();
  // 최대 후보수만 만들며 각 후보 생성은 저장소 수와 무관한 상수 작업이다.
  for (
    let i = 0;
    candidates.length < Math.max(size, poolSize) && i < Math.max(size, poolSize) * 64;
    i++
  ) {
    const hue = random() * 360;
    const saturation = 0.5 + 0.45 * random();
    const light = hsl(hue, saturation, 0.26 + 0.36 * random());
    const dark = hsl(hue, saturation, 0.52 + 0.32 * random());
    const lightHex = hex(light);
    const darkHex = hex(dark);
    if (usedLight.has(lightHex) || usedDark.has(darkHex)) continue;
    const lightStrip = repositoryTint(light, REPOSITORY_THEMES.light.background);
    const darkStrip = repositoryTint(dark, REPOSITORY_THEMES.dark.background);
    const lightStripKey = hex(lightStrip.map(Math.round) as unknown as Rgb);
    const darkStripKey = hex(darkStrip.map(Math.round) as unknown as Rgb);
    if (usedLightStrip.has(lightStripKey) || usedDarkStrip.has(darkStripKey)) continue;
    if (
      repositoryContrast(lightStrip, REPOSITORY_THEMES.light.foreground) < 4.5 ||
      repositoryContrast(darkStrip, REPOSITORY_THEMES.dark.foreground) < 4.5 ||
      repositoryRangeContrast(
        lightStrip,
        REPOSITORY_THEMES.light.foreground,
        REPOSITORY_THEMES.light.background,
      ) < 4.5 ||
      repositoryRangeContrast(
        darkStrip,
        REPOSITORY_THEMES.dark.foreground,
        REPOSITORY_THEMES.dark.background,
      ) < 4.5 ||
      repositoryContrast(light, REPOSITORY_THEMES.light.background) < 3 ||
      repositoryContrast(dark, REPOSITORY_THEMES.dark.background) < 3
    )
      continue;
    usedLight.add(lightHex);
    usedDark.add(darkHex);
    usedLightStrip.add(lightStripKey);
    usedDarkStrip.add(darkStripKey);
    candidates.push({
      hue,
      light: lightHex,
      dark: darkHex,
      labs: [repositoryLab(lightStrip), repositoryLab(darkStrip)],
    });
  }
  if (candidates.length < Math.max(size, poolSize))
    throw new Error('Repository palette candidate limit exceeded');
  const chosen: number[] = [];
  const used = new Set<number>();
  const nearest = new Float64Array(poolSize).fill(Infinity);
  // 작은 집합은 먼저 색상환 전체를 덮어 명도만 다른 파랑·분홍에 치우치지 않게 한다.
  const bands = Math.min(size, 8);
  const bandOf = (hue: number) => Math.floor((hue / 360) * bands);
  const centered = (hue: number) => {
    const position = ((hue / 360) * bands) % 1;
    return position >= 0.2 && position <= 0.8;
  };
  const usedBands = new Set<number>();
  let next = seed % poolSize;
  for (let i = 0; i < poolSize && !centered(candidates[next]?.hue ?? 0); i++)
    next = (next + 1) % poolSize;
  for (let n = 0; n < Math.min(size, 128); n++) {
    chosen.push(next);
    used.add(next);
    const selected = candidates[next];
    if (!selected) break;
    usedBands.add(bandOf(selected.hue));
    let best = -1;
    let bestDistance = -1;
    for (let i = 0; i < poolSize; i++) {
      if (used.has(i)) continue;
      const candidate = candidates[i];
      if (!candidate) continue;
      nearest[i] = Math.min(
        nearest[i] ?? Infinity,
        distance(candidate.labs[0], selected.labs[0]),
        distance(candidate.labs[1], selected.labs[1]),
      );
      if (n + 1 < bands && (usedBands.has(bandOf(candidate.hue)) || !centered(candidate.hue)))
        continue;
      if ((nearest[i] ?? -1) > bestDistance) {
        best = i;
        bestDistance = nearest[i] ?? -1;
      }
    }
    if (best < 0) best = candidates.findIndex((_, i) => i < poolSize && !used.has(i));
    next = best;
  }
  for (let i = 0; chosen.length < size; i++) if (!used.has(i)) chosen.push(i);
  const palette = {
    light: chosen.map((i) => candidates[i]?.light ?? '#444444'),
    dark: chosen.map((i) => candidates[i]?.dark ?? '#bbbbbb'),
  };
  if (cache.size >= 16) cache.delete(cache.keys().next().value ?? '');
  cache.set(key, palette);
  return palette;
}

/** 현재 전체 요약이 준비되면 이전 타임라인의 사라진 슬롯을 팔레트 크기에 섞지 않는다. */
export function repositorySlotCount(
  paths: readonly string[],
  summaries: readonly { path: string; color: number }[],
  timeline: readonly { color: number }[],
): number {
  const wanted = new Set(paths);
  const complete =
    summaries.length === wanted.size && summaries.every((repo) => wanted.has(repo.path));
  const max = summaries.reduce((size, repo) => Math.max(size, repo.color + 1), 0);
  return complete ? max : timeline.reduce((size, repo) => Math.max(size, repo.color + 1), max);
}

/** 일반 그래프 색과 저장소 전용 색은 별개이며 단독 컴포넌트에는 기존 토큰을 폴백한다. */
export function repositoryColor(color: number): string {
  return `var(--repo-color-${color}, var(--graph-lane-${color % 10}))`;
}
/** Canvas는 CSS var를 해석하지 못하므로 같은 팔레트의 실제 색 값을 제공한다. */
export function useRepositoryPalette(): readonly string[] | null {
  return useContext(Context);
}
/** 활성 폴더의 팔레트를 포털 포함 문서 전체에 적용하고 테마 전환을 따른다. */
export function RepositoryPaletteProvider({
  count,
  roster,
  children,
}: {
  count: number;
  roster: string;
  children: ReactNode;
}) {
  const palette = useMemo(() => repositoryPalette(count, roster), [count, roster]);
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark',
  );
  useLayoutEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => setDark(el.dataset.theme === 'dark'));
    observer.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  const colors = dark ? palette.dark : palette.light;
  useLayoutEffect(() => {
    const style = document.documentElement.style;
    const previous = colors.map((_, i) => style.getPropertyValue(`--repo-color-${i}`));
    colors.forEach((color, i) => {
      style.setProperty(`--repo-color-${i}`, color);
    });
    return () =>
      colors.forEach((_, i) => {
        const old = previous[i];
        if (old) style.setProperty(`--repo-color-${i}`, old);
        else style.removeProperty(`--repo-color-${i}`);
      });
  }, [colors]);
  return <Context.Provider value={colors}>{children}</Context.Provider>;
}
