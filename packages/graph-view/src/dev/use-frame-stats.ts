import { useCallback, useEffect, useRef } from 'react';

/** 분위수 (정렬된 배열 기준) */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

const IDLE_MS = 500;
const MAX_SAMPLES = 600;

/**
 * PoC-2 측정용. 활동(스크롤) 중의 rAF 프레임 간격을 모아 멈춘 뒤 p50/p95/p99 를 콘솔에 찍는다.
 * 반환값은 활동을 알리는 함수. enabled 가 false 면 아무것도 하지 않는다.
 */
export function useFrameStats(enabled: boolean, label: string): () => void {
  const lastActivity = useRef(0);
  const samples = useRef<number[]>([]);

  const markActivity = useCallback(() => {
    lastActivity.current = performance.now();
  }, []);

  useEffect(() => {
    if (!enabled || typeof requestAnimationFrame !== 'function') {
      return;
    }
    let raf = 0;
    let lastTs = 0;
    let collecting = false;

    const loop = (ts: number) => {
      const active = ts - lastActivity.current < IDLE_MS;
      if (active) {
        if (collecting && lastTs > 0) {
          samples.current.push(ts - lastTs);
          if (samples.current.length > MAX_SAMPLES) {
            samples.current.shift();
          }
        }
        collecting = true;
      } else if (collecting) {
        const sorted = [...samples.current].sort((a, b) => a - b);
        if (sorted.length >= 10) {
          console.info(
            `[frame-stats:${label}] frames=${sorted.length} p50=${percentile(sorted, 0.5).toFixed(1)}ms ` +
              `p95=${percentile(sorted, 0.95).toFixed(1)}ms p99=${percentile(sorted, 0.99).toFixed(1)}ms ` +
              `max=${(sorted[sorted.length - 1] ?? 0).toFixed(1)}ms`,
          );
        }
        samples.current = [];
        collecting = false;
      }
      lastTs = ts;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [enabled, label]);

  return markActivity;
}
