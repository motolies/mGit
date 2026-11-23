import { type RefObject, useLayoutEffect } from 'react';

export interface GraphCanvasProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  width: number;
  height: number;
  /** 뷰 왼쪽 가장자리에서의 위치 (px). 그래프 열 앞에 다른 열(저장소 띠)이 있으면 그만큼 민다 */
  left?: number;
  dpr: number;
  className?: string;
}

/**
 * 뷰포트 크기의 Canvas 한 장. CSS 크기와 백킹 스토어 크기(DPR 반영)를 맞춘다.
 * 그리기는 GraphView 가 ref 로 직접 한다. 캔버스 안의 좌표는 `left` 와 무관하게 그래프 열 기준이다
 */
export function GraphCanvas({
  canvasRef,
  width,
  height,
  left = 0,
  dpr,
  className,
}: GraphCanvasProps) {
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const w = Math.max(1, Math.round(width * dpr));
    const h = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== w) {
      canvas.width = w;
    }
    if (canvas.height !== h) {
      canvas.height = h;
    }
  }, [canvasRef, width, height, dpr]);

  // 레인·엣지는 장식이다 (커밋의 뜻은 행의 글자가 전한다) — 보조 기술에서 뺀다
  return (
    // biome-ignore lint/a11y/noAriaHiddenOnFocusable: 이 캔버스는 tabIndex 가 없어 포커스를 받지 않는 그림이다
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width, height, left }}
      aria-hidden="true"
    />
  );
}
