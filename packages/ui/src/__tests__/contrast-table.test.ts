import { describe, expect, it } from 'vitest';
import { contrastRatio, mixSrgb, resolveColor, rgbOf, themeTokens } from '../contrast';
import tokensCss from '../tokens.css?raw';

// 폴더 화면과 공용 부품에서 실제로 쓰는 글자색 × 배경색 짝 (LF-06, W19 ③).
// 짝을 더할 때는 "어디에 쓰는지" 를 적는다. 배경 이름: --bg = 에디터·로그·필터 바·대화상자, --bg-panel = 도구 창(트리)·
// 탭 막대·팝오버·콘솔, --bg-hover = 행 hover, --bg-selected = 선택 행(포커스), --bg-selected-inactive = 선택 행(비포커스)·
// 눌린 칩·걸린 필터 단추·좁힘 줄. 기준: 본문 글자 4.5:1, 아이콘·조작 요소의 경계·포커스 링 3:1 (WCAG 1.4.3·1.4.11).
// 꺼진 조작 요소(`disabled`·`aria-disabled`, 흐리게)는 WCAG 의 예외라 넣지 않는다. 저장소 띠 위의 이름은 graph-view 의 띠 대비
// 테스트가 지킨다. W27 에서 저장소 탭의 새 영역(브랜치 트리·Commit 탭·Stash·PR·필터 바)의 짝을 더했다.

/** 기준: 본문 글자 4.5, 아이콘·경계·포커스 링 3 */
type Kind = 'text' | 'ui';
const MIN: Record<Kind, number> = { text: 4.5, ui: 3 };

/** 짝 하나: 글자(또는 아이콘·경계) 색, 배경색, 기준, 쓰는 곳 */
interface Pair {
  fg: string;
  bg: string;
  kind: Kind;
  where: string;
}

/** 같은 글자색을 여러 배경에 쓰는 짝을 펼친다 */
function on(fg: string, bgs: readonly string[], kind: Kind, where: string): Pair[] {
  return bgs.map((bg) => ({ fg, bg, kind, where }));
}

const PLAIN = ['--bg', '--bg-panel', '--bg-hover'] as const;
const SELECTED = ['--bg-selected', '--bg-selected-inactive'] as const;
/** 작업 진행 띠의 배경 (`OpBand.module.css`) */
const OP_BAND = 'mix(--danger 12%, --bg-panel)';
const STATUS = [
  '--status-added',
  '--status-modified',
  '--status-untracked',
  '--status-conflict',
  '--status-deleted',
] as const;

