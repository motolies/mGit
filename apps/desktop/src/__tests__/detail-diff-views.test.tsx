import type { CommitDetail, FileDiff, RefLabel } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CommitDetailView, splitCommitMessage } from '../features/detail/CommitDetailView';
import { DiffPaneView, type DiffPaneViewProps } from '../features/diff/DiffPaneView';
import { tick } from './dialog-stub';

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { get: () => 800 });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const OID = 'a1b2c3d4e5f6'.padEnd(40, '0');
const PARENT = 'p'.repeat(40);
const CHILD = 'c'.repeat(40);
/** 2025-10-28 06:20 (UTC 기준 epoch 초) */
const T0 = 1761632400;

/** ref 라벨 하나 */
function label(kind: RefLabel['kind'], shortName: string, fullName: string, isCurrent = false) {
  return { kind, shortName, fullName, isCurrent } as RefLabel;
}

/** 커밋 상세 */
function detail(partial: Partial<CommitDetail> = {}): CommitDetail {
  return {
    oid: OID,
    parents: [PARENT],
    children: [CHILD],
    row: 3,
    authorName: 'Jamie Park',
    authorEmail: 'jamie@acme.dev',
    authorTime: T0,
    committerName: 'Jamie Park',
    committerEmail: 'jamie@acme.dev',
    committerTime: T0,
    message: 'feat: 주문 내보내기\n\n본문 첫 줄\n본문 둘째 줄',
    refs: [
      label({ kind: 'localBranch' }, 'main', 'refs/heads/main', true),
      label({ kind: 'remoteBranch', remote: 'origin' }, 'origin/main', 'refs/remotes/origin/main'),
      label({ kind: 'tag', annotated: false }, 'v1.0', 'refs/tags/v1.0'),
    ],
    files: [],
    ...partial,
  };
}

describe('CommitDetailView (CD-02)', () => {
  it('메시지를 제목과 본문으로 나눈다 (본문 앞 빈 줄은 버린다)', () => {
    expect(splitCommitMessage('제목')).toEqual({ subject: '제목', body: '' });
    expect(splitCommitMessage('제목\n\n본문\n둘째')).toEqual({
      subject: '제목',
      body: '본문\n둘째',
    });
    expect(splitCommitMessage('제목\n본문')).toEqual({ subject: '제목', body: '본문' });
  });

  it('제목·본문·`해시 작성자 <이메일> 날짜` 와 ref 라벨 줄을 로그 행과 같은 모양(아이콘 + 글자)으로 그린다', () => {
    const { container } = render(
      <CommitDetailView detail={detail()} isHead={false} now={T0 * 1000} />,
    );
    expect(screen.getByText('feat: 주문 내보내기')).toBeTruthy();
    expect(screen.getByText(/본문 첫 줄/)).toBeTruthy();
    expect(screen.getByText('a1b2c3d4')).toBeTruthy();
    expect(screen.getByText('Jamie Park')).toBeTruthy();
    expect(screen.getByText('<jamie@acme.dev>')).toBeTruthy();
    expect(screen.getByText(S.date.justNow)).toBeTruthy();
    // 로컬과 원격 짝은 한 라벨로 묶이고 현재 브랜치가 HEAD 를 겸한다. 알약 배지는 쓰지 않는다
    const tones = [...container.querySelectorAll('[data-tone]')].map((el) => [
      el.getAttribute('data-tone'),
      el.textContent,
    ]);
    expect(tones).toEqual([
      ['head', `${S.graph.headBadge} ${S.graph.refs.paired('origin', 'main')}`],
      ['tag', 'v1.0'],
    ]);
    expect(container.querySelectorAll('.codicon').length).toBeGreaterThanOrEqual(2);
    // 커밋한 사람·시각이 작성과 같으면 따로 적지 않는다
    expect(screen.queryByText(/커밋 ·/)).toBeNull();
  });

  it('분리 HEAD 면 HEAD 라벨을 따로 붙이고, 커밋한 사람·시각이 다르면 한 줄 더 쓴다', () => {
    const { container } = render(
      <CommitDetailView
        detail={detail({ refs: [], committerName: '한도윤', committerTime: T0 + 3600 })}
        isHead
        now={T0 * 1000}
      />,
    );
    expect(container.querySelector('[data-tone="head"]')?.textContent).toBe(S.graph.headBadge);
    expect(screen.getByText(S.detail.committed('한도윤', ''), { exact: false })).toBeTruthy();
  });

  it('주어진 동작만 그린다: 복사·이동·서명이 없으면 해시는 글자이고 부모·자식은 링크가 아니다', () => {
    render(<CommitDetailView detail={detail()} isHead={false} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(PARENT.slice(0, 8))).toBeTruthy();
    expect(screen.queryByText(S.detail.signature)).toBeNull();
  });

  it('부모·자식을 누르면 그 커밋으로 옮기고, 해시를 누르면 복사한 뒤 잠깐 "복사됨" 을 보인다', async () => {
    const onNavigate = vi.fn();
    const onCopyHash = vi.fn(async () => {});
    render(
      <CommitDetailView
        detail={detail()}
        isHead={false}
        onNavigate={onNavigate}
        onCopyHash={onCopyHash}
        signature={{ code: 'G', signer: 'Jamie', key: 'ABC' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: PARENT.slice(0, 8) }));
    expect(onNavigate).toHaveBeenCalledWith(PARENT);
    fireEvent.click(screen.getByRole('button', { name: CHILD.slice(0, 8) }));
    expect(onNavigate).toHaveBeenLastCalledWith(CHILD);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'a1b2c3d4' }));
      await tick();
    });
    expect(onCopyHash).toHaveBeenCalledTimes(1);
    expect(screen.getByText(S.detail.copied)).toBeTruthy();
    expect(screen.getByText(`${S.detail.signatureCode('G')} · Jamie`)).toBeTruthy();
  });

  it('파일 자리를 받으면 맨 아래에 그린다 (저장소 탭의 평면 목록)', () => {
    render(<CommitDetailView detail={detail()} isHead={false} files={<div>파일 목록 자리</div>} />);
    expect(screen.getByText('파일 목록 자리')).toBeTruthy();
  });
});

