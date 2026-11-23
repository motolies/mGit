import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../ConfirmDialog';
import {
  PromptDialog,
  type PromptField,
  promptResult,
  promptSegments,
  requireChecked,
} from '../PromptDialog';

const proto = HTMLDialogElement.prototype;
const original = { showModal: proto.showModal, close: proto.close };

/** 명세대로 `close` 이벤트를 다음 태스크에 보내는 `<dialog>` 흉내 */
function installDialogStub(): void {
  proto.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) {
      return;
    }
    this.removeAttribute('open');
    setTimeout(() => this.dispatchEvent(new Event('close')), 0);
  };
}

/** 대기 중인 close 이벤트까지 처리한다 */
const tick = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));

beforeEach(installDialogStub);
afterEach(() => {
  cleanup();
  proto.showModal = original.showModal;
  proto.close = original.close;
});

/** 확인·취소가 서로 다른 값을 남기는 부모 (충돌 "이어서" 대화상자와 같은 구조) */
function Choice() {
  const [choice, setChoice] = useState<string | null>(null);
  return (
    <>
      <output data-testid="choice">{choice ?? 'none'}</output>
      <ConfirmDialog
        open={choice === null}
        title="t"
        message="m"
        confirmLabel="이어서"
        onConfirm={() => setChoice('confirm')}
        onCancel={() => setChoice('cancel')}
      />
    </>
  );
}

describe('ConfirmDialog 닫힘 처리', () => {
  it('확인으로 닫힐 때 뒤따르는 close 이벤트가 취소로 처리되지 않는다', async () => {
    render(<Choice />);
    await tick();
    fireEvent.submit(screen.getByText('이어서').closest('form') as HTMLFormElement);
    await tick();
    expect(screen.getByTestId('choice').textContent).toBe('confirm');
  });

  it('사용자가 네이티브로 닫으면 (cancel 이벤트 없이 close 만 와도) 취소다', async () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ConfirmDialog open title="t" message="m" onConfirm={() => {}} onCancel={onCancel} />,
    );
    await tick();
    const el = container.querySelector('dialog') as HTMLDialogElement;
    act(() => el.close());
    await tick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('PromptDialog 입력 유지', () => {
  it('부모가 인라인 fields 로 다시 그려도 입력값이 남는다', async () => {
    const field = (initial: string) => [{ key: 'secret', label: '비밀번호', initial }];
    const view = (n: number) => (
      <PromptDialog
        open
        title={`t${n}`}
        fields={field('')}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const { rerender } = render(view(0));
    await tick();
    const input = screen.getByLabelText('비밀번호') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 's3cret' } });
    rerender(view(1));
    await tick();
    expect(input.value).toBe('s3cret');
  });

  it('필드 내용이 바뀌면 새 초깃값으로 채운다', async () => {
    const view = (initial: string) => (
      <PromptDialog
        open
        title="t"
        fields={[{ key: 'name', label: '이름', initial }]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const { rerender } = render(view('a'));
    await tick();
    const input = screen.getByLabelText('이름') as HTMLInputElement;
    expect(input.value).toBe('a');
    rerender(view('b'));
    await tick();
    expect(input.value).toBe('b');
  });

  it('닫았다 다시 열면 이전 입력을 지운다', async () => {
    const fields = [{ key: 'name', label: '이름' }];
    const view = (open: boolean) => (
      <PromptDialog
        open={open}
        title="t"
        fields={fields}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
    const { rerender } = render(view(true));
    await tick();
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: 'x' } });
    rerender(view(false));
    await tick();
    rerender(view(true));
    await tick();
    expect((screen.getByLabelText('이름') as HTMLInputElement).value).toBe('');
  });
});

