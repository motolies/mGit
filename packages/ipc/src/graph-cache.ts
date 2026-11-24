import type { GraphSource } from './graph-source';
import type { GraphRow, GraphWindow, WindowEdge, WindowSegment, WindowStub } from './types';

/** 캐시에서 잘라낸 범위. 아직 안 받은 행은 undefined 다 */
export interface GraphSlice {
  start: number;
  rows: (GraphRow | undefined)[];
  segments: WindowSegment[];
  edges: WindowEdge[];
  /** 범위 안 행의 접힌 긴 엣지 끝 */
  stubs: WindowStub[];
  totalRows: number;
  complete: boolean;
}

export interface GraphRangeCacheOptions {
  /** 한 번에 요청·보관하는 행 수. 기본 500 */
  chunkSize?: number;
  /** 보관할 최대 청크 수(LRU). 기본 64 → 3.2만 행 */
  maxChunks?: number;
}

interface ChunkEntry {
  index: number;
  window: GraphWindow;
  generation: number;
  lastUsed: number;
}

/**
 * 그래프 범위 캐시.
 * - 요청은 청크 경계로 정렬해 보내고, 같은 청크의 진행 중 요청은 하나로 합친다.
 * - 스트리밍 중 총 행 수가 늘면 끝이 잘린 청크(partial)를 다시 요청한다.
 * - `invalidateAll()` 뒤에 도착한 구세대 응답은 버린다. 기존 데이터는 교체될 때까지 그대로 보여 준다.
 */
export class GraphRangeCache {
  private readonly source: GraphSource;
  private readonly chunkSize: number;
  private readonly maxChunks: number;
  private readonly chunks = new Map<number, ChunkEntry>();
  private readonly inflight = new Map<number, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly invalidationListeners = new Set<() => void>();
  private version = 0;
  private generation = 0;
  private totalRows = 0;
  private complete = false;
  private disposed = false;
  private clock = 0;

  constructor(source: GraphSource, opts: GraphRangeCacheOptions = {}) {
    this.source = source;
    this.chunkSize = opts.chunkSize ?? 500;
    this.maxChunks = opts.maxChunks ?? 64;
  }

  /** 알고 있는 총 행 수 */
  getTotalRows(): number {
    return this.totalRows;
  }

  /** 로드가 끝났는지 */
  isComplete(): boolean {
    return this.complete;
  }

  /** 내용이 바뀔 때마다 증가한다. useSyncExternalStore 의 스냅샷으로 쓴다 */
  getVersion(): number {
    return this.version;
  }

  /** 현재 세대 번호 (invalidateAll 마다 증가) */
  getGeneration(): number {
    return this.generation;
  }

  /** 변경 알림을 구독한다 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 이벤트(FirstChunk/Progress/Finished)에서 호출한다. 행 수가 바뀌면 알린다 */
  setTotalRows(total: number, complete: boolean): void {
    if (total === this.totalRows && complete === this.complete) {
      return;
    }
    this.totalRows = total;
    this.complete = complete;
    this.bump();
  }

  /**
   * 세대 교체 직전에 불린다 (재로드 뒤 스크롤 위치를 커밋 id 로 복원할 때 쓴다).
   * 리스너는 아직 옛 데이터를 읽을 수 있다
   */
  subscribeInvalidation(listener: () => void): () => void {
    this.invalidationListeners.add(listener);
    return () => {
      this.invalidationListeners.delete(listener);
    };
  }

  /** 로드 완료·재로드 뒤 세대를 올린다. 저장소 범위가 바뀌면 이전 행을 즉시 버릴 수 있다. */
  invalidateAll(options: { discardRows?: boolean } = {}): void {
    for (const listener of this.invalidationListeners) {
      listener();
    }
    this.generation += 1;
    if (options.discardRows) this.chunks.clear();
    this.bump();
  }

