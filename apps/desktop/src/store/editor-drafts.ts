import { type EditorFile, fileEditors, fileText } from './file-editor-store';
import { dirSpace, type RootSpace } from './root-space';
import { spaceOf } from './session-space';

/** 초안 하나: 요청 루트 기준 상대 경로와 그 문서 */
interface DraftEntry {
  path: string;
  doc: EditorFile;
}

/**
 * 요청 루트 공간 안의 초안 문서를 상대 경로와 함께 고른다 (`editorDrafts`·`editorDraftStamp`·`editorDocStamp` 공용).
 * `includeClean` 이면 저장된 문서도 고른다. 같은 문서를 여러 세션이 열었으면 루트 공간으로 바꿀 수 있는 첫 별칭 하나만
 * 쓴다
 */
function draftEntries(
  root: string | RootSpace,
  options: { includeSaving?: boolean; includeClean?: boolean } = {},
): DraftEntry[] {
  const space = typeof root === 'string' ? dirSpace(root) : root;
  return fileEditors
    .documents()
    .filter((doc) => options.includeClean || doc.dirty || (options.includeSaving && !!doc.inflight))
    .flatMap((doc) => {
      for (const source of doc.sources.values()) {
        // 문서를 연 세션의 경로 공간으로 실제 경로를 얻는다 (닫힌 세션·공간 밖이면 다음 별칭)
        const absolute = spaceOf(source.session)?.toAbs(source.path) ?? null;
        const path = absolute === null ? null : space.toRel(absolute);
        if (path) return [{ path, doc }];
      }
      return [];
    });
}

/**
 * 폴더·저장소·가벼운 세션에서 열린 같은 초안을 요청 루트의 상대 경로로 한 번만 전달한다. `root` 는 디렉터리의 절대 경로
 * 이거나 탭의 경로 공간이다 (MR-13 — 그룹 탭의 내용 검색은 초안을 `별칭/…` 로 보낸다). 공간 밖·루트 자신(빈 경로)인
 * 초안은 빠진다
 */
export function editorDrafts(
  root: string | RootSpace,
  options: { includeSaving?: boolean } = {},
): { path: string; text: string }[] {
  return draftEntries(root, options).map(({ path, doc }) => ({ path, text: fileText(doc) }));
}

/**
 * `editorDrafts(root, options)` 가 줄 초안의 지문 (경로·문서 sequence, 반응성 F1). 원문을 직렬화하지 않아 입력마다
 * 계산해도 싸다. 같으면 같은 문자열이므로 초안이 바뀔 때만 다시 조회하는 신호로 쓴다. `path` 를 주면 그 상대 경로의
 * 초안만 본다
 */
export function editorDraftStamp(
  root: string | RootSpace,
  options: { includeSaving?: boolean; path?: string } = {},
): string {
  return draftEntries(root, options)
    .filter((entry) => options.path === undefined || entry.path === options.path)
    .map(({ path, doc }) => `${path}\u0000${doc.sequence}`)
    .sort()
    .join('\u0001');
}

/**
 * 요청 루트 공간 안에 열린 문서 전부(저장된 것 포함)의 지문: 경로·디스크 revision·(초안이면) sequence (반응성 F2). 초안이
 * 바뀌거나, 저장하거나, 편집기가 외부 변경을 읽어 원문을 바꾸면 달라진다. 바뀐 것 없는 검사에는 같다. `path` 를 주면 그
 * 상대 경로의 문서만 본다
 */
export function editorDocStamp(root: string | RootSpace, options: { path?: string } = {}): string {
  return draftEntries(root, { includeClean: true })
    .filter((entry) => options.path === undefined || entry.path === options.path)
    .map(({ path, doc }) => `${path}\u0000${doc.revision}\u0000${doc.dirty ? doc.sequence : '-'}`)
    .sort()
    .join('\u0001');
}
