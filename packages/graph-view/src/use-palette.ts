import { useEffect, useState } from 'react';
import { readCssVar, readPalette } from './palette';

export interface ThemeColors {
  lanes: string[];
  background: string;
}

/** 현재 테마의 색을 읽는다 */
function readColors(): ThemeColors {
  return { lanes: readPalette(), background: readCssVar('--bg', '#ffffff') };
}

/** 레인 팔레트와 배경색. <html data-theme> 가 바뀌면 다시 읽는다 */
export function usePalette(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(readColors);

  useEffect(() => {
    if (typeof MutationObserver === 'undefined') {
      return;
    }
    const observer = new MutationObserver(() => setColors(readColors()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  return colors;
}
