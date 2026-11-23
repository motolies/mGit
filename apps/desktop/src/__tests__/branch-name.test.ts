import { S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import {
  branchNameField,
  branchNameRule,
  normalizeBranchName,
} from '../features/branch/branch-name';

/** 전각 공백 (U+3000). 글자 그대로 쓰면 보통 공백과 구분되지 않아 코드로 만든다 */
const WIDE = String.fromCodePoint(0x3000);

describe('branch 이름 정규화 (normalizeBranchName)', () => {
  // [입력, 기대값, 설명]
  const cases: [string, string, string][] = [
    ['feature-x', 'feature-x', '바꿀 것이 없으면 그대로'],
    [' feature  x ', 'feature-x', '앞뒤 공백을 지우고 가운데 공백 덩어리는 하이픈 하나'],
    ['a - b', 'a-b', '공백에 붙은 하이픈까지 한 덩어리'],
    ['a -- b', 'a-b', '공백 사이의 하이픈 여럿도 한 덩어리'],
    ['a- b', 'a-b', '앞에 붙은 하이픈'],
    ['a -b', 'a-b', '뒤에 붙은 하이픈'],
    ['a--b', 'a--b', '공백 없이 쓴 하이픈은 그대로'],
    ['a\tb', 'a-b', '탭도 공백'],
    [`a${WIDE}b`, 'a-b', '전각 공백도 공백'],
    [`${WIDE}feature${WIDE}`, 'feature', '앞뒤의 전각 공백도 지운다'],
    ['feature/my new idea', 'feature/my-new-idea', '공백 덩어리마다 하이픈'],
    ['fix /  login', 'fix-/-login', '슬래시는 건드리지 않는다 (나머지는 코어 검사)'],
    ['   ', '', '공백뿐이면 빈 이름'],
    ['', '', '빈 입력'],
  ];
  it.each(cases)('%j → %j (%s)', (input, expected) => {
    expect(normalizeBranchName(input)).toBe(expected);
  });
});

describe('branch 이름 칸 (branchNameField)', () => {
  it('받은 칸에 정규화 규칙을 붙이고 나머지 속성은 그대로 둔다', () => {
    const field = branchNameField({ key: 'name', label: 'L', initial: 'x', required: true });
    expect(field).toMatchObject({ key: 'name', label: 'L', initial: 'x', required: true });
    expect(field.normalize?.apply(' a b ')).toBe('a-b');
  });

  it('미리보기 글자는 종류마다 다르다: 만들기(기본)·이름 바꾸기·쓰기', () => {
    expect(branchNameRule().preview('a-b')).toBe(S.dialog.branchNameWillCreate('a-b'));
    expect(branchNameRule('rename').preview('a-b')).toBe(S.dialog.branchNameWillRename('a-b'));
    expect(branchNameRule('use').preview('a-b')).toBe(S.dialog.branchNameWillUse('a-b'));
  });
});
