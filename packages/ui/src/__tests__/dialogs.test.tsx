import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '../ConfirmDialog';
import styles from '../ConfirmDialog.module.css';
import {
  normalizedPreview,
  PromptDialog,
  type PromptField,
  promptResult,
  promptSegments,
  requireChecked,
} from '../PromptDialog';
import { S } from '../strings';

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

describe('PromptDialog 영향 목록·위험 (tag 지울 곳, A5)', () => {
  /** 지울 곳 대화상자 모양: 로컬(기본 체크)·원격 체크 칸 */
  const scope: PromptField[] = [
    { key: 'local', label: '로컬', type: 'checkbox', initial: true, group: '지울 곳' },
    { key: 'origin', label: 'origin', type: 'checkbox', group: '지울 곳' },
  ];
  const names = Array.from({ length: 25 }, (_, i) => `v1.0.${i}`);
  const listed = () => [...document.querySelectorAll('ul li')].map((li) => li.textContent);

  it('영향 목록은 설명 아래·필드 위에 20개까지 보이고 나머지는 "외 N개" 한 줄이다 (ConfirmDialog 와 같은 모양)', async () => {
    render(
      <PromptDialog
        open
        title="t"
        message="m"
        items={names}
        fields={scope}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick();
    const expected = [...names.slice(0, 20), S.confirm.more(5)];
    expect(listed()).toEqual(expected);
    // 순서: 설명 → 목록 → 필드 묶음
    const list = document.querySelector('ul') as HTMLUListElement;
    expect(list.previousElementSibling?.textContent).toBe('m');
    expect(list.nextElementSibling?.tagName).toBe('FIELDSET');
    cleanup();
    render(
      <ConfirmDialog
        open
        title="t"
        message="m"
        items={names}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick();
    expect(listed()).toEqual(expected);
  });

  it('20개 이하면 "외 N개" 줄이 없고, 빈 목록은 그리지 않는다', async () => {
    const { rerender } = render(
      <PromptDialog
        open
        title="t"
        items={names.slice(0, 20)}
        fields={scope}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick();
    expect(listed()).toEqual(names.slice(0, 20));
    rerender(
      <PromptDialog
        open
        title="t"
        items={[]}
        fields={scope}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(document.querySelector('ul')).toBeNull();
  });

  it('danger 면 확인 단추가 위험 표시이고 체크 칸의 Enter 는 제출로 가지 않는다 (Space·클릭으로는 칸이 바뀐다)', async () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog
        open
        danger
        title="t"
        items={['v1']}
        fields={scope}
        validate={requireChecked(['local', 'origin'], '없음')}
        confirmLabel="지우기"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await tick();
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '지우기' });
    expect(confirm.classList.contains(styles.danger as string)).toBe(true);
    const local = screen.getByRole<HTMLInputElement>('checkbox', { name: '로컬' });
    const origin = screen.getByRole<HTMLInputElement>('checkbox', { name: 'origin' });
    // fireEvent 는 기본 동작이 막혔으면 false 를 돌려준다 — 막힌 keydown 은 암묵적 제출(keypress)을 일으키지 않는다
    expect(fireEvent.keyDown(local, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(origin, { key: 'Enter' })).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
    // 다른 키는 그대로다
    expect(fireEvent.keyDown(local, { key: ' ' })).toBe(true);
    fireEvent.click(origin);
    expect(origin.checked).toBe(true);
    // 확인 단추로는 실행된다
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(onConfirm).toHaveBeenCalledWith({ local: true, origin: true });
  });

  it('danger·items 를 쓰지 않으면 지금 동작 그대로다 (목록 없음, 보통 강조 단추, 체크 칸 Enter 를 막지 않음)', async () => {
    render(
      <PromptDialog
        open
        title="t"
        fields={scope}
        confirmLabel="실행"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    await tick();
    expect(document.querySelector('ul')).toBeNull();
    const confirm = screen.getByRole<HTMLButtonElement>('button', { name: '실행' });
    expect(confirm.classList.contains(styles.danger as string)).toBe(false);
    const local = screen.getByRole<HTMLInputElement>('checkbox', { name: '로컬' });
    expect(fireEvent.keyDown(local, { key: 'Enter' })).toBe(true);
  });
});

describe('PromptDialog 막지 않는 경고 (notice, B5)', () => {
  it('지금 값에 따라 단추 줄 위에 보이고 바뀌며, 확인을 막지 않는다. 주지 않으면 없다', async () => {
    const onConfirm = vi.fn();
    const fields: PromptField[] = [
      { key: 'local', label: '로컬', type: 'checkbox', initial: true },
    ];
    const { rerender } = render(
      <PromptDialog
        open
        title="t"
        fields={fields}
        notice={(v) => (v.local === true ? '다시 생길 수 있음' : null)}
        confirmLabel="지우기"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await tick();
    const status = () => screen.queryByRole('status');
    expect(status()?.textContent).toBe('다시 생길 수 있음');
    // 경고는 단추 줄 바로 위다
    expect(status()?.nextElementSibling?.querySelector('button')).not.toBeNull();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '지우기' }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: '로컬' }));
    expect(status()).toBeNull();
    rerender(
      <PromptDialog open title="t" fields={fields} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: '로컬' }));
    expect(status()).toBeNull();
  });
});