const CONTRAST_PAIRS: readonly Pair[] = [
  // 본문 글자: 모든 면
  ...on(
    '--fg',
    [...PLAIN, ...SELECTED],
    'text',
    '본문 글자 (트리·로그·표·탭·팝오버·선택 행의 모든 글자)',
  ),
  ...on('--fg', [OP_BAND], 'text', '작업 진행 띠의 라벨·이름·안내'),
  // 흐린 글자: 트리의 보조 글자(날짜·크기·파일 수·경로)·로그의 작성자·날짜·해시·탭 보조 글자·콘솔의 시각·종류·사유 줄·자리 표시
  ...on('--fg-muted', PLAIN, 'text', '흐린 보조 글자·자리 표시 글자 (hover 행 포함)'),
  // 강조 글자: 링크·"더 보기"·복사·적용 전 표시·로그 안내 동작·좁힘 줄의 "전체 보기"
  // (콘솔 좁힘 줄의 "전체 보기"는 --bg-selected-inactive 위라 --fg + 밑줄이다 — 강조 글자는 다크 3.52:1)
  ...on('--accent-text', PLAIN, 'text', '링크·더 보기·복사·적용 전·안내 동작'),
  // 파일 상태: 프로젝트 트리·Commit 트리·변경 파일 트리의 이름·상태 문자 (선택 행은 --fg 로 바꾼다)
  ...STATUS.flatMap((t) => on(t, PLAIN, 'text', '파일 상태 이름·문자 (hover 행 포함)')),
  // 저장소 행의 브랜치·업스트림, 브랜치 트리의 ⇣N·⇡N
  ...on('--vcs-branch', PLAIN, 'text', '저장소 행의 브랜치·동기 표시'),
  ...on('--vcs-incoming', PLAIN, 'text', '브랜치 트리 ⇣N'),
  ...on('--vcs-outgoing', PLAIN, 'text', '브랜치 트리 ⇡N'),
  // 위험 글자: 콘솔의 실패 명령줄·트리의 작업 배지·오류 안내·개요 표의 오류 줄·Commit 창 오류
  ...on('--danger', PLAIN, 'text', '실패 명령줄·작업 배지·오류 안내'),
  ...on('--success', ['--bg', '--bg-panel'], 'text', '일괄 작업 결과의 성공 글자'),
  // Pull Requests 도구 창의 배지 (W24): 승인·검사 성공 = --success, 변경 요청·실패·충돌 = --danger, 나머지 = --fg-muted (위
  // 흐린 글자 짝). 도구 창(--bg-panel)과 행 hover(--bg-hover) 위. 고른 행은 --fg 로 바꾼다 (위 본문 글자 짝)
  ...on('--success', ['--bg-panel', '--bg-hover'], 'text', 'PR 배지의 성공 글자 (hover 행 포함)'),
  ...on('--danger', ['--bg-panel', '--bg-hover'], 'text', 'PR 배지의 위험 글자 (hover 행 포함)'),
  // 채움 위 글자: 오류 알약(툴바·상태 바·오류 줄)·위험 확인 단추, 강조 단추(Commit·Continue·확인)
  { fg: '--danger-fg', bg: '--danger', kind: 'text', where: '오류 알약·위험 확인 단추' },
  {
    fg: '--accent-fg',
    bg: '--accent-fill',
    kind: 'text',
    where: '강조 단추 글자 (Commit·Continue·확인 — hover 는 채움을 어둡게 해 대비가 오른다)',
  },
  // 아이콘 (3:1): ref 아이콘(로그·브랜치 트리·상세)·충돌 ⚠·띠의 눌린 도구 창 아이콘·체크 표시
  ...['--ref-head', '--ref-local', '--ref-remote', '--ref-tag'].flatMap((t) =>
    on(t, [...PLAIN, ...SELECTED], 'ui', 'ref 아이콘 (선택 행 포함 — 아이콘은 색을 바꾸지 않는다)'),
  ),
  ...on('--status-conflict', ['--bg-panel', '--bg-hover'], 'ui', '충돌 ⚠ 아이콘'),
  { fg: '--accent-fg', bg: '--accent', kind: 'ui', where: '띠의 눌린 도구 창 아이콘·체크 표시' },
  // 경계·표시 (3:1): 포커스 링, 고른 탭의 밑줄, 체크 칸 테두리, 콘솔 배지 테두리, 걸린 필터의 점(좁은 한 줄)
  ...on('--accent', ['--bg', '--bg-panel'], 'ui', '포커스 링·고른 탭의 밑줄·분할선 포커스'),
  ...on('--fg-muted', ['--bg', '--bg-panel'], 'ui', '체크 칸 테두리'),
  { fg: '--danger', bg: '--bg-panel', kind: 'ui', where: '콘솔 탭 배지 테두리' },
  { fg: '--danger', bg: OP_BAND, kind: 'ui', where: '작업 진행 띠의 라벨 테두리' },
  {
    fg: '--accent-text',
    bg: '--bg-selected-inactive',
    kind: 'ui',
    where: '필터 바 좁은 한 줄의 "조건 걸림" 점',
  },
  // 저장소 탭의 새 영역 (W20~W26 → W27 에서 확인)
  // 선택 행의 보조 글자: 브랜치 트리(저장소 소스)의 개수·차이·꼬리 글자·배지, Stash 목록의 branch 글자, PR 목록의 번호·
  // 작성자·배지는 선택 배경 위에서 흐린 글자 대신 본문 글자색을 쓴다 (`.row[aria-selected="true"] …`)
  ...on('--fg', SELECTED, 'text', '선택 행의 보조 글자 (브랜치 트리·Stash 목록·PR 목록)'),
  // 선택 행의 아이콘: 브랜치 트리의 그룹·워크트리 아이콘은 선택 행에서도 흐린 색 그대로다 (ref 아이콘은 위 짝)
  ...on('--fg-muted', SELECTED, 'ui', '선택 행의 흐린 아이콘 (브랜치 트리의 그룹·워크트리)'),
  // Commit 도구 창 탭 막대의 개수("Stash 3"): 도구 창 머리와 탭 hover 위
  ...on('--fg-muted', ['--bg-panel', '--bg-hover'], 'text', 'Commit 도구 창 탭의 개수 글자'),
  // 저장소 탭 필터 바의 보기 옵션 점(기본값이 아님): 점 둘레를 1px --bg 로 두른다 — 필터 바 배경과 같다
  { fg: '--accent-text', bg: '--bg', kind: 'ui', where: '필터 바 보기 옵션의 "바뀜" 점' },
  // 넣지 않은 것: ① PR 배지의 경계선(--border on --bg-panel, 라이트 1.27·다크 1.23) — 배지는 조작 요소가 아니고 뜻을
  // 글자("초안"·리뷰·검사·"충돌")와 글자색으로 전한다. 경계선은 모양을 다듬을 뿐 구분에 필요하지 않다 (WCAG 1.4.11 의
  // 대상이 아니다). ② 필터 바 잠금(aria-disabled, 쓰기 중)의 0.5 흐림 — 꺼진 조작 요소는 기준의 예외다 (위 머리말)
];