describe('PromptDialog 꺼진 칸·묶음·검증 (W19)', () => {
  const fields: PromptField[] = [
    { key: 'name', label: '이름' },
    { key: 'opt', label: '옵션', type: 'checkbox', initial: true },
    { key: 'a', label: 'a', type: 'checkbox', initial: true, group: '대상' },
    {
      key: 'b',
      label: 'b',
      type: 'checkbox',
      initial: true,
      disabled: true,
      note: '보낼 commit 없음',
      group: '대상',
    },
    { key: 'c', label: 'c', type: 'checkbox', initial: false, group: '대상' },
  ];

  it('필드 묶음: 같은 제목이 이어지는 필드만 한 묶음이고 순서를 지킨다', () => {
    expect(
      promptSegments(fields).map((s) => [s.group, s.fields.map((x) => [x.field.key, x.index])]),
    ).toEqual([
      [null, [['name', 0]]],
      [null, [['opt', 1]]],
      [
        '대상',
        [
          ['a', 2],
          ['b', 3],
          ['c', 4],
        ],
      ],
    ]);
    // 제목이 같아도 사이에 다른 필드가 끼면 다른 묶음이다
    const split: PromptField[] = [
      { key: 'x', label: 'x', group: 'g' },
      { key: 'y', label: 'y' },
      { key: 'z', label: 'z', group: 'g' },
    ];
    expect(promptSegments(split).map((s) => s.group)).toEqual(['g', null, 'g']);
  });

  it('확인 결과에서 꺼진 칸의 값은 빠진다', () => {
    expect(promptResult(fields, { name: 'n', opt: true, a: true, b: true, c: false })).toEqual({
      name: 'n',
      opt: true,
      a: true,
      c: false,
    });
  });

  it('하나도 체크하지 않으면 사유, 하나라도 체크하면 null', () => {
    const check = requireChecked(['a', 'c'], '없음');
    expect(check({ a: false, c: false })).toBe('없음');
    expect(check({ a: false, c: true })).toBeNull();
    // 목록 밖 칸의 체크는 세지 않는다
    expect(check({ a: false, c: false, opt: true })).toBe('없음');
  });

  it('꺼진 칸은 초깃값과 상관없이 빈 칸이고 체크할 수 없으며 사유가 칸의 설명이다. 묶음은 제목이 있는 구획이다', async () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog open title="t" fields={fields} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    await tick();
    const b = screen.getByRole<HTMLInputElement>('checkbox', { name: /^b/ });
    expect(b.disabled).toBe(true);
    expect(b.checked).toBe(false);
    expect(screen.getByText('보낼 commit 없음').id).toBe(b.getAttribute('aria-describedby'));
    fireEvent.click(b);
    expect(b.checked).toBe(false);
    // 묶음: legend 가 구획의 이름이고 대상 칸만 그 안에 있다
    const group = screen.getByRole('group', { name: '대상' });
    expect([...group.querySelectorAll('input')].map((i) => i.id)).toEqual(['pf-a', 'pf-b', 'pf-c']);
    expect(group.contains(screen.getByRole('checkbox', { name: '옵션' }))).toBe(false);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(onConfirm).toHaveBeenCalledWith({ name: '', opt: true, a: true, c: false });
  });

  it('검증이 사유를 돌려주면 확인이 꺼지고 사유가 보이며 제출해도 부르지 않는다', async () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog
        open
        title="t"
        fields={fields}
        validate={requireChecked(['a', 'b', 'c'], '체크한 저장소가 없습니다')}
        confirmLabel="실행"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await tick();
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '실행' });
    expect(confirm.disabled).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'a' }));
    expect(confirm.disabled).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('체크한 저장소가 없습니다');
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'c' }));
    expect(confirm.disabled).toBe(false);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(onConfirm).toHaveBeenCalledWith({ name: '', opt: true, a: false, c: true });
  });

  it('묶음·꺼진 칸·검증을 쓰지 않는 대화상자는 지금 모양 그대로다 (구획·사유 줄 없음)', async () => {
    render(
      <PromptDialog
        open
        title="t"
        fields={[
          { key: 'name', label: '이름' },
          { key: 'go', label: '바로', type: 'checkbox' },
        ]}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick();
    expect(document.querySelector('fieldset')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    const form = document.querySelector('form') as HTMLFormElement;
    // 필드는 폼 바로 아래의 label 이다
    expect([...form.children].filter((c) => c.tagName === 'LABEL')).toHaveLength(2);
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '바로' }).disabled).toBe(false);
  });
});
