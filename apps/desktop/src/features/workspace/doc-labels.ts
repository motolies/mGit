// 에디터 탭의 글자 (ED-02): 문서 종류마다 제목·보조 글자·툴팁을 정한다.

import { S, shortHash } from '@mgit/ui';
import { baseName, parentDir } from '../../store/fs-path';
import type { DocTarget } from '../../store/workspace-store';

/**
 * 탭 제목. 태그 문서는 "태그", 커밋 diff 는 `파일이름 @해시8`, 파일 보기·작업 트리 diff·범위 파일 diff 는 파일 이름, 충돌은 파일 이름(저장하지
 * 않은 편집이 있으면 ` *`). 저장소 탭에서 충돌을 읽는 동안(경로가 빈 문서, W20)은 "충돌 여는 중…" 이다 (W21)
 */
export function docTitle(doc: DocTarget): string {
  switch (doc.kind) {
    case 'overview':
      return S.workspace.overview;
    case 'commitDiff':
      return S.workspace.commitDiffTitle(baseName(doc.path), shortHash(doc.oid));
    case 'historyDiff':
      return doc.rev.kind === 'commit'
        ? S.workspace.commitDiffTitle(baseName(doc.path), shortHash(doc.rev.oid))
        : baseName(doc.path);
    case 'file':
      return doc.name;
    case 'worktreeDiff':
      return baseName(doc.path);
    case 'conflict':
      return doc.path === ''
        ? S.workspace.conflictOpening
        : S.workspace.conflictTitle(baseName(doc.path), doc.draft);
    case 'tags':
      return S.tag.doc.title;
  }
}

/**
 * 제목 뒤의 흐린 보조 글자 — 같은 이름의 문서를 가른다. 커밋 diff·작업 트리 diff 는 저장소 이름(공유 이력의 같은
 * 커밋·같은 파일을 여러 저장소에서 열어도 탭이 구분된다), 파일 보기는 속한 저장소 이름, 저장소 밖이면 상위 폴더 이름.
 * 없으면 undefined
 */
export function docDetail(doc: DocTarget): string | undefined {
  switch (doc.kind) {
    case 'overview':
      return undefined;
    case 'commitDiff':
    case 'worktreeDiff':
    case 'historyDiff':
    case 'conflict':
    case 'tags':
      return doc.repoName;
    case 'file': {
      if (doc.repoName !== null) {
        return doc.repoName;
      }
      const parent = parentDir(doc.path);
      return parent ? baseName(parent) : undefined;
    }
  }
}

/**
 * 탭 툴팁. 커밋 diff 는 `저장소: 경로 @해시8`, 작업 트리 diff 는 `저장소: 경로 (staged|작업 트리)`, 범위 파일 diff 는
 * `저장소: 경로 (범위 라벨)`, 파일 보기는 루트 기준 전체 상대 경로. 없으면 undefined (제목을 쓴다)
 */
export function docTooltip(doc: DocTarget): string | undefined {
  switch (doc.kind) {
    case 'overview':
      return undefined;
    case 'commitDiff':
      return S.workspace.commitDiffTip(doc.repoName, doc.path, shortHash(doc.oid));
    case 'historyDiff':
      return doc.rev.kind === 'commit'
        ? S.workspace.commitDiffTip(doc.repoName, doc.path, shortHash(doc.rev.oid))
        : S.workspace.worktreeDiffTip(doc.repoName, doc.path, doc.rev.label);
    case 'file':
      return doc.path;
    case 'worktreeDiff':
      return S.workspace.worktreeDiffTip(
        doc.repoName,
        doc.path,
        doc.staged ? S.diff.stagedLabel : S.diff.unstagedLabel,
      );
    case 'conflict':
      return doc.path === ''
        ? S.workspace.conflictOpeningTip(doc.repoName)
        : S.workspace.conflictTip(doc.repoName, doc.path, doc.draft);
    case 'tags':
      return undefined;
  }
}