const THEMES = themeTokens(tokensCss);

/** 한 테마에서 짝의 대비 (소수 둘째 자리) */
function ratioOf(pair: Pair, theme: 'light' | 'dark'): number {
  const tokens = THEMES[theme];
  const value = contrastRatio(resolveColor(pair.fg, tokens), resolveColor(pair.bg, tokens));
  return Math.round(value * 100) / 100;
}

describe('대비 계산 도우미', () => {
  it('알려진 값과 맞는다', () => {
    expect(contrastRatio(rgbOf('#000000'), rgbOf('#ffffff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(rgbOf('#767676'), rgbOf('#ffffff'))).toBeCloseTo(4.54, 2);
    expect(mixSrgb(rgbOf('#ff0000'), rgbOf('#0000ff'), 0.25)).toEqual([64, 0, 191]);
  });

  it('색 식: 토큰·#rrggbb·mix 를 푼다', () => {
    const tokens = new Map([
      ['--a', '#ff0000'],
      ['--b', '#0000ff'],
      ['--c', 'var(--a)'],
    ]);
    expect(resolveColor('--a', tokens)).toEqual([255, 0, 0]);
    expect(resolveColor('#00ff00', tokens)).toEqual([0, 255, 0]);
    expect(resolveColor('mix(--a 25%, --b)', tokens)).toEqual([64, 0, 191]);
    expect(() => resolveColor('--없음', tokens)).toThrow();
    // 다른 토큰을 가리키는 값은 계산하지 않는다 (토큰 CSS 는 색 값만 쓴다)
    expect(() => resolveColor('--c', tokens)).toThrow();
  });
});

describe('폴더 화면·공용 부품의 대비 표 (LF-06, W19 ③)', () => {
  it.each(['light', 'dark'] as const)('%s 테마: 모든 짝이 기준을 넘는다', (theme) => {
    const failed = CONTRAST_PAIRS.map((pair) => ({ pair, ratio: ratioOf(pair, theme) }))
      .filter(({ pair, ratio }) => ratio < MIN[pair.kind])
      .map(
        ({ pair, ratio }) => `${pair.fg} / ${pair.bg} (${pair.kind}) = ${ratio} — ${pair.where}`,
      );
    expect(failed).toEqual([]);
  });

  it('새 토큰(--success·--danger-fg·--accent-fill)이 두 테마에 정의돼 있다', () => {
    for (const theme of ['light', 'dark'] as const) {
      for (const token of ['--success', '--danger-fg', '--accent-fill']) {
        expect(THEMES[theme].get(token), `${theme} ${token}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  // `MGIT_CONTRAST_TABLE=1` 로 돌리면 보고용 표를 찍는다 (평소에는 조용하다)
  it('보고용 표', () => {
    const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
      ?.env;
    if (!env?.MGIT_CONTRAST_TABLE) {
      return;
    }
    const rows = CONTRAST_PAIRS.map((pair) => ({
      짝: `${pair.fg} / ${pair.bg}`,
      기준: MIN[pair.kind],
      라이트: ratioOf(pair, 'light'),
      다크: ratioOf(pair, 'dark'),
      쓰는곳: pair.where,
    }));
    console.log(JSON.stringify(rows));
  });
});
