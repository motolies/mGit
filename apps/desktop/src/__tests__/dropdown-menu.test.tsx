// 공용 드롭다운 메뉴 (`components/DropdownMenu.tsx`)의 W25 선택 prop: 라디오의 `closeOnSelect`(기본 false — 지금 동작)와
// 선택지별 `disabled`. 기존 사용처(그래프 옵션·필터 바 등)는 둘 다 주지 않으므로 동작이 그대로다.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DropdownItem, DropdownMenu } from '../components/DropdownMenu';
import { tick } from './dialog-stub';

afterEach(() => {
  cleanup();
});

/** 라디오 하나(선택지 셋)짜리 메뉴를 그리고 키보드로 연다 */
async function openMenu(radio: Partial<Extract<DropdownItem, { kind: 'radio' }>> = {}) {
  const onChange = vi.fn();
  const items: DropdownItem[] = [
    {
      kind: 'radio',
      value: 'a',
      onChange,
      options: [
        { value: 'a', label: '가' },
        { value: 'b', label: '나' },
        { value: 'c', label: '다' },
      ],
      ...radio,
    },
  ];
  render(
    <DropdownMenu
      items={items}
      trigger={
        <button type="button" aria-label="열기">
          ⋮
        </button>
      }
    />,
  );
  act(() => {
    fireEvent.keyDown(screen.getByRole('button', { name: '열기' }), { key: 'Enter' });
  });
  await tick();
  return { onChange };
}

/** 열린 메뉴의 라디오 선택지 (고른 표시 글자 ● 가 앞에 붙을 수 있어 끝 맞춤) */
const option = (label: string) =>
  screen.getByRole('menuitemradio', { name: new RegExp(`${label}$`) });

describe('DropdownMenu 라디오의 선택 prop (W25)', () => {
  it('기본값(closeOnSelect 없음): 라디오를 골라도 메뉴가 닫히지 않는다 (지금 동작)', async () => {
    const { onChange } = await openMenu();
    act(() => {
      fireEvent.click(option('나'));
    });
    await tick();
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('menu')).not.toBeNull();
  });

  it('closeOnSelect: 라디오를 고르면 값을 알리고 메뉴가 닫힌다', async () => {
    const { onChange } = await openMenu({ closeOnSelect: true });
    act(() => {
      fireEvent.click(option('다'));
    });
    await tick();
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('선택지별 disabled: 꺼진 선택지는 고를 수 없고 나머지는 고를 수 있다', async () => {
    const { onChange } = await openMenu({
      options: [
        { value: 'a', label: '가' },
        { value: 'b', label: '나', disabled: true },
        { value: 'c', label: '다' },
      ],
    });
    expect(option('나').hasAttribute('data-disabled')).toBe(true);
    expect(option('다').hasAttribute('data-disabled')).toBe(false);
    act(() => {
      fireEvent.click(option('나'));
    });
    await tick();
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      fireEvent.click(option('다'));
    });
    await tick();
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('묶음 전체의 disabled 는 그대로다 (모든 선택지가 꺼진다)', async () => {
    await openMenu({ disabled: true });
    for (const label of ['가', '나', '다']) {
      expect(option(label).hasAttribute('data-disabled'), label).toBe(true);
    }
  });
});
