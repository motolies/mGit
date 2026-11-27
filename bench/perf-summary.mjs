#!/usr/bin/env node
// 실제 앱 성능 기록(`perf.jsonl`) 요약 (반응성 측정 M1). node 표준 모듈만 쓴다.
//
//   node bench/perf-summary.mjs target/runtime/<id>/perf.jsonl [--segment N] [--top N]
//
// 기록기 줄 형식은 bench/README.md "실제 앱 기록기" 절. 한 파일에 새로 고침이 여러 번 있으면 `start` 줄마다 구간을 나눈다
// (`t` 는 구간마다 문서 시작 기준이라 구간을 넘어 견주지 않는다). `--segment N` 이면 N 번째 구간(1부터)만 본다.
import fs from 'node:fs';
import path from 'node:path';

/** 명령줄 인자 */
function parseArgs(argv) {
  const out = { file: null, segment: null, top: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--segment') out.segment = Number(argv[++i]);
    else if (arg === '--top') out.top = Number(argv[++i]);
    else if (arg === '-h' || arg === '--help') out.help = true;
    else out.file = arg;
  }
  return out;
}

/** 소수 첫째 자리 */
const round = (n) => Math.round(n * 10) / 10;

/** 정렬된 수 목록의 백분위 (최근접 순위) */
function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

/** 수 목록의 개수·합·p50·p95·최댓값 */
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    sum: round(sorted.reduce((s, v) => s + v, 0)),
    p50: round(pct(sorted, 0.5)),
    p95: round(pct(sorted, 0.95)),
    max: round(sorted.at(-1) ?? 0),
  };
}

/** 마크다운 표 */
function table(headers, rows) {
  if (rows.length === 0) return '(없음)\n';
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return `${[line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n')}\n`;
}

/** 파일을 줄 단위로 읽어 구간(start 줄마다)으로 나눈다. 깨진 줄은 센다 */
function readSegments(file) {
  const text = fs.readFileSync(file, 'utf8');
  const segments = [];
  let current = null;
  let broken = 0;
  let capped = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      broken += 1;
      continue;
    }
    if (entry.kind === 'capped') {
      capped = entry;
      continue;
    }
    if (entry.kind === 'start' || current === null) {
      current = { start: entry.kind === 'start' ? entry : null, entries: [] };
      segments.push(current);
      if (entry.kind === 'start') continue;
    }
    current.entries.push(entry);
  }
  return { segments, broken, capped };
}

/** 같은 명령의 호출 간격(ms) — 시작 시각 순 */
function intervals(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < sorted.length; i += 1) out.push(sorted[i] - sorted[i - 1]);
  return out;
}

/** 간격 분포에서 주기를 추정한다: 중앙값 ±15% 안에 든 간격의 몫이 60% 이상이면 그 중앙값 */
function periodOf(gaps) {
  if (gaps.length < 4) return null;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = pct(sorted, 0.5);
  if (median <= 0) return null;
  const near = gaps.filter((g) => Math.abs(g - median) <= median * 0.15).length / gaps.length;
  return {
    median: round(median),
    share: near,
    p10: round(pct(sorted, 0.1)),
    p90: round(pct(sorted, 0.9)),
  };
}

