import type { ConflictBlock, ConflictDoc } from '@mgit/ipc';

/** 충돌 블록 하나의 해결 상태 (CF-08·09) */
export type ResolutionKind =
  | 'unresolved'
  | 'ours'
  | 'theirs'
  | 'base'
  | 'bothOursFirst'
  | 'bothTheirsFirst'
  | 'custom';

/** 충돌 블록 (판별용 타입 가드) */
export type ConflictOnly = Extract<ConflictBlock, { kind: 'conflict' }>;

/** 블록이 충돌 블록인지 */
export function isConflict(b: ConflictBlock): b is ConflictOnly {
  return b.kind === 'conflict';
}

/** 문서의 충돌 블록 목록 (문서 순서) */
export function conflictBlocks(doc: ConflictDoc): ConflictOnly[] {
  return doc.blocks.filter(isConflict);
}

/** 줄 끝의 `\r` 을 뗀다 */
export function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * 편집기용 문서: 줄끝이 섞인 파일의 줄에 남은 `\r` 을 뗀다. CodeMirror 는 LF 만 다루므로 `\r` 이 남으면
 * 블록 범위 오프셋이 어긋난다. 저장할 때는 원본 문서를 `toFileText` 에 넘겨 줄끝을 되살린다
 */
export function plainDoc(doc: ConflictDoc): ConflictDoc {
  return {
    ...doc,
    blocks: doc.blocks.map((b) =>
      isConflict(b)
        ? {
            ...b,
            ours: b.ours.map(stripCr),
            base: b.base.map(stripCr),
            theirs: b.theirs.map(stripCr),
          }
        : { ...b, lines: b.lines.map(stripCr) },
    ),
  };
}

/** 해결 종류에 따른 줄 목록. `custom`·`unresolved` 는 호출자가 다룬다 */
export function linesFor(block: ConflictOnly, kind: ResolutionKind): string[] {
  switch (kind) {
    case 'ours':
      return block.ours;
    case 'theirs':
      return block.theirs;
    case 'base':
      return block.base;
    case 'bothOursFirst':
      return [...block.ours, ...block.theirs];
    case 'bothTheirsFirst':
      return [...block.theirs, ...block.ours];
    default:
      return [];
  }
}

/** 표준 7자 마커로 감싼 미해결 블록 텍스트 (줄 끝 없음) */
export function markerLines(block: ConflictOnly): string[] {
  const [l0, l1, l2] = block.labels;
  return [
    `<<<<<<< ${l0 ?? ''}`.trimEnd(),
    ...block.ours,
    `||||||| ${l1 ?? ''}`.trimEnd(),
    ...block.base,
    '=======',
    ...block.theirs,
    `>>>>>>> ${l2 ?? ''}`.trimEnd(),
  ];
}

/** 결과 문서 안에서 충돌 블록이 차지하는 범위 (문자 오프셋, `to` 는 배타) */
export interface BlockRange {
  /** 충돌 블록 순번 (0부터) */
  index: number;
  from: number;
  to: number;
  kind: ResolutionKind;
}

/** 미저장 결과 편집 초안. 화면을 떠났다 돌아와도 블록 상태까지 복원한다 */
export interface MergeDraft {
  text: string;
  ranges: BlockRange[];
}

/** 결과 문서 텍스트와 충돌 블록 범위 */
export interface ResultDoc {
  text: string;
  ranges: BlockRange[];
}

/**
 * 블록 문서 + 해결 상태로 결과 편집기 초기 텍스트를 만든다. 미해결 블록은 마커 텍스트로 둔다.
 * 블록 범위는 그 블록의 줄들(줄 끝 제외)을 덮는다. 빈 블록은 길이 0 범위
 */
export function buildResultDoc(
  doc: ConflictDoc,
  resolutions: readonly ResolutionKind[],
): ResultDoc {
  const out: string[] = [];
  const ranges: BlockRange[] = [];
  let conflictIdx = 0;
  let pos = 0;
  /** 줄들을 붙이고 현재 오프셋을 돌려준다 */
  const push = (lines: readonly string[]) => {
    for (const l of lines) {
      if (out.length > 0) {
        pos += 1; // 앞 줄의 줄 끝
      }
      out.push(l);
      pos += l.length;
    }
  };
  for (const b of doc.blocks) {
    if (!isConflict(b)) {
      push(b.lines);
      continue;
    }
    const kind = resolutions[conflictIdx] ?? 'unresolved';
    const lines = kind === 'unresolved' ? markerLines(b) : linesFor(b, kind);
    const from = out.length > 0 && lines.length > 0 ? pos + 1 : pos;
    push(lines);
    ranges.push({ index: conflictIdx, from, to: lines.length > 0 ? pos : from, kind });
    conflictIdx += 1;
  }
  return { text: out.join('\n'), ranges };
}

/** 블록의 모든 원본 줄 (clean 은 그 줄, 충돌은 세 쪽 전부) */
function blockLines(b: ConflictBlock): readonly string[] {
  return isConflict(b) ? [...b.ours, ...b.base, ...b.theirs] : b.lines;
}

