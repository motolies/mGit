import { setStringsLocale } from './packages/ui/src/strings';

// 기존 화면 회귀 픽스처는 한국어를 명시하며 제품의 초기 언어와 분리한다.
setStringsLocale('ko');

// jsdom 에 없는 브라우저 API를 스텁한다 (ResizeObserver, matchMedia)

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** jsdom 전역에 ResizeObserver·matchMedia 스텁을 설치한다 */
function installBrowserStubs(): void {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;
  }
}

installBrowserStubs();
