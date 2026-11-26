import { fileEditors, fileText } from './file-editor-store';
import { dirSpace, type RootSpace } from './root-space';
import { spaceOf } from './session-space';

/**
 * 폴더·저장소·가벼운 세션에서 열린 같은 초안을 요청 루트의 상대 경로로 한 번만 전달한다. `root` 는 디렉터리의 절대 경로
 * 이거나 탭의 경로 공간이다 (MR-13 — 그룹 탭의 내용 검색은 초안을 `별칭/…` 로 보낸다). 공간 밖·루트 자신(빈 경로)인
 * 초안은 빠진다
 */
export function editorDrafts(
  root: string | RootSpace,
  options: { includeSaving?: boolean } = {},
): { path: string; text: string }[] {
  const space = typeof root === 'string' ? dirSpace(root) : root;
  return fileEditors
    .documents()
    .filter((doc) => doc.dirty || (options.includeSaving && !!doc.inflight))
    .flatMap((doc) => {
      for (const source of doc.sources.values()) {
        // 문서를 연 세션의 경로 공간으로 실제 경로를 얻는다 (닫힌 세션·공간 밖이면 다음 별칭)
        const absolute = spaceOf(source.session)?.toAbs(source.path) ?? null;
        const path = absolute === null ? null : space.toRel(absolute);
        if (path) return [{ path, text: fileText(doc) }];
      }
      return [];
    });
}