/** `run` 이 `lines` 의 `from` 이후에 이어져 나오는 첫 위치. 없으면 -1 */
function findRun(lines: readonly string[], run: readonly string[], from: number): number {
  for (let at = from; at + run.length <= lines.length; at += 1) {
    if (run.every((line, i) => lines[at + i] === line)) {
      return at;
    }
  }
  return -1;
}

/**
 * 결과 줄마다 원본 줄 끝에 `\r` 이 있었는지 알아낸다. 손대지 않은 clean 블록은 통째로 찾아 그대로 되살리고,
 * 나머지는 같은 내용의 원본 줄을 따르며, 새로 쓴 줄은 앞 줄을 따른다
 */
function crFlags(lines: readonly string[], blocks: readonly ConflictBlock[]): boolean[] {
  const flags = new Map<number, boolean>();
  let pos = 0;
  for (const b of blocks) {
    if (isConflict(b) || b.lines.length === 0) {
      continue;
    }
    const at = findRun(lines, b.lines.map(stripCr), pos);
    if (at >= 0) {
      b.lines.forEach((line, i) => {
        flags.set(at + i, line.endsWith('\r'));
      });
      pos = at + b.lines.length;
    }
  }
  const byText = new Map<string, boolean>();
  for (const line of blocks.flatMap(blockLines)) {
    if (!byText.has(stripCr(line))) {
      byText.set(stripCr(line), line.endsWith('\r'));
    }
  }
  let prev = false;
  return lines.map((line, i) => {
    prev = flags.get(i) ?? byText.get(line) ?? prev;
    return prev;
  });
}

/**
 * 편집기 텍스트(LF)를 파일 바이트 규칙(원본 줄 끝·끝 줄바꿈)으로. `blocks` 를 주면 줄끝이 섞인 파일의
 * 줄끝을 줄마다 되살린다 (코어는 그런 파일의 CRLF 줄 끝에 `\r` 을 남겨 준다)
 */
export function toFileText(
  text: string,
  doc: Pick<ConflictDoc, 'eol' | 'trailingNewline'> & Partial<Pick<ConflictDoc, 'blocks'>>,
): string {
  const eol = doc.eol === 'crLf' ? '\r\n' : '\n';
  let body = text.replace(/\r\n/g, '\n');
  if (doc.trailingNewline && body !== '' && !body.endsWith('\n')) {
    body += '\n';
  }
  if (!doc.trailingNewline && body.endsWith('\n')) {
    body = body.slice(0, -1);
  }
  const blocks = doc.blocks ?? [];
  if (blocks.flatMap(blockLines).some((line) => line.endsWith('\r'))) {
    const tail = body.endsWith('\n');
    const lines = (tail ? body.slice(0, -1) : body).split('\n');
    const cr = crFlags(lines, blocks);
    const last = lines.length - 1;
    return lines
      .map((line, i) => `${line}${cr[i] ? '\r' : ''}${i < last || tail ? '\n' : ''}`)
      .join('');
  }
  return eol === '\n' ? body : body.replace(/\n/g, eol);
}

/** 한 쪽(ours/base/theirs) 열의 텍스트와, 충돌 블록이 차지하는 줄 범위 (1부터, 끝 포함) */
export function sideDoc(
  doc: ConflictDoc,
  side: 'ours' | 'base' | 'theirs',
): {
  text: string;
  blockLines: { index: number; from: number; to: number }[];
  blockStarts: number[];
} {
  const lines: string[] = [];
  const blockLines: { index: number; from: number; to: number }[] = [];
  const blockStarts: number[] = [];
  let idx = 0;
  for (const b of doc.blocks) {
    blockStarts.push(lines.length + 1);
    if (!isConflict(b)) {
      lines.push(...b.lines);
      continue;
    }
    const mine = b[side];
    const from = lines.length + 1;
    lines.push(...mine);
    blockLines.push({ index: idx, from, to: Math.max(from, lines.length) });
    idx += 1;
  }
  return { text: lines.join('\n'), blockStarts, blockLines };
}

/**
 * 충돌 마커가 남은 줄 번호 (1부터). 저장 전 검사 (CF-23). `=======`·`|||||||` 는 Setext 제목 등 정상 문서에도
 * 나오므로 세지 않고, 충돌의 시작·끝인 `<`·`>` 줄만 본다
 */
export function markerLineNumbers(text: string): number[] {
  const out: number[] = [];
  text.split('\n').forEach((line, i) => {
    if (/^(<{7}|>{7})( .*)?$/.test(line)) {
      out.push(i + 1);
    }
  });
  return out;
}

/** 텍스트에 남은 충돌 블록 수 (블록 추적이 없는 "이어서" 편집용) */
export function openConflictCount(text: string): number {
  return text.split('\n').filter((line) => /^<{7}( .*)?$/.test(line)).length;
}
