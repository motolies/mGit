// 영역별 렌더 수 (반응성 측정 M1, 선택 — `localStorage['mgit.perf.renders'] = '1'` 일 때만). React 개발 도구 훅의
// 커밋 알림으로 커밋마다 다시 그린 컴포넌트를 영역(`data-panel`)별로 센다. 방식은 `bench/frontend-measure.js` 의 렌더
// 계수기와 같다(그 파일은 페이지에 넣는 독립 스크립트라 가져다 쓸 수 없어 옮겨 적었다). 커밋마다 바뀐 하위 트리를 훑고
// DOM 조상을 찾으므로 비용이 있다 — 그래서 기본은 꺼 둔다.
import type { PerfRecorder } from './recorder';

/** React 파이버 태그 (React 19): 함수·클래스·forwardRef·memo 컴포넌트, 호스트(DOM) 요소 */
const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
const HOST_TAGS = new Set([5, 26, 27]);
/** 파이버 flags 의 PerformedWork (이번 렌더에서 컴포넌트 함수가 실제로 돌았다) */
const PERFORMED_WORK = 1;

/** 이 계수기가 읽는 파이버 필드만 */
interface Fiber {
  tag: number;
  flags: number;
  child: Fiber | null;
  sibling: Fiber | null;
  return: Fiber | null;
  alternate: Fiber | null;
  stateNode: unknown;
}

interface FiberRoot {
  current: Fiber;
}

/** 개발 도구 훅에서 쓰는 부분 */
interface DevtoolsHook {
  supportsFiber?: boolean;
  onCommitFiberRoot?: (id: number, root: FiberRoot, ...rest: unknown[]) => void;
  [field: string]: unknown;
}

/** 파이버가 속한 영역: 가장 가까운 호스트 요소를 감싼 `[data-panel]` 이름 (분할 패널은 `panel:<id>`), 없으면 other */
function regionOf(fiber: Fiber): string {
  for (let f: Fiber | null = fiber; f; f = f.return) {
    const node = f.stateNode as Element | null;
    if (HOST_TAGS.has(f.tag) && node && typeof node.closest === 'function') {
      const named = node.closest('[data-panel]:not([data-panel="true"])');
      if (named) return named.getAttribute('data-panel') ?? 'other';
      const split = node.closest('[data-panel="true"]');
      return split ? `panel:${split.id}` : 'other';
    }
  }
  return 'other';
}

/** 커밋 하나에서 함수가 돈 컴포넌트(새로 붙은 것 포함)를 영역별로 센다. 바뀌지 않은 하위 트리는 건너뛴다 */
export function countRenders(root: FiberRoot): Record<string, number> {
  const out: Record<string, number> = {};
  const visit = (next: Fiber, prev: Fiber | null) => {
    if (COMPONENT_TAGS.has(next.tag) && (prev === null || (next.flags & PERFORMED_WORK) !== 0)) {
      const region = regionOf(next);
      out[region] = (out[region] ?? 0) + 1;
    }
    if (prev !== null && next.child === prev.child) return;
    for (let c = next.child; c; c = c.sibling) visit(c, prev === null ? null : c.alternate);
  };
  visit(root.current, root.current.alternate);
  return out;
}

/**
 * 커밋 알림을 받는다 (React 가 뜨기 전에 불러야 한다). 훅이 이미 있으면(개발 서버의 React Refresh, 측정 도구) 그 커밋 알림을
 * 감싸고, 없으면 최소 훅을 놓는다. 걸었으면 true. 알림 처리에서 난 오류는 삼킨다 — 기록기가 앱을 멈추게 하지 않는다
 */
export function onCommit(listener: (root: FiberRoot) => void): boolean {
  const global = window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: DevtoolsHook };
  let hook = global.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) {
    let nextId = 1;
    const renderers = new Map<number, unknown>();
    hook = {
      supportsFiber: true,
      isDisabled: false,
      renderers,
      inject(renderer: unknown) {
        const id = nextId++;
        renderers.set(id, renderer);
        return id;
      },
      checkDCE() {},
      onScheduleFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      setStrictMode() {},
    };
    global.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  }
  if (!hook.supportsFiber) return false;
  const previous = hook.onCommitFiberRoot;
  hook.onCommitFiberRoot = function (this: unknown, id, root, ...rest) {
    try {
      listener(root);
    } catch {
      // 파이버 구조가 예상과 다르면 이 커밋은 건너뛴다 (앱 동작에는 영향 없음)
    }
    previous?.call(this, id, root, ...rest);
  };
  return true;
}

/** 커밋 알림을 받아 1초 묶음(`renders` 줄: 영역 → 컴포넌트 수, `(commits)` → 커밋 수)으로 센다. 걸었으면 true */
export function watchRenders(recorder: PerfRecorder): boolean {
  return onCommit((root) => {
    recorder.count('renders', '(commits)');
    for (const [region, n] of Object.entries(countRenders(root)))
      recorder.count('renders', region, n);
  });
}

/**
 * React 커밋에 든 렌더 시간을 모은다 (F-3). 개발 빌드는 파이버마다 렌더 시간(`actualDuration`)을 재므로 커밋한 루트의 값을
 * 더하고, 프로덕션 빌드는 그 값이 없어 아무것도 모으지 않는다. `take()` 는 지난 `take()` 뒤의 합(ms)을 주고 0 으로 돌린다 —
 * 값을 잰 커밋을 한 번이라도 봤으면 그동안 커밋이 없을 때 0, 아직 못 봤으면(프로덕션 빌드·첫 커밋 전) null. 걸지 못했으면 null
 */
export function watchCommitTime(): { take(): number | null } | null {
  let sum = 0;
  let seen = false;
  let measured = false;
  const ok = onCommit((root) => {
    const duration = (root.current as Fiber & { actualDuration?: number }).actualDuration;
    if (typeof duration === 'number' && Number.isFinite(duration)) {
      sum += duration;
      seen = true;
      measured = true;
    }
  });
  if (!ok) return null;
  return {
    take() {
      const out = seen ? Math.round(sum * 10) / 10 : measured ? 0 : null;
      sum = 0;
      seen = false;
      return out;
    },
  };
}