  /** 동기. 캐시된 청크만 모아 [start, end) 범위를 잘라낸다 */
  slice(start: number, end: number): GraphSlice {
    const from = Math.max(0, start);
    const to = Math.max(from, Math.min(end, this.totalRows));
    const rows: (GraphRow | undefined)[] = new Array(to - from).fill(undefined);
    const segments: WindowSegment[] = [];
    const edges: WindowEdge[] = [];
    const stubs: WindowStub[] = [];
    if (to > from) {
      const firstChunk = Math.floor(from / this.chunkSize);
      const lastChunk = Math.floor((to - 1) / this.chunkSize);
      for (let c = firstChunk; c <= lastChunk; c++) {
        const entry = this.chunks.get(c);
        if (!entry) {
          continue;
        }
        entry.lastUsed = ++this.clock;
        const w = entry.window;
        for (const row of w.rows) {
          if (row.row >= from && row.row < to) {
            rows[row.row - from] = row;
          }
        }
        for (const seg of w.segments) {
          if (seg.toRow >= from && seg.fromRow < to) {
            segments.push(seg);
          }
        }
        for (const edge of w.edges) {
          if (edge.topRow >= from - 1 && edge.topRow < to) {
            edges.push(edge);
          }
        }
        // 스텁은 자기 행에만 속한다
        for (const stub of w.stubs) {
          if (stub.row >= from && stub.row < to) {
            stubs.push(stub);
          }
        }
      }
    }
    return {
      start: from,
      rows,
      segments,
      edges,
      stubs,
      totalRows: this.totalRows,
      complete: this.complete,
    };
  }

  /** 누락·부분·구세대 청크를 요청한다. 같은 청크의 진행 중 요청은 재사용한다 */
  async ensureRange(start: number, end: number): Promise<void> {
    if (this.disposed) {
      return;
    }
    const from = Math.max(0, start);
    const to = Math.min(end, this.totalRows);
    if (to <= from) {
      return;
    }
    const firstChunk = Math.floor(from / this.chunkSize);
    const lastChunk = Math.floor((to - 1) / this.chunkSize);
    const waits: Promise<void>[] = [];
    for (let c = firstChunk; c <= lastChunk; c++) {
      const existing = this.inflight.get(c);
      if (existing) {
        waits.push(existing);
        continue;
      }
      const entry = this.chunks.get(c);
      if (entry && !this.isStale(entry)) {
        continue;
      }
      waits.push(this.fetchChunk(c));
    }
    await Promise.all(waits);
  }

  /** 더 이상 쓰지 않는다. 이후 도착하는 응답은 버린다 */
  dispose(): void {
    this.disposed = true;
    this.chunks.clear();
    this.inflight.clear();
    this.listeners.clear();
    this.invalidationListeners.clear();
  }

  /** 세대가 다르거나 끝이 잘린 청크인지 */
  private isStale(entry: ChunkEntry): boolean {
    if (entry.generation !== this.generation) {
      return true;
    }
    const expected = Math.min(this.chunkSize, this.totalRows - entry.index * this.chunkSize);
    return entry.window.rows.length < expected;
  }

  /**
   * 청크 하나를 요청한다. 응답이 구세대면 버리고 **현재 세대로 즉시 다시 요청**한다.
   * 요청 중에 `invalidateAll()` 이 불리면(작은 저장소에서 첫 요청과 로드 완료가 겹칠 때 흔하다)
   * 버린 뒤 아무도 재요청하지 않아 스켈레톤에 멈추는 일을 막는다.
   */
  private fetchChunk(index: number): Promise<void> {
    const generation = this.generation;
    let stale = false;
    const promise = this.source
      .fetchWindow(index * this.chunkSize, this.chunkSize)
      .then((window) => {
        if (this.disposed) {
          return;
        }
        if (generation !== this.generation) {
          stale = true;
          return;
        }
        this.chunks.set(index, { index, window, generation, lastUsed: ++this.clock });
        if (window.totalRows > this.totalRows || (window.finished && !this.complete)) {
          this.totalRows = Math.max(this.totalRows, window.totalRows);
          this.complete = this.complete || window.finished;
        }
        this.evict();
        this.bump();
      })
      .catch(() => {
        // 실패한 청크는 다음 ensureRange 에서 다시 요청된다
      })
      .finally(() => {
        this.inflight.delete(index);
        if (stale && !this.disposed) {
          void this.fetchChunk(index);
        }
      });
    this.inflight.set(index, promise);
    return promise;
  }

  /** LRU 로 오래된 청크를 버린다 */
  private evict(): void {
    while (this.chunks.size > this.maxChunks) {
      let oldest: ChunkEntry | undefined;
      for (const entry of this.chunks.values()) {
        if (!oldest || entry.lastUsed < oldest.lastUsed) {
          oldest = entry;
        }
      }
      if (!oldest) {
        break;
      }
      this.chunks.delete(oldest.index);
    }
  }

  /** 버전을 올리고 구독자에게 알린다 */
  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
