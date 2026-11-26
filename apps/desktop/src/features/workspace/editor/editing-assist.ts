import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { bracketMatching, foldGutter, foldKeymap, indentUnit } from '@codemirror/language';
import { EditorState, type Extension, Prec } from '@codemirror/state';
import { crosshairCursor, EditorView, keymap, rectangularSelection } from '@codemirror/view';
import { S } from '@mgit/ui';
import { EDITOR_TAB_SIZE } from './indentation';

export interface EditingAssistOptions {
  /** 괄호·따옴표 자동 닫기 (설정, 기본 켜짐) */
  autoCloseBrackets: boolean;
  /** 구조 변경 잠금 등으로 글을 바꿀 수 없는 상태. 자동 닫기를 붙이지 않는다 */
  readOnly: boolean;
  /** 파일 내용으로 정한 들여쓰기 단위 (`indentUnitFor`) */
  indentUnit: string;
}

/** 앱 토큰 색을 쓰므로 밝은·어두운 테마를 그대로 따른다. */
const assistTheme = EditorView.theme({
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--accent) 28%, transparent)',
  },
  '&.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--danger) 28%, transparent)',
  },
  '.cm-foldGutter .cm-gutterElement': { cursor: 'pointer', padding: '0 3px' },
  '.cm-foldPlaceholder': {
    color: 'var(--fg-muted)',
    backgroundColor: 'var(--bg-panel)',
    border: '1px solid var(--border)',
  },
});

/** 접기 여백·접힌 자리의 CodeMirror 문구를 앱 언어로 바꾼다. */
function foldPhrases(): Record<string, string> {
  return {
    'Fold line': S.fileEditor.foldLine,
    'Unfold line': S.fileEditor.unfoldLine,
    'folded code': S.fileEditor.foldedCode,
    unfold: S.fileEditor.unfoldLine,
    'Folded lines': S.fileEditor.foldedLines,
    'Unfolded lines': S.fileEditor.unfoldedLines,
    to: S.fileEditor.foldRangeTo,
  };
}

/**
 * 파일 편집기의 편집 보조: 괄호 짝 강조, 괄호·따옴표 자동 닫기, 접기 여백·접기 키, 다중 커서(⌘D·⌘클릭·⌘⌥↑↓·
 * ⌥드래그 사각 선택), 파일별 들여쓰기. 자동 완성은 넣지 않는다. 키 묶음은 편집기의 기본 keymap 보다 앞에 두어야
 * Backspace 가 자동으로 닫은 괄호 쌍을 함께 지운다(같은 키는 앞의 묶음이 먼저 받는다). 접기 여백은 우선순위를 낮춰
 * 줄 번호·변경 표시·Blame 여백 뒤, 본문 바로 앞에 둔다. 한글 조합 중에는 CodeMirror 가 키 묶음을 돌리지 않고 자동
 * 닫기 입력 처리도 조합이 시작된 동안 비켜서므로 조합을 깨지 않는다
 */
export function editingAssist(options: EditingAssistOptions): Extension {
  const autoClose = options.autoCloseBrackets && !options.readOnly;
  return [
    EditorState.tabSize.of(EDITOR_TAB_SIZE),
    indentUnit.of(options.indentUnit),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    bracketMatching(),
    autoClose ? closeBrackets() : [],
    Prec.low(foldGutter()),
    EditorState.phrases.of(foldPhrases()),
    assistTheme,
    keymap.of([...(autoClose ? closeBracketsKeymap : []), ...foldKeymap]),
  ];
}