describe('PromptDialog 입력 다듬기 (normalize, branch 이름 정규화)', () => {
  /** 테스트용 규칙: 앞뒤 공백을 지우고 가운데 공백을 하이픈으로 */
  const rule = {
    apply: (v: string) => v.trim().replace(/\s+/g, '-'),
    preview: (n: string) => `만들 이름: ${n}`,
  };
  const field: PromptField = { key: 'name', label: '이름', required: true, normalize: rule };

  it('미리보기는 다듬은 값이 입력(앞뒤 공백 제외)과 다를 때만, 규칙이 없거나 빈 값이면 없다', () => {
    expect(normalizedPreview(field, 'a b')).toBe('만들 이름: a-b');
    expect(normalizedPreview(field, 'ab')).toBeNull();
    // 끝에 공백을 막 친 순간은 깜박이지 않는다 (앞뒤 공백은 늘 지운다)
    expect(normalizedPreview(field, 'ab ')).toBeNull();
    expect(normalizedPreview(field, '   ')).toBeNull();
    expect(normalizedPreview({ key: 'name', label: '이름' }, 'a b')).toBeNull();
    expect(normalizedPreview(field, true)).toBeNull();
  });

  it('확인 결과에는 다듬은 값이 들어간다 (규칙이 없는 칸·체크 칸은 그대로)', () => {
    const fields: PromptField[] = [
      field,
      { key: 'msg', label: '메시지' },
      { key: 'go', label: '이동', type: 'checkbox' },
    ];
    expect(promptResult(fields, { name: ' a  b ', msg: ' x y ', go: true })).toEqual({
      name: 'a-b',
      msg: ' x y ',
      go: true,
    });
  });

  it('입력 칸 아래에 미리보기가 보이고 칸의 설명이 되며(이름에는 섞이지 않는다), 제출하면 다듬은 값이다', async () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog
        open
        title="t"
        fields={[field]}
        confirmLabel="만들기"
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await tick();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '이름' });
    const preview = () => document.querySelector('[data-role="normalized-preview"]');
    fireEvent.change(input, { target: { value: 'feature' } });
    expect(preview()).toBeNull();
    expect(input.getAttribute('aria-describedby')).toBeNull();
    fireEvent.change(input, { target: { value: ' feature  x ' } });
    expect(preview()?.textContent).toBe('만들 이름: feature-x');
    expect(input.getAttribute('aria-describedby')).toBe(preview()?.id);
    // 미리보기는 입력 칸 바로 아래(label 밖)다
    expect(preview()?.previousElementSibling?.contains(input)).toBe(true);
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(onConfirm).toHaveBeenCalledWith({ name: 'feature-x' });
  });

  it('규칙을 주지 않으면 지금 동작 그대로다 (미리보기 없음, 입력 그대로 제출)', async () => {
    const onConfirm = vi.fn();
    render(
      <PromptDialog
        open
        title="t"
        fields={[{ key: 'name', label: '이름', required: true }]}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    await tick();
    fireEvent.change(screen.getByLabelText('이름'), { target: { value: ' a  b ' } });
    expect(document.querySelector('[data-role="normalized-preview"]')).toBeNull();
    fireEvent.submit(document.querySelector('form') as HTMLFormElement);
    expect(onConfirm).toHaveBeenCalledWith({ name: ' a  b ' });
  });
});
