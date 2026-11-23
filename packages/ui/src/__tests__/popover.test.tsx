import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Popover, type PopoverCloseReason, placePopover } from '../Popover';

afterEach(cleanup);

describe('placePopover (창 밖으로 넘치지 않는 자리)', () => {
  const viewport = { width: 960, height: 600 };

  it('자리가 있으면 기준 요소 바로 아래, 왼쪽을 맞춘다', () => {
    expect(
      placePopover({ top: 100, bottom: 122, left: 200 }, { width: 300, height: 200 }, viewport),
    ).toEqual({ top: 126, left: 200, maxHeight: 600 - 122 - 4 - 8, side: 'below' });
  });

  it('아래가 내용보다 모자라고 위가 더 넓으면 위로 연다 (아래쪽 도구 창)', () => {
    const p = placePopover(
      { top: 500, bottom: 522, left: 40 },
      { width: 300, height: 260 },
      viewport,
    );
    expect(p.side).toBe('above');
    expect(p.top).toBe(500 - 4 - 260);
    expect(p.maxHeight).toBe(500 - 4 - 8);
  });

  it('위·아래 모두 모자라면 넓은 쪽에 열고 높이를 그 자리로 줄인다', () => {
    const up = placePopover(
      { top: 400, bottom: 422, left: 40 },
      { width: 300, height: 900 },
      viewport,
    );
    expect(up.side).toBe('above');
    expect(up.maxHeight).toBe(400 - 4 - 8);
    expect(up.top).toBe(8);
    const down = placePopover(
      { top: 250, bottom: 272, left: 40 },
      { width: 300, height: 900 },
      viewport,
    );
    expect(down.side).toBe('below');
    expect(down.maxHeight).toBe(600 - 272 - 4 - 8);
    expect(down.top).toBe(276);
  });

  it('오른쪽으로 넘치면 창 안으로 밀고, 왼쪽 여백을 지킨다', () => {
    expect(
      placePopover({ top: 0, bottom: 20, left: 900 }, { width: 300, height: 100 }, viewport).left,
    ).toBe(960 - 300 - 8);
    expect(
      placePopover({ top: 0, bottom: 20, left: -50 }, { width: 300, height: 100 }, viewport).left,
    ).toBe(8);
  });
});

/** 단추로 여닫는 팝오버. 닫힌 까닭을 기록한다 */
function Harness({ onClose }: { onClose: (reason: PopoverCloseReason) => void }) {
  const [open, setOpen] = useState(true);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const inner = useRef<HTMLInputElement>(null);
  return (
    <div>
      <button ref={setAnchor} type="button" onClick={() => setOpen(!open)}>
        열기
      </button>
      <button type="button">다른 단추</button>
      <Popover
        open={open && anchor !== null}
        anchor={anchor}
        label="필터"
        initialFocus={inner}
        onClose={(reason) => {
          onClose(reason);
          setOpen(false);
        }}
      >
        <input ref={inner} aria-label="검색" />
        <p>설명</p>
      </Popover>
    </div>
  );
}

/** 조작 요소가 둘(입력·단추)인 팝오버 */
function TwoControls({ onClose }: { onClose: (reason: PopoverCloseReason) => void }) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  return (
    <div>
      <button ref={setAnchor} type="button">
        열기
      </button>
      <Popover open={anchor !== null} anchor={anchor} label="둘" onClose={onClose}>
        <input aria-label="처음" />
        <button type="button">끝</button>
      </Popover>
    </div>
  );
}

describe('Popover', () => {
  it('열리면 body 에 대화상자로 그려지고 안쪽 요소에 포커스를 준다', () => {
    render(<Harness onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: '필터' });
    expect(dialog.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '검색' }));
  });

  it('Esc 는 이 팝오버만 닫는다 (바깥으로 전하지 않는다)', () => {
    const onClose = vi.fn();
    const outer = vi.fn();
    window.addEventListener('keydown', outer);
    try {
      render(<Harness onClose={onClose} />);
      act(() => {
        fireEvent.keyDown(screen.getByRole('textbox', { name: '검색' }), { key: 'Escape' });
      });
      expect(onClose).toHaveBeenCalledWith('escape');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(outer).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', outer);
    }
  });

  it('한글 조합 중의 Esc 는 입력기 몫이라 닫지 않는다', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    act(() => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: '검색' }), {
        key: 'Escape',
        isComposing: true,
      });
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('바깥을 누르면 닫고, 안쪽·기준 단추를 누르는 것은 바깥이 아니다', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    act(() => {
      fireEvent.mouseDown(screen.getByText('설명'));
      fireEvent.mouseDown(screen.getByRole('button', { name: '열기' }));
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      fireEvent.mouseDown(screen.getByRole('button', { name: '다른 단추' }));
    });
    expect(onClose).toHaveBeenCalledWith('outside');
  });

  it('포커스가 바깥 요소로 옮겨 가면 닫고, 받는 요소가 없는 blur 는 닫지 않는다', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const search = screen.getByRole('textbox', { name: '검색' });
    act(() => {
      fireEvent.blur(search, { relatedTarget: null });
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      fireEvent.blur(search, { relatedTarget: screen.getByRole('button', { name: '다른 단추' }) });
    });
    expect(onClose).toHaveBeenCalledWith('blur');
  });

  it('마지막 조작 요소의 Tab·첫 조작 요소의 ⇧Tab 은 닫고 여는 단추로 포커스를 돌린다 (W19 ③)', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const search = screen.getByRole('textbox', { name: '검색' });
    act(() => {
      fireEvent.keyDown(search, { key: 'Tab' });
    });
    expect(onClose).toHaveBeenCalledWith('blur');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '열기' }));
    cleanup();
    const again = vi.fn();
    render(<Harness onClose={again} />);
    act(() => {
      fireEvent.keyDown(screen.getByRole('textbox', { name: '검색' }), {
        key: 'Tab',
        shiftKey: true,
      });
    });
    expect(again).toHaveBeenCalledWith('blur');
  });

  it('안에 다음 조작 요소가 있으면 Tab 은 그대로 안에서 옮긴다', () => {
    const onClose = vi.fn();
    render(<TwoControls onClose={onClose} />);
    const first = screen.getByRole('textbox', { name: '처음' });
    act(() => first.focus());
    const notPrevented = fireEvent.keyDown(first, { key: 'Tab' });
    expect(notPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });
});
