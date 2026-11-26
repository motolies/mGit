/** 탭 문자 표시 폭. 글에서 알아낼 수 없으므로 탭·공백 파일 모두 지금까지의 값을 쓴다 */
export const EDITOR_TAB_SIZE = 4;
/** 감지하지 못했을 때의 들여쓰기 단위. CodeMirror 기본(공백 2칸)이라 지금까지의 동작과 같다 */
export const DEFAULT_INDENT_UNIT = '  ';
/** 감지에 쓰는 앞쪽 줄 수 상한 (1 MiB 파일에서도 한 번만 짧게 훑는다) */
const SCAN_LINES = 10_000;
/** 공백 들여쓰기로 인정하는 가장 넓은 칸 수. 더 넓은 차이는 정렬용 들여쓰기로 보고 버린다 */
const MAX_WIDTH = 8;

/** 탭이 문법상 필요한 파일인지 (make 레시피 줄은 탭으로 시작해야 한다) */
export function requiresTabs(path: string): boolean {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase();
  return (
    ['makefile', 'gnumakefile', 'bsdmakefile', 'makefile.am', 'makefile.in'].includes(name) ||
    /\.(mk|mak)$/.test(name)
  );
}

/**
 * 줄 앞 공백에서 들여쓰기 단위를 추정한다. 탭으로 시작하는 줄이 공백 줄보다 많으면 탭, 공백이 더 많으면 이웃한
 * 공백 들여쓰기 줄 사이의 칸 수 차이 중 가장 흔한 값(같으면 작은 값)을 고른다. 빈 줄·공백만 있는 줄은 건너뛰고,
 * 공백 뒤에 탭이 섞인 줄은 판단에서 뺀다. 1칸 차이는 블록 주석(` * `) 정렬로 흔하므로 더 넓은 차이가 있으면
 * 무시한다. 근거가 없거나 탭·공백 줄 수가 같으면 null
 */
export function detectIndentUnit(text: string): string | null {
  let tabs = 0;
  let spaces = 0;
  let previous = 0;
  const widths = new Map<number, number>();
  for (const line of text.split('\n', SCAN_LINES)) {
    const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
    if (lead.length === line.replace(/\r$/, '').length) continue;
    if (lead.startsWith('\t')) {
      tabs++;
      continue;
    }
    if (lead.includes('\t')) continue;
    if (lead.length > 0) spaces++;
    const width = Math.abs(lead.length - previous);
    previous = lead.length;
    if (width > 0 && width <= MAX_WIDTH) widths.set(width, (widths.get(width) ?? 0) + 1);
  }
  if (tabs === spaces) return null;
  if (tabs > spaces) return '\t';
  const wider = [...widths.keys()].some((width) => width > 1);
  let best = 0;
  let bestCount = 0;
  for (const [width, count] of widths) {
    if (width === 1 && wider) continue;
    if (count > bestCount || (count === bestCount && width < best)) {
      best = width;
      bestCount = count;
    }
  }
  return best > 0 ? ' '.repeat(best) : null;
}

/** 파일에 쓸 들여쓰기 단위. 탭이 필요한 파일은 늘 탭, 그 밖에는 내용으로 추정하고 실패하면 기본값 */
export function indentUnitFor(path: string, text: string): string {
  if (requiresTabs(path)) return '\t';
  return detectIndentUnit(text) ?? DEFAULT_INDENT_UNIT;
}
