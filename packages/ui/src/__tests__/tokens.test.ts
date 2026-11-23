import { describe, expect, it } from 'vitest';
import { contrastRatio, luminance as luminanceOf, readTokenBlock, rgbOf } from '../contrast';
import tokensCss from '../tokens.css?raw';

type Tokens = Map<string, string>;

/** 선택자 블록 하나에서 `--이름: 값` 선언을 읽는다 (공용 도우미 `readTokenBlock`) */
const readBlock = readTokenBlock;

/** `#rrggbb` 의 WCAG 상대 휘도. 다른 표기는 계산할 수 없으므로 실패시킨다 */
function luminance(hex: string): number {
  return luminanceOf(rgbOf(hex));
}

/** 두 색의 WCAG 대비(1~21) */
function contrast(a: string, b: string): number {
  return contrastRatio(rgbOf(a), rgbOf(b));
}

const lightBlock = readBlock(tokensCss, ':root');
const darkBlock = readBlock(tokensCss, ':root[data-theme="dark"]');
// 다크는 라이트(:root) 위에 덮어쓰므로 실제 적용 값은 둘을 합친 것이다
const THEMES: Record<string, Tokens> = {
  light: lightBlock,
  dark: new Map([...lightBlock, ...darkBlock]),
};

// W1 에서 새로 생긴 토큰 (LF-01, LF-03). 뒤따르는 화면이 이 이름에 기댄다.
// 배경·경계로 쓰는 것과 글자색으로 쓰는 것을 나눈다 — 대비 기준은 글자색에만 건다
const NEW_SURFACE_TOKENS = ['--bg-selected-inactive', '--panel-seam'];
const NEW_TEXT_TOKENS = [
  '--accent-text',
  '--vcs-branch',
  '--vcs-incoming',
  '--vcs-outgoing',
  '--status-added',
  '--status-modified',
  '--status-untracked',
  '--status-conflict',
  '--status-deleted',
  '--ref-head',
  '--ref-local',
  '--ref-remote',
  '--ref-tag',
];
const NEW_COLOR_TOKENS = [...NEW_SURFACE_TOKENS, ...NEW_TEXT_TOKENS];
const NEW_SIZE_TOKENS = [
  '--tree-row-h',
  '--tree-indent',
  '--icon-size',
  '--toolwindow-header-h',
  '--stripe-w',
  '--space-1',
  '--space-2',
  '--space-3',
  '--space-4',
  '--space-5',
  '--space-6',
  '--space-7',
];

// 본문 글자 조합 [글자, 배경] (LF-06)
const TEXT_PAIRS: [string, string][] = [
  ['--fg', '--bg'],
  ['--fg', '--bg-panel'],
  ['--fg', '--bg-hover'],
  ['--fg', '--bg-selected'],
  ['--fg', '--bg-selected-inactive'],
  ['--fg-muted', '--bg'],
  ['--fg-muted', '--bg-panel'],
  ...NEW_TEXT_TOKENS.flatMap((t): [string, string][] => [
    [t, '--bg'],
    [t, '--bg-panel'],
  ]),
];

const isColor = (value: string) => /^(#|rgba?\()/.test(value);

describe('WCAG 대비 계산', () => {
  it('알려진 값과 맞는다', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    // 흰 배경에서 AA 경계로 알려진 두 회색
    expect(contrast('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});

describe('디자인 토큰 구조 (LF-01, LF-03, LF-04)', () => {
  it('신규 색 토큰이 라이트·다크 블록 양쪽에 정의돼 있다', () => {
    const missing = NEW_COLOR_TOKENS.flatMap((t) => [
      ...(lightBlock.has(t) ? [] : [`light ${t}`]),
      ...(darkBlock.has(t) ? [] : [`dark ${t}`]),
    ]);
    expect(missing).toEqual([]);
  });

  it('신규 크기·간격 토큰이 두 테마에서 모두 값을 가진다', () => {
    const missing = Object.entries(THEMES).flatMap(([theme, tokens]) =>
      NEW_SIZE_TOKENS.filter((t) => !tokens.get(t)).map((t) => `${theme} ${t}`),
    );
    expect(missing).toEqual([]);
  });

  it('색 토큰은 한쪽 테마에만 있지 않다', () => {
    const lightColors = [...lightBlock].filter(([, v]) => isColor(v)).map(([k]) => k);
    const onlyLight = lightColors.filter((t) => !darkBlock.has(t));
    const onlyDark = [...darkBlock.keys()].filter((t) => !lightBlock.has(t));
    expect({ onlyLight, onlyDark }).toEqual({ onlyLight: [], onlyDark: [] });
  });

  it('다크의 패널 이음매는 에디터 배경과 같은 색이다', () => {
    const dark = THEMES.dark ?? new Map();
    expect(dark.get('--panel-seam')).toBe(dark.get('--bg'));
  });
});

describe('본문 글자 대비 4.5:1 (LF-06)', () => {
  it.each(Object.keys(THEMES))('%s 테마의 글자·배경 조합이 모두 기준을 넘는다', (theme) => {
    const tokens = THEMES[theme] ?? new Map();
    const failed = TEXT_PAIRS.map(([fg, bg]) => {
      const ratio = contrast(tokens.get(fg) ?? '', tokens.get(bg) ?? '');
      return { pair: `${fg} / ${bg}`, ratio: Math.round(ratio * 100) / 100 };
    }).filter(({ ratio }) => ratio < 4.5);
    expect(failed).toEqual([]);
  });

  it('다크에서 에디터 영역(--bg)이 도구 창(--bg-panel)보다 어둡다', () => {
    const dark = THEMES.dark ?? new Map();
    expect(luminance(dark.get('--bg') ?? '')).toBeLessThan(luminance(dark.get('--bg-panel') ?? ''));
  });
});
