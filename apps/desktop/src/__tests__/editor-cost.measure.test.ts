// 편집기 부가 기능의 프런트 쪽 비용 측정 (셋째 묶음 N6). 기본 실행에서 빠진다. 돌리는 법:
// `MGIT_MEASURE=1 npx vitest run apps/desktop/src/__tests__/editor-cost.measure.test.ts`
//
// - 변경 표시: 지금은 글자를 칠 때마다(문서 sequence 가 바뀔 때마다) 주석 확장을 다시 만들며 HEAD 와 지금 원문을
//   통째로 비교한다 (`changedLines` → `presentableDiff`)
// - blame 응답·2초 검사 응답을 웹뷰가 JSON 으로 받아 푸는 비용

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { changedLines } from '../features/workspace/editor/annotations';

const run = process.env.MGIT_MEASURE === '1';

/** 걸린 시간들의 p50·p95 (밀리초) */
function percentiles(samples: number[]): [number, number] {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * q))) - 1] ?? 0;
  return [at(0.5), at(0.95)];
}

/** `f` 를 `n` 번 재고 (데우기 한 번 버림) p50·p95 */
function measure(n: number, f: () => unknown): [number, number] {
  f();
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    f();
    samples.push(performance.now() - start);
  }
  return percentiles(samples);
}

/** `lines` 줄 원문 */
function source(lines: number): string {
  return Array.from({ length: lines }, (_, j) => `const value_${j} = compute(${j % 7}, "x");`).join(
    '\n',
  );
}

describe.skipIf(!run)('편집기 부가 기능 비용 (프런트)', () => {
  it('글자마다 도는 변경 표시 계산 (HEAD 원문과 한두 줄 다른 원문)', () => {
    const rows: string[] = ['| 줄 | 고친 곳 | changedLines p50 | p95 |', '|---|---|---|---|'];
    for (const lines of [1_000, 5_000, 20_000]) {
      const head = source(lines);
      const rowsOf = head.split('\n');
      const one = [...rowsOf];
      one[Math.floor(lines / 2)] = 'let typed = 1;';
      const spread = [...rowsOf];
      for (let i = 0; i < lines; i += Math.floor(lines / 20)) spread[i] = `// edited ${i}`;
      for (const [label, text] of [
        ['1줄', one.join('\n')],
        ['20곳', spread.join('\n')],
      ] as const) {
        const [p50, p95] = measure(30, () => changedLines(head, text));
        rows.push(`| ${lines} | ${label} | ${p50.toFixed(2)} | ${p95.toFixed(2)} |`);
      }
    }
    console.log(`\n${rows.join('\n')}`);
    expect(rows.length).toBeGreaterThan(2);
  });

  it('blame 응답과 2초 검사 응답의 JSON 풀기', () => {
    const rows: string[] = ['| 응답 | 크기 | JSON.parse p50 | p95 |', '|---|---|---|---|'];
    for (const lines of [1_000, 5_000, 20_000]) {
      const blame = Array.from({ length: lines }, (_, j) => ({
        oid: 'a'.repeat(40),
        origLine: j + 1,
        line: j + 1,
        author: 'Bench Author',
        authorMail: '<bench@example.com>',
        authorTime: 1_600_000_000 + j,
        summary: `change ${j % 300}`,
        previous: null,
        boundary: false,
        text: `const value_${j} = compute(${j % 7}, "x");`,
      }));
      const json = JSON.stringify(blame);
      const [p50, p95] = measure(15, () => JSON.parse(json));
      rows.push(
        `| blame ${lines}줄 | ${(json.length / 1024).toFixed(0)} KiB | ${p50.toFixed(2)} | ${p95.toFixed(2)} |`,
      );
    }
    for (const [count, kib] of [
      [10, 100],
      [30, 100],
      [10, 900],
      [30, 900],
    ] as const) {
      const text = 'x'.repeat(kib * 1024);
      const files = Array.from({ length: count }, (_, i) => ({
        kind: 'text',
        text,
        size: text.length,
        fileKey: `k${i}`,
        revision: 'r'.repeat(64),
        lineEnding: 'lf',
        bom: false,
      }));
      const payloads = files.map((f) => JSON.stringify(f));
      const [p50, p95] = measure(15, () => payloads.map((p) => JSON.parse(p)));
      rows.push(
        `| 2초 검사 ${count}개 × ${kib} KiB | ${((count * kib) / 1024).toFixed(1)} MiB | ${p50.toFixed(2)} | ${p95.toFixed(2)} |`,
      );
    }
    console.log(`\n${rows.join('\n')}`);
    expect(rows.length).toBeGreaterThan(2);
  });
});
