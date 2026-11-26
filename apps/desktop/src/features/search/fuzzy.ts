// 빠른 열기(⌘P)의 퍼지 매칭과 순위. 검색어를 공백으로 나눈 낱말마다 그 글자가 경로에 차례대로 나타나면
// 후보다(부분 순서, 대소문자 무시). 낱말끼리의 순서는 보지 않고 모두 맞아야 한다. 점수는 낱말마다 가장 좋은 맞춤을
// 동적 계획법으로 찾는다(fzf 와 같은 방식): 맞은 글자마다 기본점, 단어 경계(맨 앞·`/`·`-`·`_`·`.`·공백 뒤,
// camelCase 대문자)에 가산점, 이어진 글자는 그 덩어리 첫 글자의 경계 가산점을 이어받고, 건너뛴 칸은 감점. 낱말
// 전체가 파일 이름(마지막 경로 조각) 안에서 맞으면 가산점을 더한다. 경로가 짧을수록, 최근에 연 파일일수록 앞에 온다.
import { RECENT_FILES_LIMIT } from '../../store/recent-files';

/** 맞은 글자 하나의 기본점 */
const MATCH = 16;
/** 경로 맨 앞이나 `/` 바로 뒤에서 맞음 */
const BOUNDARY_SEGMENT = 10;
/** `-`·`_`·`.`·공백 바로 뒤에서 맞음 */
const BOUNDARY_WORD = 8;
/** 소문자·숫자 바로 뒤의 대문자에서 맞음 (camelCase) */
const BOUNDARY_CAMEL = 7;
/** 바로 앞 글자도 맞았을 때의 최소 가산점 (덩어리 첫 글자의 경계 가산점이 더 크면 그것) */
const CONSECUTIVE = 4;
/** 맞은 글자 사이를 건너뛰기 시작하는 감점 */
const GAP_START = 3;
/** 건너뛴 칸이 하나 늘 때마다 더하는 감점 */
const GAP_EXTEND = 1;
/** 낱말 전체가 파일 이름 안에서 맞음 */
const NAME_BONUS = 30;
/** 경로 글자 수를 이 수로 나눈 만큼 감점 (짧은 경로 우대) */
const LENGTH_DIVISOR = 4;
/** 가장 최근에 연 파일의 가산점. 최근 목록 순서에 따라 0 쪽으로 줄어든다 */
const RECENT_BONUS = 25;
/** 가산점을 주는 최근 파일 수 (루트마다 기억하는 최근 파일 수와 같다) */
const RECENT_LIMIT = RECENT_FILES_LIMIT;
/** 맞지 않음 */
const NONE = -1_000_000_000;

/** 순위에 든 파일 하나 */
export interface RankedFile {
  path: string;
  score: number;
  /** 강조할 글자 위치(UTF-16 위치, 오름차순). 빈 검색어면 비어 있다 */
  positions: number[];
}

/** 순위 결과: 앞에서부터 `limit` 개와, 검색어에 맞은 전체 파일 수 */
export interface RankResult {
  items: RankedFile[];
  total: number;
}

const lowerCache = new Map<number, number>();

/** 대소문자를 무시하는 비교용 글자 코드. ASCII 와 한글·한자는 바로, 나머지는 한 번 계산해 기억한다 */
function fold(code: number): number {
  if (code < 128) return code >= 65 && code <= 90 ? code + 32 : code;
  if ((code >= 0xac00 && code <= 0xd7a3) || (code >= 0x4e00 && code <= 0x9fff)) return code;
  let lower = lowerCache.get(code);
  if (lower === undefined) {
    const text = String.fromCharCode(code).toLowerCase();
    lower = text.length === 1 ? text.charCodeAt(0) : code;
    lowerCache.set(code, lower);
  }
  return lower;
}

/**
 * 대소문자를 무시하는 비교용 글자열 (`fold` 를 글자마다). 길이가 원래 글자열과 같아 찾은 위치를 그대로 원래 글자에 쓸 수
 * 있다 — `toLowerCase` 는 드물게 글자 수가 바뀐다 (Project 트리 이름 필터가 함께 쓴다)
 */
