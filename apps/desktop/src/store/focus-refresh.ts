// 창 포커스 복귀 갱신 조율기 (반응성 G4, R9). 다른 앱에서 돌아올 때 듣는 쪽(열린 파일 재검사·폴더 요약·파일 트리·비교 화면·
// 미리보기·클립보드)이 저마다 `window` 의 focus 에 붙어 한꺼번에 갱신하면, 코어의 git 읽기 동시 실행 한도가 차 돌아온 직후
// 누른 동작이 뒤로 밀린다. 듣는 쪽은 여기에 등록하고, 조율기가 한 차례(round)로 묶어 돌린다.
//
// 규칙
// - 계기: 창 포커스(`focus`)와 창이 다시 보이게 됨(`visibilitychange` → visible). 차례가 도는 동안 온 계기는 그 차례에 합친다
// - 건너뜀: 듣는 쪽마다 마지막 갱신(조율기가 돌린 시각과, 듣는 쪽이 알려 준 "스스로 갱신한 시각" 중 늦은 것)이 간격
//   (`FOCUS_REFRESH_GAP_MS`, 듣는 쪽이 바꿀 수 있다) 안이면 이번 차례에서 뺀다
// - 순서: 단계(`tier`)가 작은 것부터. 같은 단계는 함께 돌고, 모두 끝나야(또는 `FOCUS_TIER_WAIT_MS` 가 지나야) 다음 단계로
//   간다 — 보이는 것(편집기 문서·비교 화면) → 보이는 탭의 상태(요약·파일 트리) → 나머지(뒤 탭 파일 표지·클립보드)
// 시각은 `performance.now()` (단조 증가 — 벽시계를 고쳐도 건너뜀이 어긋나지 않는다)

/**
 * 같은 듣는 쪽을 다시 갱신하지 않는 최소 간격. 앱을 잠깐 오가는(⌘Tab 으로 확인하고 돌아오는) 몇 초 사이에는 git 상태가
 * 바뀌어도 코어 감시가 이미 알리고, 감시 밖의 것(파일 트리·클립보드)도 몇 초 낡는 정도라 다시 읽을 값어치가 작다. 반대로 길게
 * 잡으면 다른 앱에서 고치고 돌아온 결과가 늦게 보이므로, 잠깐 오가기를 묶을 만큼만 둔다
 */
export const FOCUS_REFRESH_GAP_MS = 5_000;

/**
 * 앞 단계를 기다리는 최대 시간. 느린 파일 시스템이나 멈춘 명령 하나가 뒤 단계와 다음 포커스의 갱신을 막지 않게 이만큼 지나면
 * 다음 단계를 시작한다 (앞 단계는 그대로 마저 돈다)
 */
export const FOCUS_TIER_WAIT_MS = 1_000;

/** 갱신 순서의 단계 (작은 것 먼저) */
export const FocusTier = {
  /** 지금 보이는 내용: 보이는 편집기 문서·비교 화면·미리보기 */
  visible: 0,
  /** 보이는 탭의 상태: 폴더 요약·브랜치·변경, 펼친 파일 트리 */
  tab: 1,
  /** 나머지: 뒤 탭 파일의 표지 검사, 클립보드 */
  rest: 2,
} as const;
export type FocusTier = (typeof FocusTier)[keyof typeof FocusTier];

/** 포커스 복귀 때 갱신할 듣는 쪽 하나 */
export interface FocusRefresher {
  /** 이름 (테스트·진단용) */
  name: string;
  tier: FocusTier;
  /** 갱신한다. 약속을 돌려주면 그것이 끝나야 다음 단계로 간다 */
  run(): unknown;
  /** 듣는 쪽이 스스로(주기 재조회·사용자 새로고침 등) 마지막으로 갱신한 시각 (`focusClock()` 기준). 모르면 null */
  lastRefreshedAt?(): number | null;
  /** 건너뛸 간격 (기본 `FOCUS_REFRESH_GAP_MS`). 0 이면 계기마다 돈다 */
  gapMs?: number;
}

interface Entry extends FocusRefresher {
  /** 조율기가 마지막으로 돌린 시각 */
  ranAt: number | null;
}

const entries = new Set<Entry>();
let round: Promise<void> | null = null;
let detach: (() => void) | null = null;

/** 조율기의 시계 (`performance.now()`) */
export function focusClock(): number {
  return performance.now();
}

/** 이번 차례에 돌릴지: 마지막 갱신이 간격 안이면 건너뛴다 */
function due(entry: Entry, at: number): boolean {
  const gap = entry.gapMs ?? FOCUS_REFRESH_GAP_MS;
  if (gap <= 0) return true;
  const own = entry.lastRefreshedAt?.() ?? null;
  const last = Math.max(entry.ranAt ?? Number.NEGATIVE_INFINITY, own ?? Number.NEGATIVE_INFINITY);
  return at - last >= gap;
}

/**
 * 포커스 복귀 갱신을 한 차례 돌린다. 이미 도는 차례가 있으면 그것을 돌려준다 (연달아 온 계기를 묶는다). 돌릴 듣는 쪽은
 * 차례를 시작할 때 고르고 그때 시각을 남긴다 — 그 뒤 간격 안의 계기는 그 듣는 쪽을 건너뛴다
 */
export function runFocusRefresh(): Promise<void> {
  if (round) return round;
  const at = focusClock();
  const picked = [...entries].filter((entry) => due(entry, at));
  if (picked.length === 0) return Promise.resolve();
  for (const entry of picked) entry.ranAt = at;
  const tiers = [...new Set(picked.map((entry) => entry.tier))].sort((a, b) => a - b);
  round = (async () => {
    for (const tier of tiers) {
      // 그사이 해제된 듣는 쪽(탭을 닫음)은 돌리지 않는다. 한 듣는 쪽의 실패가 다른 쪽을 막지 않게 따로 받는다
      const members = picked.filter((entry) => entry.tier === tier && entries.has(entry));
      const settled = Promise.allSettled(
        members.map((entry) => Promise.resolve().then(() => entry.run())),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, FOCUS_TIER_WAIT_MS);
      });
      await Promise.race([settled, waited]);
      clearTimeout(timer);
    }
  })().finally(() => {
    round = null;
  });
  return round;
}

/** 창 이벤트를 붙인다 (첫 등록 때). 해제 함수를 준다 */
function attach(): () => void {
  const onFocus = () => void runFocusRefresh();
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void runFocusRefresh();
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/**
 * 포커스 복귀 갱신에 등록한다. 해제 함수를 준다 (탭·화면이 내려갈 때 부른다). 마지막 등록이 풀리면 창 이벤트도 뗀다
 */
export function onFocusRefresh(refresher: FocusRefresher): () => void {
  const entry: Entry = { ...refresher, ranAt: null };
  entries.add(entry);
  detach ??= attach();
  return () => {
    entries.delete(entry);
    if (entries.size === 0 && detach) {
      detach();
      detach = null;
    }
  };
}

/** 등록된 듣는 쪽 이름들 (테스트·진단용 — 새는 등록이 없는지 본다) */
export function focusRefreshers(): string[] {
  return [...entries].map((entry) => entry.name);
}

/** 창이 지금 보이는지 (주기 재조회가 보이지 않는 동안 미룰 때 쓴다) */
export function windowVisible(): boolean {
  return document.visibilityState !== 'hidden';
}
