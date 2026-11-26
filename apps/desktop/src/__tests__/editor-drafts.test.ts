import { EditorState } from '@codemirror/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { editorDrafts } from '../store/editor-drafts';
import { type EditorFile, fileEditors } from '../store/file-editor-store';

vi.mock('../store/session-registry', () => ({
  getSessionStore: (id: number) =>
    id === 2
      ? { getState: () => ({ path: '/workspace/api' }) }
      : id === 3
        ? { getState: () => ({ path: '/workspace-other' }) }
        : undefined,
  getFolderStore: (id: number) =>
    id === 1 ? { getState: () => ({ path: '/workspace' }) } : undefined,
}));
/** 실제 저장 계약과 같은 초안·원본 줄 끝·소스 별칭을 준비한다. */
function doc(sources: [number, string][], dirty = true): EditorFile {
  return {
    dirty,
    bom: true,
    lineEnding: 'crlf',
    state: EditorState.create({ doc: 'draft\ntext' }),
    sources: new Map(sources.map(([session, path]) => [String(session), { session, path }])),
  } as EditorFile;
}
afterEach(() => vi.restoreAllMocks());

describe('shared editor draft paths', () => {
  it('includes a dirty repo-tab document in folder search without a folder alias', () => {
    vi.spyOn(fileEditors, 'documents').mockReturnValue([doc([[2, 'src/a.ts']])]);
    expect(editorDrafts('/workspace')).toEqual([
      { path: 'api/src/a.ts', text: '\uFEFFdraft\r\ntext' },
    ]);
  });
  it('deduplicates aliases, excludes clean and sibling-root files, supports root slash', () => {
    vi.spyOn(fileEditors, 'documents').mockReturnValue([
      doc([
        [1, 'api/a.ts'],
        [2, 'a.ts'],
      ]),
      doc([[3, 'outside.ts']]),
      doc([[2, 'saved.ts']], false),
    ]);
    expect(editorDrafts('/workspace/').map((d) => d.path)).toEqual(['api/a.ts']);
    expect(editorDrafts('/workspace/api').map((d) => d.path)).toEqual(['a.ts']);
  });
});
