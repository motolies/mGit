import type { GraphSource } from '../graph-source';
import type {
  GraphRow,
  GraphWindow,
  RefLabel,
  WindowEdge,
  WindowSegment,
  WindowStub,
} from '../types';

export interface MockGraphOptions {
  rows: number;
  seed?: number;
  /** 요청마다 흉내 낼 지연(ms). 기본 5 */
  latencyMs?: number;
}

/** 전체 구간(클립 전) */
interface FullSegment {
  lane: number;
  start: number;
  end: number;
  color: number;
}

interface OpenBranch {
  lane: number;
  color: number;
  remaining: number;
  segmentStart: number;
  commitRows: number[];
  mergeRow: number;
}

/** 합성 그래프 전체. 테스트와 목 클라이언트가 공유한다 */
export interface MockGraph {
  rows: GraphRow[];
  segments: FullSegment[];
  edges: WindowEdge[];
  /** 접힌 긴 엣지 (300행마다 하나, 200행 아래 부모) */
  stubs: WindowStub[];
  laneCount: number;
}

const AUTHORS: [string, string][] = [
  ['정다온', 'daon@example.com'],
  ['이서연', 'seoyeon@example.com'],
  ['Alex Kim', 'alex@example.com'],
  ['박지훈', 'jihoon@example.com'],
  ['Maria Garcia', 'maria@example.com'],
  ['최유진', 'yujin@example.com'],
];

/** 합성 그래프의 커밋 제목 (저장소 장면 storefront-web — 쇼핑몰 프런트엔드에 맞춘 것) */
const SUBJECTS = [
  'feat: 상품 상세에 재고 배지 표시',
  'fix: 장바구니 수량을 바꿔도 합계가 그대로인 문제',
  'refactor: 결제 단계 폼을 컴포넌트로 분리',
  'docs: 스토리북 사용 안내 갱신',
  'test: 체크아웃 흐름 E2E 테스트 추가',
  'chore: 의존성 버전 올림',
  'perf: 상품 목록 이미지 지연 로딩',
  'feat: 주문 내역 페이지 초안',
];

/** 결정적 PRNG (mulberry32) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 행 번호에서 40자 hex 를 만든다 (결정적) */
export function oidOf(row: number, seed: number): string {
  const rng = mulberry32(row * 2654435761 + seed);
  let out = '';
  for (let i = 0; i < 5; i++) {
    out += Math.floor(rng() * 0xffffffff)
      .toString(16)
      .padStart(8, '0');
  }
  return out;
}

