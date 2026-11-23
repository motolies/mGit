// 저장소 띠 (통합 타임라인, LG-02). 행 맨 앞에 저장소 색을 깐 열이고, 같은 저장소가 이어지면 한 덩어리로 보인다.
// 판정은 모두 순수 함수라 jsdom 없이 테스트한다.

/** 띠 열의 폭 (px). 12px 글자로 15자 안팎의 저장소 이름이 들어간다 */
export const REPO_STRIP_WIDTH = 100;

/** 띠의 이름 글자가 잘리지 않는 한도: 행의 위쪽이 이만큼까지 화면 밖으로 나가도 글자는 온전히 보인다 (px) */
const NAME_CLIP_TOLERANCE = 4;

/**
 * 화면에서 이름이 온전히 보이는 맨 위 그래프 행의 번호. 스크롤해도 이 행에는 항상 이름을 쓴다.
 * `rowOffset` 은 그래프 행 앞에 끼워 넣은 표시 행 수(WIP 행)다
 */
export function topNameRow(scrollTop: number, rowHeight: number, rowOffset: number): number {
  if (rowHeight <= 0) {
    return 0;
  }
  const display = Math.ceil((Math.max(0, scrollTop) - NAME_CLIP_TOLERANCE) / rowHeight);
  return Math.max(0, display - rowOffset);
}

/**
 * 이 행의 띠에 저장소 이름을 쓸지: 같은 저장소가 이어지는 구간의 첫 행과 화면 맨 위 행에만 쓴다.
 * `prevRepo` 는 바로 앞 행의 저장소이고, 앞 행을 아직 읽지 못했으면 `undefined` 다 — 구간의 시작인지
 * 알 수 없으므로 쓴다 (이름이 한 번 더 보이는 편이 빠지는 것보다 낫다. 상태를 색에만 맡기지 않는다: LF-05)
 */
export function showsRepoName(
  row: { index: number; repo: number | null },
  prevRepo: number | null | undefined,
  topRow: number,
): boolean {
  if (row.index === 0 || row.index === topRow) {
    return true;
  }
  return prevRepo === undefined || prevRepo !== row.repo;
}
