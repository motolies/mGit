import { S } from '@mgit/ui';
// 빈 에디터 공간의 단축키 안내 (ED-07 폴더 탭, ED-11 저장소 탭). 두 탭이 같은 줄을 쓴다.

import type { Action } from '../../actions';
import type { CommandSource } from '../../components/command-context';
import type { EditorEmptyStateProps, EditorHint } from './EditorArea';

/** 빈 에디터 공간에 단축키를 안내할 동작 (팔레트 다음 줄부터) */
const HINT_ACTION_IDS = ['app.palette', 'view.focusSidebar', 'view.focusGraph', 'view.terminal'];

/**
 * 안내 줄을 동작 목록에서 만든다: 팔레트 + 정한 동작들. 단축키는 동작 목록의 것(사용자 재지정 반영)이고, 목록에 없는
 * 동작은 뺀다 (단축키가 없는 줄은 `EditorEmptyState` 가 그리지 않는다)
 */
export function editorHints(actions: readonly Action[]): EditorHint[] {
  return [
    ...HINT_ACTION_IDS.flatMap((id) => {
      const action = actions.find((a) => a.id === id);
      return action ? [{ label: action.title, shortcut: action.shortcut }] : [];
    }),
  ];
}

/**
 * 저장소 탭 빈 에디터 공간의 링크 (폴더 탭의 "개요 열기" 자리): 팔레트의 `view.tagsDoc` 을 그대로 부른다. 그 동작은 기본
 * 키가 없어 단축키 안내 줄에 들지 않으므로 링크로 둔다. 동작이 없거나 꺼져 있으면 링크도 없다
 */
export function tagsDocLink(actions: readonly Action[]): EditorEmptyStateProps['action'] {
  const action = actions.find((a) => a.id === 'view.tagsDoc');
  return action?.enabled ? { label: S.tag.doc.open, onClick: action.run } : undefined;
}

/**
 * 동작 출처를 만든다 (D-3): 안내·링크는 지금 목록(`current()`)에서 뽑아 두고, 링크를 누르면 그때의 목록에서 동작을 찾아
 * 실행한다 (켜져 있을 때만). 앱 루트는 안내 글자와 링크 유무가 같으면 옛 출처를 그대로 넘긴다 (`commandSourceKey`)
 */
export function commandSourceOf(current: () => readonly Action[]): CommandSource {
  const actions = current();
  const link = tagsDocLink(actions);
  return {
    current,
    hints: editorHints(actions),
    tagsDoc: link
      ? {
          label: link.label,
          onClick: () => {
            const action = current().find((a) => a.id === 'view.tagsDoc');
            if (action?.enabled) action.run();
          },
        }
      : undefined,
  };
}

/** 출처를 새로 만들어야 하는지 가르는 열쇠: 안내 글자·단축키와 링크 유무 (활성 여부·실행 함수는 넣지 않는다) */
export function commandSourceKey(actions: readonly Action[]): string {
  return JSON.stringify([editorHints(actions), tagsDocLink(actions) !== undefined]);
}