export function foldCase(text: string): string {
  // ASCII 만이면 내장 소문자 변환이 `fold` 와 같고 빠르다 (경로 대부분)
  let ascii = true;
  for (let i = 0; i < text.length && ascii; i++) ascii = text.charCodeAt(i) < 128;
  if (ascii) return text.toLowerCase();
  let out = '';
  for (let i = 0; i < text.length; i++) out += String.fromCharCode(fold(text.charCodeAt(i)));
  return out;
}

/** 한글 호환 자모(U+3131–U+318E)인지: 조합 중에 홀로 선 ㄱ·ㅏ 같은 글자 */
function isLoneJamo(code: number): boolean {
  return code >= 0x3131 && code <= 0x318e;
}

/**
 * 검색어를 낱말로 나눈다. 한글 조합 중에는 끝에 홀로 선 자모가 붙어 아무 경로와도 맞지 않으므로 떼어 내고 본다
 */
export function queryTokens(query: string): string[] {
  let end = query.length;
  while (end > 0 && isLoneJamo(query.charCodeAt(end - 1))) end--;
  return query.slice(0, end).split(/\s+/u).filter(Boolean);
}

/** 낱말 하나: 점수 계산용 비교 코드와, 빠른 거르기용 소문자·대문자 글자 */
interface Token {
  codes: Int32Array;
  lower: string[];
  upper: string[];
}

/** 낱말을 비교용 글자 코드와 대소문자 글자로 바꾼다. */
function toToken(token: string): Token {
  const codes = new Int32Array(token.length);
  const lower: string[] = [];
  const upper: string[] = [];
  for (let i = 0; i < token.length; i++) {
    codes[i] = fold(token.charCodeAt(i));
    const char = String.fromCharCode(codes[i] ?? 0);
    lower.push(char);
    const big = char.toUpperCase();
    upper.push(big.length === 1 ? big : char);
  }
  return { codes, lower, upper };
}

/**
 * 낱말의 글자가 경로의 `from` 부터 차례대로 모두 나타나는지 (점수 계산 전 빠른 거르기). 글자마다 소문자·대문자를
 * 내장 `indexOf` 로 찾아 경로 10만 개도 짧게 훑는다
 */
function isSubsequence(path: string, token: Token, from = 0): boolean {
  let at = from;
  for (let j = 0; j < token.lower.length; j++) {
    const lower = token.lower[j] ?? '';
    const upper = token.upper[j] ?? lower;
    const small = path.indexOf(lower, at);
    const big = upper === lower ? -1 : path.indexOf(upper, at);
    const next = small < 0 ? big : big < 0 ? small : Math.min(small, big);
    if (next < 0) return false;
    at = next + 1;
  }
  return true;
}

/** 경로의 `i` 번째 글자가 단어 경계에서 시작하면 그 가산점 */
function boundaryBonus(path: string, i: number): number {
  if (i === 0) return BOUNDARY_SEGMENT;
  const previous = path.charCodeAt(i - 1);
  if (previous === 47) return BOUNDARY_SEGMENT;
  if (previous === 45 || previous === 95 || previous === 46 || previous === 32)
    return BOUNDARY_WORD;
  const current = path.charCodeAt(i);
  const upper = current >= 65 && current <= 90;
  const lowerOrDigit = (previous >= 97 && previous <= 122) || (previous >= 48 && previous <= 57);
  return upper && lowerOrDigit ? BOUNDARY_CAMEL : 0;
}

/** 건너뛴 칸 수에 따른 감점 (1칸 이상) */
function gapCost(skipped: number): number {
  return GAP_START + (skipped - 1) * GAP_EXTEND;
}

// 낱말 길이만큼 쓰는 계산 칸. 경로마다 새로 만들지 않고 다시 쓴다
let previousHere = new Int32Array(32);
let gapBest = new Int32Array(32);
let chunkBonus = new Int32Array(32);

/**
 * 경로의 `from` 부터 낱말을 맞춘 가장 좋은 점수(맞지 않으면 `NONE`). 글자 위치를 하나씩 나아가며 낱말의 j 번째
 * 글자에 대해 세 값을 든다: `previousHere[j]` 바로 앞 글자에서 맞춘 최고점, `chunkBonus[j]` 그 맞춤이 속한 이어진
 * 덩어리의 경계 가산점, `gapBest[j]` 두 칸 이상 앞에서 맞추고 지금 글자까지 건너뛴 감점을 뺀 최고점. `table`·`runs`
 * 를 주면 위치마다의 점수와 "바로 앞 글자에서 이어졌는지"를 남겨 `positionsFrom` 이 맞은 자리를 되짚는다
 */