/** hunk 하나짜리 diff */
function diff(partial: Partial<FileDiff> = {}): FileDiff {
  return {
    oldPath: 'a.txt',
    newPath: 'a.txt',
    change: { kind: 'modified' },
    binary: null,
    truncated: false,
    totalLines: 2,
    nonUtf8: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        section: '',
        lines: [
          { kind: 'del', text: 'old', oldNo: 1, newNo: null, noNewline: false },
          { kind: 'add', text: 'new', oldNo: null, newNo: 1, noNewline: false },
        ],
      },
    ],
    ...partial,
  };
}

describe('DiffPaneView (ED-03)', () => {
  /** 읽기 전용 커밋 diff 탭처럼 그린다 */
  function setup(partial: Partial<DiffPaneViewProps> = {}) {
    const props: DiffPaneViewProps = {
      path: 'a.txt',
      areaLabel: 'commit a1b2c3d4 · api',
      diff: diff(),
      loading: false,
      error: null,
      mode: 'unified',
      onModeChange: vi.fn(),
      options: { ignoreWhitespace: false, context: 3, wrap: true, tabWidth: 4 },
      onOptionsChange: vi.fn(),
      onLoadFull: vi.fn(),
      ...partial,
    };
    render(<DiffPaneView {...props} />);
    return props;
  }

  it('읽기 전용이면 stage·되돌리기·"← 그래프로"·외부 도구가 없다', () => {
    setup();
    expect(screen.getByText('commit a1b2c3d4 · api')).toBeTruthy();
    expect(screen.queryByText(S.diff.discardHunk)).toBeNull();
    expect(screen.queryByText(S.diff.applyHunk(S.diff.stage))).toBeNull();
    expect(screen.queryByText(`← ${S.diff.back}`)).toBeNull();
    expect(screen.queryByText(S.history.difftool)).toBeNull();
    // 보기 옵션은 있다
    expect(screen.getByLabelText(S.diff.ignoreWhitespace)).toBeTruthy();
  });

  it('쓰기 동작·뒤로·외부 도구를 받으면 그린다 (저장소 탭)', () => {
    const onBack = vi.fn();
    const onDifftool = vi.fn();
    setup({
      onBack,
      onDifftool,
      actions: {
        verb: 'stage',
        onApplyHunk: vi.fn(),
        onApplyLines: vi.fn(),
        onDiscardHunk: vi.fn(),
      },
    });
    expect(screen.getByText(S.diff.discardHunk)).toBeTruthy();
    fireEvent.click(screen.getByText(`← ${S.diff.back}`));
    expect(onBack).toHaveBeenCalled();
    fireEvent.click(screen.getByText(S.history.difftool));
    expect(onDifftool).toHaveBeenCalled();
  });

  it('보기 옵션을 바꾸면 알린다', () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText(S.diff.ignoreWhitespace));
    expect(props.onOptionsChange).toHaveBeenCalledWith({ ignoreWhitespace: true });
    fireEvent.click(screen.getByText(S.diff.split));
    expect(props.onModeChange).toHaveBeenCalledWith('split');
  });

  it.each<[string, Partial<DiffPaneViewProps>, string]>([
    ['읽는 중', { diff: null, loading: true }, S.diff.loading],
    ['변경 없음 (null)', { diff: null }, S.diff.noChanges],
    [
      '이름 변경',
      { diff: diff({ change: { kind: 'renamed', similarity: 91 } }) },
      S.diff.change({ kind: 'renamed', similarity: 91 }),
    ],
    [
      '바이너리',
      { diff: diff({ binary: { oldSize: 10, newSize: 20 }, hunks: [] }) },
      S.diff.binary(10, 20),
    ],
    ['머지 commit 안내', { note: S.diff.mergeFirstParent }, S.diff.mergeFirstParent],
  ])('상태: %s', (_name, partial, text) => {
    setup(partial);
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('잘린 diff 는 "전체 보기" 로 전체를 요청하고, 오류는 "다시 시도" 를 준다', () => {
    const onRetry = vi.fn();
    const props = setup({
      diff: diff({ truncated: true, totalLines: 9000 }),
      error: '실패',
      onRetry,
    });
    fireEvent.click(screen.getByText(S.diff.loadFull));
    expect(props.onLoadFull).toHaveBeenCalled();
    expect(screen.getByText('실패')).toBeTruthy();
    fireEvent.click(screen.getByText(S.diff.retry));
    expect(onRetry).toHaveBeenCalled();
  });
});
