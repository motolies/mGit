// 빈 에디터 공간의 단축키 안내 (ED-07 폴더 탭, ED-11 저장소 탭). 두 탭이 같은 줄을 쓴다.

import { S } from '@mgit/ui';
import type { Action } from '../../actions';
import { PALETTE_SHORTCUT } from '../../global-keys';
import type { EditorHint } from './EditorArea';

/** 빈 에디터 공간에 단축키를 안내할 동작 (팔레트 다음 줄부터) */
const HINT_ACTION_IDS = ['view.focusSidebar', 'view.focusGraph', 'view.terminal'];

/**
 * 안내 줄을 동작 목록에서 만든다: 팔레트 + 정한 동작들. 단축키는 동작 목록의 것(사용자 재지정 반영)이고, 목록에 없는
 * 동작은 뺀다 (단축키가 없는 줄은 `EditorEmptyState` 가 그리지 않는다)
 */
export function editorHints(actions: readonly Action[]): EditorHint[] {
  return [
    { label: S.actions.palette, shortcut: PALETTE_SHORTCUT },
    ...HINT_ACTION_IDS.flatMap((id) => {
      const action = actions.find((a) => a.id === id);
      return action ? [{ label: action.title, shortcut: action.shortcut }] : [];
    }),
  ];
}