/** 구간 하나를 요약해 문자열로 낸다 */
function summarize(segment, index, top) {
  const out = [];
  const { start, entries } = segment;
  const times = entries.map((e) => e.t).filter((t) => typeof t === 'number');
  const t0 = times.length ? Math.min(...times) : 0;
  const t1 = times.length ? Math.max(...times) : 0;
  // 1분보다 짧은 구간은 늘려 잡지 않는다 (분당 평균 = 호출 수)
  const minutes = Math.max((t1 - t0) / 60_000, 1);
  const kinds = {};
  for (const e of entries) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  out.push(`## 구간 ${index + 1}`);
  out.push(
    `- 시작: ${start ? `${new Date(start.wall).toISOString()} (${start.mode}, ${start.profile}${start.renders ? ', 렌더 계수' : ''})` : '(start 줄 없음)'}`,
  );
  if (start?.viewport) {
    const v = start.viewport;
    out.push(
      `- 창: ${v.width}×${v.height} (배율 ${v.dpr}), 화면: ${v.screenWidth ?? '?'}×${v.screenHeight ?? '?'}`,
    );
  }
  out.push(`- 길이: ${round((t1 - t0) / 1000)}초, 줄: ${JSON.stringify(kinds)}`);
  for (const e of entries) {
    if (e.kind !== 'note') continue;
    const { t, kind, message, ...rest } = e;
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    out.push(`- 기록기 안내 (${round(t / 1000)}초): ${message}${extra}`);
  }
  out.push('');

  // 명령별
  const byName = new Map();
  for (const e of entries) {
    if (e.kind !== 'ipc') continue;
    const item = byName.get(e.name) ?? { ms: [], fail: 0, t: [] };
    item.ms.push(e.ms);
    item.t.push(e.t);
    if (!e.ok) item.fail += 1;
    byName.set(e.name, item);
  }
  const named = [...byName].map(([name, item]) => ({ name, ...item, s: stats(item.ms) }));
  out.push('### 명령별 IPC (합계 시간 순)');
  out.push(
    table(
      ['명령', '호출', '실패', '합계 ms', 'p50', 'p95', '최대'],
      [...named]
        .sort((a, b) => b.s.sum - a.s.sum)
        .slice(0, top)
        .map((x) => [x.name, x.s.n, x.fail, x.s.sum, x.s.p50, x.s.p95, x.s.max]),
    ),
  );

  // 분당 호출 수
  out.push('### 분당 호출 수 상위 (구간 평균 / 가장 많았던 1분)');
  const perMinute = named.map((x) => {
    const buckets = {};
    for (const t of x.t) {
      const m = Math.floor((t - t0) / 60_000);
      buckets[m] = (buckets[m] ?? 0) + 1;
    }
    return { name: x.name, avg: round(x.s.n / minutes), peak: Math.max(...Object.values(buckets)) };
  });
  out.push(
    table(
      ['명령', '분당 평균', '최대 1분'],
      perMinute
        .sort((a, b) => b.avg - a.avg)
        .slice(0, top)
        .map((x) => [x.name, x.avg, x.peak]),
    ),
  );

  // 주기 호출
  out.push('### 일정 간격으로 반복되는 호출 (같은 명령의 호출 간격 분포)');
  const periodic = named
    .map((x) => ({ name: x.name, n: x.s.n, period: periodOf(intervals(x.t)) }))
    .filter((x) => x.period && x.period.share >= 0.6)
    .sort((a, b) => b.n - a.n);
  out.push(
    table(
      ['명령', '호출', '간격 중앙값 ms', 'p10', 'p90', '중앙값 ±15% 몫'],
      periodic
        .slice(0, top)
        .map((x) => [
          x.name,
          x.n,
          x.period.median,
          x.period.p10,
          x.period.p90,
          `${Math.round(x.period.share * 100)}%`,
        ]),
    ),
  );

  // 1초 묶음 줄: 코어 이벤트, 저장소 알림
  for (const [kind, title, head] of [
    ['events', '코어 이벤트 (통로:종류)', '통로:종류'],
    ['stores', '저장소 알림 (이름별 — 알림마다 구독한 화면이 다시 그려질 수 있다)', '저장소'],
  ]) {
    const counted = new Map();
    for (const e of entries) {
      if (e.kind !== kind) continue;
      for (const [key, n] of Object.entries(e.counts ?? {})) {
        const item = counted.get(key) ?? { total: 0, max: 0, seconds: 0 };
        item.total += n;
        item.max = Math.max(item.max, n);
        item.seconds += 1;
        counted.set(key, item);
      }
    }
    out.push(`### ${title}`);
    out.push(
      table(
        [head, '합계', '초당 최대', '받은 초'],
        [...counted]
          .sort((a, b) => b[1].max - a[1].max || b[1].total - a[1].total)
          .slice(0, top)
          .map(([key, x]) => [key, x.total, x.max, x.seconds]),
      ),
    );
  }

  // 자가 진단 구간 (`selftest begin` ~ `selftest done` 안내, 끝이 없으면 구간 끝까지) — 그 안의 긴 프레임은 따로 묶는다
  const selftestSpans = [];
  for (const e of entries) {
    if (e.kind !== 'note') continue;
    if (e.message === 'selftest begin') selftestSpans.push([e.t, Number.POSITIVE_INFINITY]);
    else if (e.message === 'selftest done' && selftestSpans.length) selftestSpans.at(-1)[1] = e.t;
  }
  const inSelftest = (t) => selftestSpans.some(([from, to]) => t >= from && t <= to);

  // 긴 프레임 (`react` = 그 간격 동안의 React 렌더 시간, 개발 빌드만)
  const frames = new Map();
  for (const e of entries) {
    if (e.kind !== 'frame') continue;
    const input = inSelftest(e.t)
      ? '(자가 진단 중)'
      : e.input && e.input.since <= 1000
        ? `${e.input.type} @ ${e.input.panel ?? '-'}`
        : '(1초 안 입력 없음)';
    const key = `${input}${e.focus === false ? ' (창 포커스 없음)' : ''}`;
    const item = frames.get(key) ?? { ms: [], react: [] };
    item.ms.push(e.ms);
    if (typeof e.react === 'number') item.react.push(e.react);
    frames.set(key, item);
  }
  out.push(
    '### 50ms 넘는 프레임 (직전 입력 · 영역별, React 렌더 = 그 프레임 동안 커밋한 렌더 시간)',
  );
  out.push(
    table(
      ['직전 입력 @ 영역', '수', 'p50', 'p95', '최대', 'React 렌더 p50', 'p95', '붙은 줄'],
      [...frames]
        .map(([key, item]) => [key, stats(item.ms), stats(item.react)])
        .sort((a, b) => b[1].n - a[1].n)
        .map(([key, s, r]) => [
          key,
          s.n,
          s.p50,
          s.p95,
          s.max,
          r.n ? r.p50 : '-',
          r.n ? r.p95 : '-',
          r.n,
        ]),
    ),
  );

  // 느린 상호작용 (Event Timing): 입력 지연 · 리스너 처리 · 그 뒤 그리기
  const interactions = new Map();
  for (const e of entries) {
    if (e.kind !== 'interaction') continue;
    const key = `${e.type} @ ${e.panel ?? '-'}`;
    const item = interactions.get(key) ?? {
      delay: [],
      processing: [],
      presentation: [],
      duration: [],
    };
    for (const field of ['delay', 'processing', 'presentation', 'duration'])
      item[field].push(e[field]);
    interactions.set(key, item);
  }
  if (interactions.size > 0) {
    out.push('### 느린 상호작용 (Event Timing — 입력 지연 · 처리 · 그리기, p50 / p95 ms)');
    out.push(
      table(
        ['입력 @ 영역', '수', '입력 지연', '처리', '그리기', '합'],
        [...interactions]
          .sort((a, b) => b[1].duration.length - a[1].duration.length)
          .map(([key, x]) => {
            const pair = (list) => {
              const s = stats(list);
              return `${s.p50} / ${s.p95}`;
            };
            return [
              key,
              x.duration.length,
              pair(x.delay),
              pair(x.processing),
              pair(x.presentation),
              pair(x.duration),
            ];
          }),
      ),
    );
  }

  // 리스너 시간 (Event Timing 이 없을 때의 대체: 창 capture → bubble)
  const handlers = new Map();
  for (const e of entries) {
    if (e.kind !== 'handlers') continue;
    for (const [key, n] of Object.entries(e.counts ?? {})) {
      const [type, field] = key.split(':');
      const item = handlers.get(type) ?? { n: 0, ms: 0, over16: 0 };
      item[field] = (item[field] ?? 0) + n;
      handlers.set(type, item);
    }
  }
  if (handlers.size > 0) {
    out.push('### 리스너 시간 (창 capture → bubble, Event Timing 대체)');
    out.push(
      table(
        ['입력', '수', '평균 ms', '16ms 넘음'],
        [...handlers].map(([type, x]) => [type, x.n, x.n ? round(x.ms / x.n) : 0, x.over16]),
      ),
    );
  }

  // 휠 통계
  const wheel = { n: 0, x: 0, prevented: 0, seconds: 0 };
  for (const e of entries) {
    if (e.kind !== 'wheel') continue;
    wheel.seconds += 1;
    for (const key of ['n', 'x', 'prevented']) wheel[key] += e.counts?.[key] ?? 0;
  }
  if (wheel.seconds > 0) {
    out.push('### 휠');
    out.push(
      table(
        ['휠 이벤트', '가로 성분 있음', '기본 동작 취소', '받은 초'],
        [[wheel.n, wheel.x, wheel.prevented, wheel.seconds]],
      ),
    );
  }

  // 입력 → 다음 그리기
  const inputs = new Map();
  for (const e of entries) {
    if (e.kind !== 'input') continue;
    const key = `${e.type} @ ${e.panel ?? '-'}`;
    const list = inputs.get(key) ?? [];
    list.push(e.ms);
    inputs.set(key, list);
  }
  out.push('### 입력 → 다음 그리기 50ms 초과 (입력 · 영역별)');
  out.push(
    table(
      ['입력 @ 영역', '수', 'p50', 'p95', '최대'],
      [...inputs]
        .map(([key, list]) => [key, stats(list)])
        .sort((a, b) => b[1].n - a[1].n)
        .map(([key, s]) => [key, s.n, s.p50, s.p95, s.max]),
    ),
  );

  // 자가 진단 (G): 탐침마다 프레임 간격·React 렌더·문서 상태
  const probes = entries.filter((e) => e.kind === 'selftest');
  if (probes.length > 0) {
    /** 탐침 설명 한 칸 */
    const remark = (e) => {
      if (e.skipped) return `건너뜀: ${e.skipped}`;
      const d = e.detail ?? {};
      const parts = [];
      if (e.stalled) parts.push('프레임 멈춤');
      if (d.target) parts.push(`${d.target} ${d.width}×${d.height} (전체 ${d.scrollHeight})`);
      else if (d.row) parts.push(`${d.row} 행 ${d.width}×${d.height}`);
      else if (d.spot) parts.push(`${d.spot} 안 (깊이 ${d.depth})`);
      else if (d.x !== undefined) parts.push(`(${d.x}, ${d.y})`);
      else if (d.elements !== undefined) parts.push(`요소 ${d.elements}`);
      else if (d.width !== undefined) parts.push(`${d.width}×${d.height}`);
      return parts.join(' · ');
    };
    out.push('### 자가 진단 (탐침마다 프레임 간격 ms, React = 그 구간에 커밋한 렌더 합 ms)');
    out.push(
      table(
        ['단계', '탐침', '프레임', 'p50', 'p95', '최대', 'React', '요소', '창', '보기', '비고'],
        probes.map((e) => [
          e.stage,
          e.probe,
          e.frames ?? '-',
          e.p50 ?? '-',
          e.p95 ?? '-',
          e.max ?? '-',
          e.react ?? '-',
          e.state?.elements ?? '-',
          e.state ? `${e.state.width}×${e.state.height}@${e.state.dpr}` : '-',
          e.state
            ? `${e.state.view}${e.state.rows !== undefined ? ` ${e.state.rows}행` : ''}`
            : '-',
          remark(e),
        ]),
      ),
    );
    const panels = probes.find((e) => e.state?.panels)?.state.panels;
    if (panels)
      out.push(
        `영역별 요소 수 (첫 탐침): ${Object.entries(panels)
          .map(([name, n]) => `${name} ${n}`)
          .join(', ')} · 스타일 규칙 ${probes[0].state.rules}\n`,
      );
  }

  // 창 크기 변화
  const resizes = entries.filter((e) => e.kind === 'resize');
  if (resizes.length > 0) {
    out.push('### 창 크기 변화');
    out.push(
      table(
        ['시각(초)', '창', '배율'],
        resizes.map((e) => [round(e.t / 1000), `${e.width}×${e.height}`, e.dpr]),
      ),
    );
  }

  // 렌더
  const renders = new Map();
  let commits = 0;
  for (const e of entries) {
    if (e.kind !== 'renders') continue;
    for (const [region, n] of Object.entries(e.counts ?? {})) {
      if (region === '(commits)') {
        commits += n;
        continue;
      }
      const item = renders.get(region) ?? { total: 0, max: 0 };
      item.total += n;
      item.max = Math.max(item.max, n);
      renders.set(region, item);
    }
  }
  if (renders.size > 0) {
    out.push(`### 영역별 렌더 (컴포넌트 수, 커밋 ${commits})`);
    out.push(
      table(
        ['영역', '합계', '초당 최대'],
        [...renders]
          .sort((a, b) => b[1].total - a[1].total)
          .slice(0, top)
          .map(([region, x]) => [region, x.total, x.max]),
      ),
    );
  }
  return out.join('\n');
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.file) {
  console.log('사용법: node bench/perf-summary.mjs <perf.jsonl> [--segment N] [--top N]');
  process.exit(args.help ? 0 : 2);
}
const { segments, broken, capped } = readSegments(path.resolve(args.file));
console.log(`# 성능 기록 요약: ${args.file}`);
console.log(
  `- 구간 ${segments.length}개, 깨진 줄 ${broken}${capped ? `, 상한 도달(${capped.bytes}바이트에서 멈춤)` : ''}\n`,
);
segments.forEach((segment, index) => {
  if (args.segment && args.segment !== index + 1) return;
  console.log(summarize(segment, index, args.top));
});
