import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GRAPH_COLUMNS,
  fitColumns,
  graphColumnLeft,
  gridTemplate,
  subjectColumnWidth,
} from '../GraphRow';
import { REPO_STRIP_WIDTH } from '../repo-strip';

describe('gridTemplate (GRAPH-12)', () => {
  it('기본은 다섯 열, 끈 열은 템플릿에서 빠진다', () => {
    // 그래프 → 제목 → 작성자 → 날짜 → 해시 (LG-01). 작성자는 폭이 변하는 칸이라 px 하나로 끊기지 않는다
    expect(gridTemplate(DEFAULT_GRAPH_COLUMNS)).toBe(
      'var(--graph-col, 60px) minmax(220px, 1fr) minmax(44px, 120px) 142px 60px',
    );
    expect(
      gridTemplate(DEFAULT_GRAPH_COLUMNS)
        .split(' ')
        .filter((p) => p.endsWith('px')),
    ).toEqual(['142px', '60px']);
    const only = gridTemplate({ author: false, date: false, hash: true });
    expect(only).toBe('var(--graph-col, 60px) minmax(220px, 1fr) 60px');
    expect(gridTemplate({ author: false, date: false, hash: false })).toBe(
      'var(--graph-col, 60px) minmax(220px, 1fr)',
    );
  });

  it('아바타 열은 제목과 작성자 사이에 들어간다', () => {
    expect(gridTemplate({ ...DEFAULT_GRAPH_COLUMNS, avatar: true })).toBe(
      'var(--graph-col, 60px) minmax(220px, 1fr) 24px minmax(44px, 120px) 142px 60px',
    );
  });
});

describe('저장소 열 (MR-12)', () => {
  it('repo 열(저장소 띠)은 그래프 열 바로 앞에 들어간다 (LG-02)', () => {
    expect(gridTemplate({ ...DEFAULT_GRAPH_COLUMNS, repo: true })).toBe(
      '100px var(--graph-col, 60px) minmax(220px, 1fr) minmax(44px, 120px) 142px 60px',
    );
  });

  it('캔버스는 띠 폭과 열 간격만큼만 밀린다. 띠가 없으면 왼쪽 끝이다', () => {
    expect(graphColumnLeft(DEFAULT_GRAPH_COLUMNS)).toBe(0);
    expect(graphColumnLeft({ ...DEFAULT_GRAPH_COLUMNS, repo: true })).toBe(REPO_STRIP_WIDTH + 8);
  });
});

// 통합 타임라인의 열과, 목 장면처럼 레인이 7개일 때의 그래프 열 폭 (7 × 14 + 8)
const TIMELINE = { ...DEFAULT_GRAPH_COLUMNS, repo: true };
const SEVEN_LANES = 106;

describe('제목 칸의 폭 (LG-01)', () => {
  it('960×600 창의 통합 타임라인(행 폭 738px, 레인 7개)에서 제목 칸이 220px 남는다', () => {
    // 띠 100 + 그래프 106 + 날짜 142 + 해시 60 + 간격 5×8 + 오른쪽 여백 8 = 456 → 남는 282 를
    // 작성자(최소 44)와 제목(최소 220)이 나눈다
    expect(subjectColumnWidth(TIMELINE, SEVEN_LANES, 738)).toBe(220);
  });

  it('넓으면 작성자 칸이 최대 폭까지 먼저 늘고 나머지가 제목이다', () => {
    // 1100 − 456 = 644 → 작성자 120, 제목 524
    expect(subjectColumnWidth(TIMELINE, SEVEN_LANES, 1100)).toBe(524);
    // 작성자 열을 끄면 남는 폭이 모두 제목이다 (간격도 하나 준다)
    expect(subjectColumnWidth({ ...TIMELINE, author: false }, SEVEN_LANES, 1100)).toBe(652);
  });

  it('아무리 좁아도 최소 폭 아래로 내려가지 않는다', () => {
    expect(subjectColumnWidth(TIMELINE, SEVEN_LANES, 400)).toBe(220);
    expect(subjectColumnWidth(DEFAULT_GRAPH_COLUMNS, 60, 0)).toBe(220);
  });
});

describe('좁은 뷰에서 칸 빼기 (LG-01)', () => {
  it('다 들어가면 설정을 그대로 돌려준다', () => {
    // 통합 타임라인이 모든 칸을 최소 폭으로 그리는 데 필요한 폭: 456 + 제목 220 + 작성자 44 = 720
    expect(fitColumns(TIMELINE, SEVEN_LANES, 738)).toBe(TIMELINE);
    // 세로 스크롤바(15~17px)가 자리를 차지해도 들어간다
    expect(fitColumns(TIMELINE, SEVEN_LANES, 738 - 17)).toBe(TIMELINE);
    expect(fitColumns(TIMELINE, SEVEN_LANES, 720)).toBe(TIMELINE);
  });

  it('모자라면 해시 → 날짜 → 작성자 순으로 통째로 뺀다', () => {
    expect(fitColumns(TIMELINE, SEVEN_LANES, 719)).toEqual({ ...TIMELINE, hash: false });
    // 해시를 뺀 뒤 필요한 폭: 456 − 60 − 8 + 264 = 652
    expect(fitColumns(TIMELINE, SEVEN_LANES, 652)).toEqual({ ...TIMELINE, hash: false });
    expect(fitColumns(TIMELINE, SEVEN_LANES, 651)).toEqual({
      ...TIMELINE,
      hash: false,
      date: false,
    });
    // 날짜까지 뺀 뒤: 652 − 142 − 8 = 502. 작성자까지 빼면 502 − 44 − 8 = 450
    expect(fitColumns(TIMELINE, SEVEN_LANES, 501)).toEqual({
      ...TIMELINE,
      hash: false,
      date: false,
      author: false,
    });
  });

  it('저장소 띠와 그래프는 아무리 좁아도 빼지 않는다', () => {
    const fitted = fitColumns({ ...TIMELINE, avatar: true }, SEVEN_LANES, 100);
    expect(fitted).toEqual({ repo: true, avatar: false, author: false, date: false, hash: false });
  });

  it('사용자가 이미 끈 칸은 건너뛰고 다음 칸을 뺀다', () => {
    const noHash = { ...DEFAULT_GRAPH_COLUMNS, hash: false };
    // 그래프 64: 해시 없이 필요한 폭은 64 + 142 + 3×8 + 8 + 264 = 502
    expect(fitColumns(noHash, 64, 502)).toBe(noHash);
    expect(fitColumns(noHash, 64, 501)).toEqual({ ...noHash, date: false });
  });

  it('960×600 의 저장소 탭 가운데 칸(517px)에서는 해시만 빠진다', () => {
    expect(fitColumns(DEFAULT_GRAPH_COLUMNS, 64, 517)).toEqual({
      ...DEFAULT_GRAPH_COLUMNS,
      hash: false,
    });
  });

  it('폭을 아직 모르면(0) 아무것도 빼지 않는다', () => {
    expect(fitColumns(TIMELINE, SEVEN_LANES, 0)).toBe(TIMELINE);
  });
});
