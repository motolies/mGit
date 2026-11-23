import { useLayoutEffect, useState } from 'react';

/**
 * 요소의 폭을 잰다. 붙일 ref 콜백과 폭(아직 못 쟀으면 0)을 준다. 그리기 전에 한 번 재서 좁은 화면에서 배치가
 * 바뀌며 깜빡이는 것을 막고, 이후에는 `ResizeObserver` 로 따라간다
 */
export function useElementWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) {
      return;
    }
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) {
        setWidth(next);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}
