// branch 이름 정규화 (새로 만들기·이름 바꾸기 공용): 앞뒤 공백을 지우고 가운데 공백은 하이픈으로 바꾼다. 입력 칸은
// `branchNameField` 로 만들면 대화상자가 바뀐 이름을 칸 아래에 미리 보이고, 확인 결과에도 바꾼 이름을 넣는다.
// 그 밖의 잘못된 이름(`..`, `~`, 맨 앞 `-` 등)은 지금처럼 코어 검사(`check_ref_name`)가 막는다.

import { type PromptField, type PromptNormalize, S } from '@mgit/ui';

/** 가운데 공백 한 덩어리: 공백(탭·전각 공백 포함)이 하나 이상 있고, 그 앞뒤에 붙은 공백·하이픈까지 */
const SPACE_RUN = /[\s-]*\s[\s-]*/g;

/**
 * branch 이름 정규화: 앞뒤 공백을 지우고, 가운데 공백 덩어리(탭·전각 공백, 붙은 하이픈 포함)를 하이픈 하나로 바꾼다.
 * 공백 없이 쓴 하이픈(`a--b`)은 그대로 둔다. 예: `" feature  x "` → `feature-x`, `"a - b"` → `a-b`
 */
export function normalizeBranchName(raw: string): string {
  return raw.trim().replace(SPACE_RUN, '-');
}

/** 미리보기 글자의 종류: 만들기(새 branch) · 이름 바꾸기 · 쓰기(만들거나 있는 것을 고르는 칸) */
export type BranchNameMode = 'create' | 'rename' | 'use';

/** branch 이름 칸의 다듬기 규칙 (`PromptField.normalize`). 미리보기 글자는 부른 순간의 언어다 */
export function branchNameRule(mode: BranchNameMode = 'create'): PromptNormalize {
  const preview = {
    create: S.dialog.branchNameWillCreate,
    rename: S.dialog.branchNameWillRename,
    use: S.dialog.branchNameWillUse,
  }[mode];
  return { apply: normalizeBranchName, preview };
}

/** branch 이름 입력 칸: 받은 칸에 정규화 규칙을 붙인다 */
export function branchNameField(
  field: Omit<PromptField, 'normalize'>,
  mode: BranchNameMode = 'create',
): PromptField {
  return { ...field, normalize: branchNameRule(mode) };
}