function align(
  path: string,
  from: number,
  codes: Int32Array,
  table?: Int32Array,
  runs?: Uint8Array,
): number {
  const m = codes.length;
  if (previousHere.length < m) {
    previousHere = new Int32Array(m * 2);
    gapBest = new Int32Array(m * 2);
    chunkBonus = new Int32Array(m * 2);
  }
  previousHere.fill(NONE, 0, m);
  gapBest.fill(NONE, 0, m);
  chunkBonus.fill(0, 0, m);
  let best = NONE;
  for (let i = from; i < path.length; i++) {
    const code = fold(path.charCodeAt(i));
    let bonus = -1;
    // 뒤에서부터 돌아야 j-1 칸이 아직 앞 글자 기준 값이다
    for (let j = m - 1; j >= 0; j--) {
      let here = NONE;
      let chunk = 0;
      let run = 0;
      if (code === codes[j]) {
        if (bonus < 0) bonus = boundaryBonus(path, i);
        if (j === 0) {
          here = MATCH + bonus;
          chunk = bonus;
        } else {
          const before = previousHere[j - 1] ?? NONE;
          const gapped = gapBest[j - 1] ?? NONE;
          const runChunk = Math.max(chunkBonus[j - 1] ?? 0, bonus);
          const viaRun = before === NONE ? NONE : before + MATCH + Math.max(runChunk, CONSECUTIVE);
          const viaGap = gapped === NONE ? NONE : gapped + MATCH + bonus;
          if (viaRun !== NONE && viaRun >= viaGap) {
            here = viaRun;
            chunk = runChunk;
            run = 1;
          } else if (viaGap !== NONE) {
            here = viaGap;
            chunk = bonus;
          }
        }
      }
      // 다음 글자를 위해: 바로 앞 자리의 맞춤에서 건너뛰기를 시작하거나 이미 건너뛰는 중인 것을 한 칸 늘린다
      const last = previousHere[j] ?? NONE;
      const gapping = gapBest[j] ?? NONE;
      const start = last === NONE ? NONE : last - GAP_START;
      const extend = gapping === NONE ? NONE : gapping - GAP_EXTEND;
      gapBest[j] = Math.max(start, extend);
      previousHere[j] = here;
      chunkBonus[j] = chunk;
      if (table) table[(i - from) * m + j] = here;
      if (runs) runs[(i - from) * m + j] = run;
    }
    const complete = previousHere[m - 1] ?? NONE;
    if (complete > best) best = complete;
  }
  return best;
}

/** `align` 이 남긴 표에서 최고점의 맞춤을 되짚어 맞은 글자 위치를 돌려준다. */
function positionsFrom(path: string, from: number, codes: Int32Array): number[] {
  const m = codes.length;
  const n = path.length - from;
  const table = new Int32Array(n * m);
  const runs = new Uint8Array(n * m);
  const best = align(path, from, codes, table, runs);
  if (best === NONE) return [];
  const at = (i: number, j: number) => table[i * m + j] ?? NONE;
  let i = 0;
  while (i < n && at(i, m - 1) !== best) i++;
  const positions = [i + from];
  for (let j = m - 1; j > 0; j--) {
    if (runs[i * m + j]) i -= 1;
    else {
      // 건너뛴 맞춤: 감점을 뺀 값이 같은 가장 가까운 앞 자리(두 칸 이상 앞)
      const gapped = at(i, j) - MATCH - boundaryBonus(path, i + from);
      let k = i - 2;
      while (k >= 0 && (at(k, j - 1) === NONE || at(k, j - 1) - gapCost(i - 1 - k) !== gapped)) k--;
      if (k < 0) break;
      i = k;
    }
    positions.push(i + from);
  }
  return positions.reverse();
}

/** 낱말 하나의 점수와 그 맞춤의 시작 위치. 파일 이름 안의 맞춤은 가산점을 더해 경로 전체 맞춤과 견준다 */
function tokenScore(path: string, nameStart: number, token: Token) {
  const whole = align(path, 0, token.codes);
  const inName =
    nameStart === 0
      ? whole
      : isSubsequence(path, token, nameStart)
        ? align(path, nameStart, token.codes)
        : NONE;
  const named = inName === NONE ? NONE : inName + NAME_BONUS;
  return named >= whole ? { score: named, from: nameStart } : { score: whole, from: 0 };
}

