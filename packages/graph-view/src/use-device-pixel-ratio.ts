import { useEffect, useState } from 'react';

/** 현재 DPR. 없으면 1 */
function currentDpr(): number {
  return typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
}

/**
 * devicePixelRatio 를 추적한다. WKWebView 는 모니터 이동 시 resize 이벤트를 주지 않으므로
 * `matchMedia('(resolution: Ndppx)')` 변경으로 감지한다.
 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(currentDpr);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(currentDpr());
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [dpr]);

  return dpr;
}
