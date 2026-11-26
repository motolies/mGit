import { fileEditors, fileText } from './file-editor-store';
import { joinRoot, relativeTo } from './fs-path';
import { getFolderStore, getSessionStore } from './session-registry';

/** 폴더·저장소·가벼운 세션에서 열린 같은 초안을 요청 루트의 상대 경로로 한 번만 전달한다. */
export function editorDrafts(
  root: string,
  options: { includeSaving?: boolean } = {},
): { path: string; text: string }[] {
  return fileEditors
    .documents()
    .filter((doc) => doc.dirty || (options.includeSaving && !!doc.inflight))
    .flatMap((doc) => {
      for (const source of doc.sources.values()) {
        const sourceRoot =
          getSessionStore(source.session)?.getState().path ??
          getFolderStore(source.session)?.getState().path;
        const path = sourceRoot ? relativeTo(root, joinRoot(sourceRoot, source.path)) : null;
        if (path) return [{ path, text: fileText(doc) }];
      }
      return [];
    });
}
