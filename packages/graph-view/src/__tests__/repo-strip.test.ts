import { describe, expect, it } from 'vitest';
import { showsRepoName, topNameRow } from '../repo-strip';

describe('저장소 띠의 이름 표시 (LG-02)', () => {
  // 화면 맨 위 행은 따로 본다: 여기서는 한참 아래(행 100)로 둔다
  const FAR = 100;

  it('앞 행과 저장소가 다르면 구간의 첫 행이라 이름을 쓴다', () => {
    expect(showsRepoName({ index: 5, repo: 2 }, 1, FAR)).toBe(true);
  });

  it('앞 행과 저장소가 같으면 이름을 쓰지 않는다 (한 덩어리로 이어진다)', () => {
    expect(showsRepoName({ index: 5, repo: 2 }, 2, FAR)).toBe(false);
  });

  it('앞 행을 아직 읽지 못했으면 이름을 쓴다', () => {
    expect(showsRepoName({ index: 5, repo: 2 }, undefined, FAR)).toBe(true);
  });

  it('화면 맨 위 행에는 구간 중간이어도 이름을 쓴다', () => {
    expect(showsRepoName({ index: 5, repo: 2 }, 2, 5)).toBe(true);
    // 그 다음 행은 다시 이름이 없다
    expect(showsRepoName({ index: 6, repo: 2 }, 2, 5)).toBe(false);
  });

  it('첫 행은 앞 행이 없으므로 항상 이름을 쓴다', () => {
    expect(showsRepoName({ index: 0, repo: 0 }, undefined, FAR)).toBe(true);
  });

  it('구간을 차례로 훑으면 저장소가 바뀌는 행에만 이름이 붙는다', () => {
    const repos = [0, 0, 0, 1, 1, 0, 2, 2, 2];
    const named = repos.map((repo, index) =>
      showsRepoName({ index, repo }, index === 0 ? undefined : repos[index - 1], FAR),
    );
    expect(named).toEqual([true, false, false, true, false, true, true, false, false]);
  });
});

describe('화면 맨 위의 이름 행 (LG-02)', () => {
  const H = 24;

  it('맨 위에서는 첫 행이다', () => {
    expect(topNameRow(0, H, 0)).toBe(0);
  });

  it('행 경계에 딱 맞게 스크롤했으면 그 행이다', () => {
    expect(topNameRow(10 * H, H, 0)).toBe(10);
  });

  it('행의 위쪽이 조금(글자가 안 잘릴 만큼) 가려진 것까지는 그 행이다', () => {
    expect(topNameRow(10 * H + 4, H, 0)).toBe(10);
  });

  it('글자가 잘릴 만큼 가려졌으면 다음 행으로 넘긴다', () => {
    expect(topNameRow(10 * H + 5, H, 0)).toBe(11);
    expect(topNameRow(10 * H + 23, H, 0)).toBe(11);
  });

  it('WIP 행이 앞에 있으면 그만큼 그래프 행 번호가 당겨진다', () => {
    // 표시 행 10 = WIP 1개 + 그래프 행 9
    expect(topNameRow(10 * H, H, 1)).toBe(9);
    // WIP 행이 아직 화면에 있으면 그래프의 첫 행이다
    expect(topNameRow(0, H, 2)).toBe(0);
  });

  it('행 높이가 0 이어도 죽지 않는다', () => {
    expect(topNameRow(100, 0, 0)).toBe(0);
  });
});
