import { PromptDialog } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureFocusReturn, useModal } from '../components/use-modal';
import { EditorArea } from '../features/workspace/EditorArea';
import { installDialogStub, removeDialogStub } from './dialog-stub';

/** 포커스 복귀를 검증하는 독립 화면 */
function DialogFixture() {
  const [open, setOpen] = useState(false);
  const ref = useModal(open);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open ? (
        <dialog ref={ref} onClose={() => setOpen(false)}>
          <button type="button" onClick={() => setOpen(false)}>
            close
          </button>
        </dialog>
      ) : null}
    </>
  );
}

/** 포커스 복귀를 검증하는 독립 화면 */
function EditorFixture() {
  const [opened, setOpened] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpened(true)}>
        file
      </button>
      <EditorArea
        docs={opened ? [{ id: 'diff', pinned: true }] : []}
        activeId={opened ? 'diff' : null}
        titleOf={() => 'diff'}
        renderDoc={() => (
          <button type="button" onClick={() => setOpened(false)}>
            close document
          </button>
        )}
        onActivate={() => {}}
        onClose={() => setOpened(false)}
        onPin={() => {}}
        empty={null}
      />
    </>
  );
}

/** 새로 마운트되는 모달의 StrictMode 이중 효과를 검증한다 */
function MountedDialog({ onClose }: { onClose: () => void }) {
  const ref = useModal(true);
  return (
    <dialog ref={ref} onClose={onClose}>
      <button type="button" onClick={onClose}>
        close
      </button>
    </dialog>
  );
}

/** 부모 상태가 모달 컴포넌트 자체를 마운트한다 */
function StrictMountFixture() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      {open ? <MountedDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

beforeEach(installDialogStub);
afterEach(() => {
  cleanup();
  removeDialogStub();
});

describe('출발 요소 포커스 복귀', () => {
  it('공유 입력 대화상자 취소도 사라진 출발 요소의 다음 항목으로 복귀한다', () => {
    const view = (open: boolean) => (
      <>
        <div data-panel="files">
          <button type="button">origin</button>
          <button type="button">next</button>
        </div>
        <PromptDialog
          open={open}
          title="message"
          fields={[{ key: 'message', label: 'message' }]}
          onConfirm={() => {}}
          onCancel={() => rerender(view(false))}
        />
      </>
    );
    const { rerender } = render(view(false));
    const origin = screen.getByText('origin');
    origin.focus();
    rerender(view(true));
    origin.remove();
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(screen.getByText('next'));
  });

  it('StrictMode 재실행이 native close 이벤트로 열린 대화상자를 닫지 않는다', async () => {
    render(
      <StrictMode>
        <StrictMountFixture />
      </StrictMode>,
    );
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
    expect(screen.getByRole('dialog').hasAttribute('open')).toBe(true);
  });

  it('사라진 출발 요소는 다음 항목, 이전 항목, 영역 순서로 복귀한다', () => {
    const { container } = render(
      <div data-panel="files" tabIndex={-1}>
        <button type="button">before</button>
        <button type="button">origin</button>
        <button type="button">after</button>
      </div>,
    );
    const before = screen.getByText('before');
    const origin = screen.getByText('origin');
    const after = screen.getByText('after');
    origin.focus();
    const restore = captureFocusReturn();
    origin.remove();
    restore();
    expect(document.activeElement).toBe(after);
    after.remove();
    restore();
    expect(document.activeElement).toBe(before);
    before.remove();
    restore();
    expect(document.activeElement).toBe(container.firstElementChild);
  });

  it('대화상자를 닫으면 출발 버튼으로 복귀한다', () => {
    render(<DialogFixture />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    const close = screen.getByText('close');
    close.focus();
    fireEvent.click(close);
    expect(document.activeElement).toBe(opener);
  });

  it('Diff 문서를 닫으면 파일을 연 출발 버튼으로 복귀한다', () => {
    render(<EditorFixture />);
    const file = screen.getByText('file');
    act(() => file.focus());
    fireEvent.click(file);
    const close = screen.getByText('close document');
    act(() => close.focus());
    fireEvent.click(close);
    expect(document.activeElement).toBe(file);
  });
});