/** 최근 목록 순위에 따른 가산점 (가장 최근이 가장 크다) */
function recentBonus(rank: number | undefined): number {
  return rank === undefined ? 0 : Math.round((RECENT_BONUS * (RECENT_LIMIT - rank)) / RECENT_LIMIT);
}

/** 점수 높은 순, 같으면 짧은 경로, 그다음 경로 글자 순 */
function before(a: RankedFile, b: RankedFile): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.path.length !== b.path.length) return a.path.length < b.path.length;
  return a.path < b.path;
}

/** 정렬된 상위 목록에 넣고 `limit` 를 넘으면 맨 뒤를 버린다 */
function insertTop(top: RankedFile[], item: RankedFile, limit: number): void {
  const worst = top[top.length - 1];
  if (top.length >= limit && worst && !before(item, worst)) return;
  let low = 0;
  let high = top.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const other = top[mid];
    if (other && before(other, item)) low = mid + 1;
    else high = mid;
  }
  top.splice(low, 0, item);
  if (top.length > limit) top.pop();
}

/**
 * 파일 목록에서 검색어에 맞는 것을 점수 순으로 `limit` 개 고르고, 그 줄에 강조할 위치를 붙인다. 검색어가 비면 최근에
 * 연 파일(연 순서)을 앞에 두고 나머지는 목록 순서다
 */
export function rankFiles(
  files: readonly string[],
  query: string,
  recent: readonly string[],
  limit = 100,
): RankResult {
  const ranks = new Map<string, number>();
  for (const [index, path] of recent.slice(0, RECENT_LIMIT).entries())
    if (!ranks.has(path)) ranks.set(path, index);
  const tokens = queryTokens(query).map(toToken);
  if (tokens.length === 0) {
    const recentItems: RankedFile[] = [];
    const rest: RankedFile[] = [];
    for (const path of files) {
      const rank = ranks.get(path);
      if (rank !== undefined) recentItems.push({ path, score: -rank, positions: [] });
      else if (rest.length < limit) rest.push({ path, score: 0, positions: [] });
    }
    recentItems.sort((a, b) => b.score - a.score);
    return { items: [...recentItems, ...rest].slice(0, limit), total: files.length };
  }
  const top: RankedFile[] = [];
  let total = 0;
  scan: for (const path of files) {
    for (const token of tokens) if (!isSubsequence(path, token)) continue scan;
    const nameStart = path.lastIndexOf('/') + 1;
    let score = recentBonus(ranks.get(path)) - Math.floor(path.length / LENGTH_DIVISOR);
    for (const token of tokens) {
      const matched = tokenScore(path, nameStart, token).score;
      // 거르기는 낱말 글자의 대·소문자 한 쌍만 보므로, 드물게 점수 계산이 맞춤을 못 찾으면 뺀다
      if (matched === NONE) continue scan;
      score += matched;
    }
    total++;
    insertTop(top, { path, score, positions: [] }, limit);
  }
  for (const item of top) {
    const nameStart = item.path.lastIndexOf('/') + 1;
    const marked = new Set<number>();
    for (const token of tokens) {
      const { from } = tokenScore(item.path, nameStart, token);
      for (const position of positionsFrom(item.path, from, token.codes)) marked.add(position);
    }
    item.positions = [...marked].sort((a, b) => a - b);
  }
  return { items: top, total };
}

/**
 * 최근 파일 중 파일 목록에 아직 있는 것만 최근 순서대로 (지워지거나 옮겨진 파일을 "최근 파일"에서 뺀다). 목록을 한 번만
 * 훑는다
 */
export function presentRecent(recent: readonly string[], files: readonly string[]): string[] {
  const wanted = new Set(recent);
  const present = new Set<string>();
  for (const path of files) if (wanted.has(path)) present.add(path);
  return recent.filter((path) => present.has(path));
}

/** 파일을 품은 가장 긴 저장소 디렉터리 (루트 저장소는 ''). 어느 저장소에도 없으면 null */
export function repoOf(path: string, repos: readonly string[]): string | null {
  let found: string | null = null;
  for (const repo of repos)
    if (
      (repo === '' || path.startsWith(`${repo}/`)) &&
      (found === null || repo.length > found.length)
    )
      found = repo;
  return found;
}