/** 합성 그래프를 만든다. 메인 레인 0 위에 분기·머지가 섞인 브랜치가 최대 3개 동시에 열린다 */
export function buildMockGraph(opts: MockGraphOptions): MockGraph {
  const n = Math.max(0, Math.floor(opts.rows));
  const seed = opts.seed ?? 42;
  const rng = mulberry32(seed);
  const rows: GraphRow[] = new Array(n);
  const segments: FullSegment[] = [];
  const edges: WindowEdge[] = [];
  const open: OpenBranch[] = [];
  let nextColor = 0;
  let laneCount = 1;
  let branchCounter = 0;

  const mainRows: number[] = [];
  // 각 행의 (lane, color, branch) 를 먼저 정하고 부모는 뒤에서 채운다
  const rowLane = new Uint16Array(n);
  const rowColor = new Uint8Array(n);
  const rowBranch = new Int32Array(n).fill(-1); // -1 = main
  const branchTipRow: number[] = []; // 브랜치 id → 첫(가장 위) 커밋 행
  const branchRows: number[][] = [];
  const mergeRows = new Map<number, number>(); // merge 행 → 브랜치 id
  const baseTime = 1_761_600_000; // 2025-10-28 근처

  for (let r = 0; r < n; r++) {
    const nearEnd = r >= n - 8;
    const freeLane = (): number => {
      const used = new Set(open.map((b) => b.lane));
      let lane = 1;
      while (used.has(lane)) {
        lane += 1;
      }
      return lane;
    };

    if (!nearEnd && open.length < 3 && rng() < 0.12) {
      // 이 행은 merge commit: 다음 행부터 새 레인이 열린다
      const lane = freeLane();
      const color = ++nextColor % 10;
      const id = branchCounter++;
      open.push({
        lane,
        color,
        remaining: 2 + Math.floor(rng() * 5),
        segmentStart: r + 1,
        commitRows: [],
        mergeRow: r,
      });
      branchRows[id] = [];
      branchTipRow[id] = -1;
      mergeRows.set(r, id);
      edges.push({ topRow: r, topLane: 0, bottomLane: lane, color });
      laneCount = Math.max(laneCount, lane + 1);
      rowLane[r] = 0;
      rowColor[r] = 0;
      mainRows.push(r);
      continue;
    }

    const pick =
      open.length > 0 && (nearEnd || rng() < 0.55)
        ? open[Math.floor(rng() * open.length)]
        : undefined;
    if (pick) {
      const id = mergeRows.get(pick.mergeRow) ?? 0;
      rowLane[r] = pick.lane;
      rowColor[r] = pick.color;
      rowBranch[r] = id;
      pick.commitRows.push(r);
      branchRows[id]?.push(r);
      if (branchTipRow[id] === -1) {
        branchTipRow[id] = r;
      }
      pick.remaining -= 1;
      if (pick.remaining <= 0 || r === n - 1) {
        segments.push({ lane: pick.lane, start: pick.segmentStart, end: r, color: pick.color });
        if (r < n - 1) {
          edges.push({ topRow: r, topLane: pick.lane, bottomLane: 0, color: pick.color });
        }
        open.splice(open.indexOf(pick), 1);
      }
    } else {
      rowLane[r] = 0;
      rowColor[r] = 0;
      mainRows.push(r);
    }
  }
  // 끝까지 열린 브랜치는 마지막 행에서 닫는다 (dangling)
  for (const b of open) {
    segments.push({ lane: b.lane, start: b.segmentStart, end: n - 1, color: b.color });
  }
  if (n > 0) {
    segments.push({ lane: 0, start: 0, end: n - 1, color: 0 });
  }

  // 부모 계산: main 행의 부모는 다음 main 행, 브랜치 행의 부모는 다음 브랜치 행(없으면 그 아래 main 행)
  const nextMainAfter = new Int32Array(n).fill(-1);
  let lastMain = -1;
  for (let r = n - 1; r >= 0; r--) {
    nextMainAfter[r] = lastMain;
    if (rowBranch[r] === -1) {
      lastMain = r;
    }
  }

  for (let r = 0; r < n; r++) {
    const parents: string[] = [];
    const branch = rowBranch[r] ?? -1;
    if (branch === -1) {
      const nm = nextMainAfter[r] ?? -1;
      if (nm >= 0) {
        parents.push(oidOf(nm, seed));
      }
      const mergedBranch = mergeRows.get(r);
      if (mergedBranch !== undefined) {
        const tip = branchTipRow[mergedBranch] ?? -1;
        if (tip >= 0) {
          parents.push(oidOf(tip, seed));
        }
      }
    } else {
      const list = branchRows[branch] ?? [];
      const idx = list.indexOf(r);
      const next = list[idx + 1];
      if (next !== undefined) {
        parents.push(oidOf(next, seed));
      } else {
        const nm = nextMainAfter[r] ?? -1;
        if (nm >= 0) {
          parents.push(oidOf(nm, seed));
        }
      }
    }

    const author = AUTHORS[r % AUTHORS.length] ?? AUTHORS[0];
    const subject = `${SUBJECTS[(r * 7) % SUBJECTS.length]} (#${n - r})`;
    const refs: RefLabel[] = [];
    if (r === 0) {
      refs.push({
        fullName: 'refs/heads/main',
        shortName: 'main',
        kind: { kind: 'localBranch' },
        target: oidOf(r, seed),
        isCurrent: true,
        upstream: 'origin/main',
        ahead: null,
        behind: null,
        upstreamGone: false,
        worktreePath: null,
      });
      refs.push({
        fullName: 'refs/remotes/origin/main',
        shortName: 'origin/main',
        kind: { kind: 'remoteBranch', remote: 'origin' },
        target: oidOf(r, seed),
        isCurrent: false,
        upstream: null,
        ahead: null,
        behind: null,
        upstreamGone: false,
        worktreePath: null,
      });
    }
    if (r > 0 && r % 2000 === 0) {
      refs.push({
        fullName: `refs/tags/v0.${r / 2000}`,
        shortName: `v0.${r / 2000}`,
        kind: { kind: 'tag', annotated: true },
        target: oidOf(r, seed),
        isCurrent: false,
        upstream: null,
        ahead: null,
        behind: null,
        upstreamGone: false,
        worktreePath: null,
      });
    }
    if (branch !== -1 && branchTipRow[branch] === r && branch % 5 === 0) {
      refs.push({
        fullName: `refs/heads/feature/${branch}`,
        shortName: `feature/${branch}`,
        kind: { kind: 'localBranch' },
        target: oidOf(r, seed),
        isCurrent: false,
        upstream: null,
        ahead: null,
        behind: null,
        upstreamGone: false,
        worktreePath: null,
      });
    }

    rows[r] = {
      row: r,
      oid: oidOf(r, seed),
      parents,
      authorName: author?.[0] ?? '',
      authorEmail: author?.[1] ?? '',
      authorTime: baseTime - r * 3600,
      commitTime: baseTime - r * 3600,
      subject,
      lane: rowLane[r] ?? 0,
      color: rowColor[r] ?? 0,
      refs,
      isHead: r === 0,
      inHead: r % 7 !== 3,
      repo: null,
    };
  }

  // 긴 엣지 스텁 흉내: 300행마다 Down, 그 200행 아래에 Up (그리기 확인용, DAG 와는 무관)
  const stubs: WindowStub[] = [];
  for (let r = 150; r + 200 < n; r += 300) {
    const lane = rowLane[r] ?? 0;
    const color = rowColor[r] ?? 0;
    stubs.push({ row: r, lane, dir: 'down', otherRow: r + 200, color });
    stubs.push({ row: r + 200, lane: rowLane[r + 200] ?? 0, dir: 'up', otherRow: r, color });
  }

  return { rows, segments, edges, stubs, laneCount };
}

