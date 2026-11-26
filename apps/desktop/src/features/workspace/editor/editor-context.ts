import type { EditorView } from '@codemirror/view';
import type { MenuItem } from '../../../components/ContextMenu';
export const editorContextItems = new WeakMap<EditorView, () => MenuItem[]>();
