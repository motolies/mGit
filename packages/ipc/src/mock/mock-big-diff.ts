import { settingsStorage } from '@mgit/storage';
import type { DiffDocument, DiffLine, Hunk } from '../types';

/**
 * 측정용 큰 diff 문서 조절값 (반응성 E-1). 실제 앱에서 느렸던 문서(양쪽 원문 수천 줄 + 변경 덩어리 수십 개, 구문 강조가 걸리는
 * 코드)를 목 화면에서 재현할 때 켠다. 부를 때마다 설정 저장소(다른 목 조절값과 같은 `settingsStorage`)의 `mgit.mock.diffLines`(줄 수, 0 이면 끔)·
 * `['mgit.mock.diffHunks']`(변경 덩어리 수, 기본 30)·`['mgit.mock.diffDelayMs']`(응답 지연, 기본 0)를 본다
 */
export interface BigDiffKnobs {
  lines: number;
  hunks: number;
  delayMs: number;
}

/** 저장해 둔 양수 (없거나 읽을 수 없으면 0) */
function stored(key: string): number {
  try {
    const n = Number(settingsStorage.getItem(key) ?? 0);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

/** 지금 켜 둔 큰 문서 조절값. 줄 수가 0 이면 null (기본 장면 그대로) */
export function bigDiffKnobs(): BigDiffKnobs | null {
  const lines = stored('mgit.mock.diffLines');
  if (lines === 0) return null;
  return {
    lines,
    hunks: stored('mgit.mock.diffHunks') || 30,
    delayMs: stored('mgit.mock.diffDelayMs'),
  };
}

/** 원문 한 줄: 줄 번호로 고른 코드 모양 (TS·Java 파서가 모두 토큰을 만들 만한 문법) */
function sourceLine(i: number, seed: number): string {
  const n = (i * 7 + seed) % 97;
  switch (i % 12) {
    case 0:
      return `export function handler${i}(input: Request, options: Options): Response {`;
    case 1:
      return `  const value = input.items.map((item) => item.price * ${(n % 9) + 1});`;
    case 2:
      return `  if (value.length > ${n} && options.enabled !== false) {`;
    case 3:
      return `    log.debug("processing ${i}", { count: value.length, user: input.user?.id });`;
    case 4:
      return `    return compute(value, options.limit ?? ${n * 3});`;
    case 5:
      return '  }';
    case 6:
      return `  // 금액 계산과 한도 확인 (${i})`;
    case 7:
      return '  const total = value.reduce((sum, v) => sum + v, 0);';
    case 8:
      return '  return { total, average: total / Math.max(1, value.length) };';
    case 9:
      return '}';
    case 10:
      return '';
    default:
      return `/** 요청 ${i} 의 합계를 구한다 */`;
  }
}

/** 경로마다 다른 원문이 되게 하는 씨앗 */
function seedOf(path: string): number {
  let h = 0;
  for (let i = 0; i < path.length; i += 1) h = (h * 31 + path.charCodeAt(i)) % 1009;
  return h;
}

/** 문맥 줄 */
function context(text: string, oldNo: number, newNo: number): DiffLine {
  return { kind: 'context', oldNo, newNo, text, noNewline: false };
}

/**
 * 큰 diff 문서를 만든다: 원문 `lines` 줄에 고르게 흩어진 `hunks` 개의 변경(두 줄 고침 + 한 줄 넣기, 앞뒤 문맥 3줄).
 * 패치·양쪽 원문·줄 번호가 서로 맞는다 (전체 파일 보기와 변경 부분 보기가 같은 장면을 그린다)
 */
export function bigDiffDocument(
  path: string,
  knobs: Pick<BigDiffKnobs, 'lines' | 'hunks'>,
  oldLabel: string,
  newLabel: string,
): DiffDocument {
  const seed = seedOf(path);
  const total = Math.max(20, knobs.lines);
  const old = Array.from({ length: total }, (_, i) => sourceLine(i, seed));
  const count = Math.max(1, Math.min(knobs.hunks, Math.floor(total / 12)));
  const spacing = total / count;
  const next: string[] = [];
  const hunks: Hunk[] = [];
  let copied = 0;
  for (let k = 0; k < count; k += 1) {
    const at = Math.min(total - 6, Math.max(3, Math.floor((k + 0.5) * spacing)));
    // 앞 문맥 직전까지 그대로 옮긴다
    while (copied < at - 3) next.push(old[copied++] ?? '');
    const oldStart = copied + 1;
    const newStart = next.length + 1;
    const lines: DiffLine[] = [];
    for (let c = 0; c < 3; c += 1) {
      lines.push(context(old[copied] ?? '', copied + 1, next.length + 1));
      next.push(old[copied++] ?? '');
    }
    const removed = [old[copied] ?? '', old[copied + 1] ?? ''];
    const added = [
      `${removed[0]} // 고침 ${k}`,
      removed[1]?.replace(/\d+/, (d) => String(Number(d) + 1)) ?? '',
      `  audit.record("change-${k}", { at: Date.now(), path: "${path}" });`,
    ];
    removed.forEach((text, j) => {
      lines.push({ kind: 'del', oldNo: copied + j + 1, newNo: null, text, noNewline: false });
    });
    added.forEach((text, j) => {
      lines.push({ kind: 'add', oldNo: null, newNo: next.length + j + 1, text, noNewline: false });
    });
    copied += removed.length;
    next.push(...added);
    for (let c = 0; c < 3 && copied < total; c += 1) {
      lines.push(context(old[copied] ?? '', copied + 1, next.length + 1));
      next.push(old[copied++] ?? '');
    }
    hunks.push({
      oldStart,
      oldLines: lines.filter((l) => l.kind !== 'add').length,
      newStart,
      newLines: lines.filter((l) => l.kind !== 'del').length,
      section: '',
      lines,
    });
  }
  while (copied < total) next.push(old[copied++] ?? '');
  const text = (lines: string[]) => `${lines.join('\n')}\n`;
  return {
    diff: {
      oldPath: path,
      newPath: path,
      change: { kind: 'modified' },
      binary: null,
      hunks,
      truncated: false,
      totalLines: hunks.reduce((n, h) => n + h.lines.length, 0),
      nonUtf8: false,
    },
    old: { path, label: oldLabel, content: text(old), lineCount: old.length },
    new: { path, label: newLabel, content: text(next), lineCount: next.length },
    revision: `mock-big:${path}:${total}:${count}`,
    limitReason: null,
  };
}

/** 조절값의 응답 지연만큼 기다린다 (실제 앱의 문서 조회 65~86ms 흉내) */
export function bigDiffDelay(knobs: BigDiffKnobs): Promise<void> {
  return knobs.delayMs > 0
    ? new Promise((resolve) => setTimeout(resolve, knobs.delayMs))
    : Promise.resolve();
}