/** 전체 구간을 [start, end) 윈도에 맞게 클립한다 */
export function clipSegments(segments: FullSegment[], start: number, end: number): WindowSegment[] {
  const out: WindowSegment[] = [];
  const last = end - 1;
  for (const s of segments) {
    if (s.end < start || s.start > last) {
      continue;
    }
    out.push({
      lane: s.lane,
      fromRow: Math.max(s.start, start),
      toRow: Math.min(s.end, last),
      color: s.color,
      continuesUp: s.start < start,
      continuesDown: s.end > last,
    });
  }
  return out;
}

/**
 * 합성 그래프의 [start, start+count) 범위를 `graph_window` 응답 모양으로 자른다.
 * `loadedRows` 뒤(아직 안 받은 행)는 잘라낸다. 단일 저장소 그래프와 통합 타임라인이 같이 쓴다
 */
export function windowOfGraph(
  graph: MockGraph,
  loadedRows: number,
  generation: number,
  start: number,
  count: number,
): GraphWindow {
  const end = Math.min(start + count, loadedRows);
  return {
    generation,
    start,
    totalRows: loadedRows,
    finished: loadedRows >= graph.rows.length,
    laneCount: graph.laneCount,
    rows: start < end ? graph.rows.slice(start, end) : [],
    segments: start < end ? clipSegments(graph.segments, start, end) : [],
    edges: graph.edges.filter((e) => e.topRow >= start - 1 && e.topRow < end),
    stubs: graph.stubs.filter((s) => s.row >= start && s.row < end),
  };
}

/**
 * 합성 그래프를 `graph_window` 처럼 범위로 돌려주는 출처. `loadedRows` 로 스트리밍을 흉내 낸다.
 * `graph` 는 전체 이력(커밋 상세·blame 의 재료)이고, 창은 지금 질의로 보이는 `shown` 에서 자른다
 */
export class MockGraphSource implements GraphSource {
  readonly graph: MockGraph;
  private view: MockGraph;
  private loadedRows: number;
  private readonly latencyMs: number;
  generation = 1;

  constructor(opts: MockGraphOptions) {
    this.graph = buildMockGraph(opts);
    this.view = this.graph;
    this.loadedRows = this.graph.rows.length;
    this.latencyMs = opts.latencyMs ?? 5;
  }

  /** 지금 보이는 그래프 (필터가 없으면 전체 이력) */
  get shown(): MockGraph {
    return this.view;
  }

  /** 보이는 그래프를 바꾸고 다 받은 것으로 둔다 (질의 변경 → 재로드 흉내). null 이면 전체 이력 */
  setShown(view: MockGraph | null): void {
    this.view = view ?? this.graph;
    this.loadedRows = this.view.rows.length;
  }

  /** 지금까지 "받은" 행 수를 정한다 (스트리밍 흉내) */
  setLoadedRows(rows: number): void {
    this.loadedRows = Math.min(rows, this.view.rows.length);
  }

  /** 전부 받았는지 */
  get finished(): boolean {
    return this.loadedRows >= this.view.rows.length;
  }

  /** [start, start+count) 범위를 돌려준다. 아직 안 받은 행은 잘라낸다 */
  async fetchWindow(start: number, count: number): Promise<GraphWindow> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    return windowOfGraph(this.view, this.loadedRows, this.generation, start, count);
  }
}
