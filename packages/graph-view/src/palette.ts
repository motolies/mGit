// tokens.css 의 CSS 변수에서 레인 색을 읽는다. 테마가 바뀌면 다시 읽어야 한다.

export const LANE_COLOR_COUNT = 10;

const FALLBACK = [
  '#2f6feb',
  '#d9480f',
  '#2b8a3e',
  '#ae3ec9',
  '#e67700',
  '#0c8599',
  '#c92a2a',
  '#5c7cfa',
  '#868e96',
  '#a61e4d',
];

/** CSS 변수 하나를 읽는다. 비어 있으면 fallback */
export function readCssVar(name: string, fallback: string, root?: HTMLElement): string {
  if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') {
    return fallback;
  }
  const el = root ?? document.documentElement;
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  return value || fallback;
}

/** `--graph-lane-0..9` 를 읽어 팔레트 배열로 만든다 */
export function readPalette(root?: HTMLElement): string[] {
  const out: string[] = [];
  for (let i = 0; i < LANE_COLOR_COUNT; i++) {
    out.push(readCssVar(`--graph-lane-${i}`, FALLBACK[i] ?? '#888', root));
  }
  return out;
}
