import type { GraphScrollAnchor } from '@mgit/graph-view';
import type { SessionId } from '@mgit/ipc';
import { createStore, type StoreApi } from 'zustand';
import { writePref } from './prefs';
import { nextActiveRepo, type RepoSessionLedger } from './repo-sessions';
import {
  type ConflictDraft,
  type DiffMode,
  type DiffViewOptions,
  type FileTarget,
  PREF_DIFF_MODE,
  readDiffMode,
  readDiffOptions,
  type SessionDocSlot,
  type SessionState,
} from './session-store';

/** 워크스페이스의 루트: 저장소 하나 / 여러 저장소가 든 폴더 */
export type RootKind = 'repo' | 'folder';

/**
 * 커밋 하나의 파일 diff 문서 (ED-03, 읽기 전용). 폴더 탭은 저장소 세션 없이 폴더 API 로 읽는다 (CD-05).
 * 저장소는 경로로 가리킨다 (타임라인 번호는 재스캔으로 밀린다)
 */
export interface CommitDiffTarget {
  kind: 'commitDiff';
  repoPath: string;
  /** 표시용 저장소 이름 (탭 툴팁·영역 표시). 여러 저장소의 같은 이름 파일을 가른다 (ED-02) */
  repoName: string;
  oid: string;
  path: string;
  /** 이름이 바뀐 파일의 옛 경로. 함께 넘겨야 diff 가 rename 으로 짝지어진다 */
  oldPath: string | null;
  /** 머지 commit 인지. 파일 diff 가 첫 부모 기준이라는 안내를 보인다 */
  merge: boolean;
}

/**
 * 작업 트리 파일 하나의 보기 문서 (ED-04, 읽기 전용). 경로는 워크스페이스 루트 기준 상대 경로다 — 폴더 탭은
 * 폴더, 저장소 탭은 작업 트리가 루트다 (파일 API 와 같다)
 */
export interface FileViewTarget {
  kind: 'file';
  /** 루트 기준 상대 경로 (`/` 구분) */
  path: string;
  /** 탭 제목에 쓸 파일 이름 */
  name: string;
  /** 이 파일이 속한 가장 안쪽 저장소의 절대 경로. 저장소 밖 파일이면 null */
  repoPath: string | null;
  /** 그 저장소의 이름 (탭 보조 글자). 저장소 밖 파일이면 null */
  repoName: string | null;
}

/**
 * 작업 트리 파일 하나의 diff 문서 (ED-05, 저장소당 하나 — 결정 5번). 저장하는 문서가 아니라 폴더 장부의 저장소
 * 세션이 "지금 고른 파일"(`selectedFile`, 작업 트리 쪽)을 가질 때 앱 스토어가 파생해 `sessionDocs` 에 싣는다 (계획
 * 5.2). 화면은 문서의 저장소로 장부에서 세션을 찾는다 — 활성 저장소가 아니라 (W13 ③)
 */
export interface WorktreeDiffTarget {
  kind: 'worktreeDiff';
  /** 저장소 절대 경로 (장부의 키) */
  repoPath: string;
  /** 표시용 저장소 이름 (탭 보조 글자·확인창) */
  repoName: string;
  /** 저장소 기준 상대 경로 */
  path: string;
  /** staged 쪽 diff 인지 (거짓이면 작업 트리 쪽) */
  staged: boolean;
}

/**
 * 충돌 파일 하나의 머지 편집기 문서 (ED-06, 저장소당 하나 — 결정 5번, 늘 고정 탭). 작업 트리 diff 문서처럼 저장하지
 * 않고 폴더 장부의 저장소 세션이 충돌 파일을 열고 있을 때(`conflict` 슬롯) 앱 스토어가 파생한다. 화면은 문서의 저장소로
 * 장부에서 세션을 찾는다 — 활성 저장소가 아니라 (W14 의 길)
 */
export interface ConflictTarget {
  kind: 'conflict';
  /** 저장소 절대 경로 (장부의 키) */
  repoPath: string;
  /** 표시용 저장소 이름 (탭 보조 글자·확인창) */
  repoName: string;
  /** 저장소 기준 상대 경로 (지금 연 충돌 파일) */
  path: string;
  /** 이 충돌에 저장하지 않은 편집(초안)이 있는지 — 탭 제목에 표시한다 */
  draft: boolean;
}

/**
 * 저장소 탭의 커밋·범위 파일 diff 문서 (W20, 저장소당 하나). 저장소 탭은 "지금 고른 파일"(`selectedFile`)이 커밋
 * 파일(`openCommitFile`)이나 범위 파일(`openRangeFile`)이어도 같은 diff 화면에 그린다 — 그 경우의 세션 문서다. 폴더 탭은
 * 커밋 diff 를 폴더 API 의 커밋 diff 문서(`CommitDiffTarget`)로 열므로 이 문서를 만들지 않는다 (작업 트리 diff 만 파생)
 */
export interface HistoryDiffTarget {
  kind: 'historyDiff';
  /** 저장소 절대 경로 (저장소 탭의 작업 트리) */
  repoPath: string;
  /** 표시용 저장소 이름 */
  repoName: string;
  /** 저장소 기준 상대 경로 */
  path: string;
  /** 커밋 파일 diff 면 그 커밋, 범위 diff 면 범위 라벨 (`older..newer`) */
  rev: { kind: 'commit'; oid: string } | { kind: 'range'; label: string };
}

/** 세션에서 파생하는 문서 (작업 트리 diff, 저장소 탭의 커밋·범위 파일 diff, 충돌 머지 편집기) */
export type SessionDocTarget = WorktreeDiffTarget | HistoryDiffTarget | ConflictTarget;

/**
 * 저장소 탭의 태그 문서 (C3a, TG-10). 저장소당 하나이고 늘 고정 탭으로 연다. 화면 상태(원격·필터·검색·정렬·선택)는
 * 탭의 워크스페이스(`tagsView`)에 두고 저장하지 않는다
 */
export interface TagsDocTarget {
  kind: 'tags';
  /** 저장소 절대 경로 (저장소 탭의 작업 트리) */
  repoPath: string;
  /** 표시용 저장소 이름 (탭 보조 글자) */
  repoName: string;
}

/**
 * 문서가 가리키는 대상. 종류마다 필요한 필드를 여기에 더한다.
 * 세션에 묶인 문서(작업 트리 diff, 커밋·범위 파일 diff, 충돌)는 `docs` 에 저장하지 않고 세션 상태에서 파생해
 * `sessionDocs` 로 받는다 (W14~W15, W20)
 */
export type DocTarget =
  | { kind: 'overview' }
  | CommitDiffTarget
  | FileViewTarget
  | SessionDocTarget
  | TagsDocTarget;

/** 열려는 문서. `id` 가 같으면 같은 탭이다 */
export type DocRequest = DocTarget & { id: string };

/** 에디터 공간에 열린 문서 (ED-01). `pinned` 가 false 면 미리보기 탭이다 */
export type EditorDoc = DocRequest & { pinned: boolean };

/** 문서를 여는 방식 (ED-02): 미리보기(단일 클릭) / 고정(더블클릭) */
export type OpenMode = 'preview' | 'pinned';

/** 폴더 워크스페이스의 개요 문서 (ED-07) */
export const OVERVIEW_DOC: DocRequest = { id: 'overview', kind: 'overview' };

/**
 * 커밋 파일 diff 문서의 id: (저장소, 커밋, 경로)로 정한다. 같은 파일을 다시 열면 같은 탭이 활성화된다.
 * 경로에 어떤 글자가 와도 섞이지 않게 JSON 배열로 잇는다
 */
export function commitDiffDocId(repoPath: string, oid: string, path: string): string {
  return `commitDiff:${JSON.stringify([repoPath, oid, path])}`;
}

/** 커밋 파일 diff 문서 요청을 만든다 */
export function commitDiffDoc(target: Omit<CommitDiffTarget, 'kind'>): DocRequest {
  return {
    kind: 'commitDiff',
    ...target,
    id: commitDiffDocId(target.repoPath, target.oid, target.path),
  };
}

/** 파일 보기 문서의 id: 루트 기준 상대 경로로 정한다 (같은 파일은 같은 탭) */
export function fileViewDocId(path: string): string {
  return `file:${path}`;
}

/** 파일 보기 문서 요청을 만든다 */
export function fileViewDoc(target: Omit<FileViewTarget, 'kind'>): DocRequest {
  return { kind: 'file', ...target, id: fileViewDocId(target.path) };
}

/** 작업 트리 diff 문서의 id: 저장소로 정한다 (저장소당 탭 하나 — 같은 저장소의 다른 파일은 같은 탭의 내용이 바뀐다) */
export function worktreeDiffDocId(repoPath: string): string {
  return `worktreeDiff:${repoPath}`;
}

/** 작업 트리 diff 문서 요청을 만든다 (세션 슬롯에서 파생할 때) */
export function worktreeDiffDoc(target: Omit<WorktreeDiffTarget, 'kind'>): DocRequest {
  return { kind: 'worktreeDiff', ...target, id: worktreeDiffDocId(target.repoPath) };
}

/** 커밋·범위 파일 diff 문서의 id: 저장소로 정한다 (저장소당 하나 — 세션의 "지금 고른 파일" 슬롯이 하나다) */
export function historyDiffDocId(repoPath: string): string {
  return `historyDiff:${repoPath}`;
}

/** 커밋·범위 파일 diff 문서 요청을 만든다 (저장소 탭의 세션 슬롯에서 파생할 때) */
export function historyDiffDoc(target: Omit<HistoryDiffTarget, 'kind'>): DocRequest {
  return { kind: 'historyDiff', ...target, id: historyDiffDocId(target.repoPath) };
}

/** 충돌 문서의 id: 저장소로 정한다 (저장소당 탭 하나 — 같은 저장소의 다른 충돌 파일은 같은 탭의 내용이 바뀐다) */
export function conflictDocId(repoPath: string): string {
  return `conflict:${repoPath}`;
}

/** 충돌 문서 요청을 만든다 (세션 슬롯에서 파생할 때) */
export function conflictDoc(target: Omit<ConflictTarget, 'kind'>): DocRequest {
  return { kind: 'conflict', ...target, id: conflictDocId(target.repoPath) };
}

/** 태그 문서의 id: 저장소로 정한다 (저장소당 하나) */
export function tagsDocId(repoPath: string): string {
  return `tags:${repoPath}`;
}

/** 태그 문서 요청을 만든다 */
export function tagsDoc(target: Omit<TagsDocTarget, 'kind'>): DocRequest {
  return { kind: 'tags', ...target, id: tagsDocId(target.repoPath) };
}

/** 문서가 속한 저장소의 절대 경로 (WS-07). 개요나 저장소 밖 파일은 null */
export function docRepoPath(doc: DocTarget): string | null {
  switch (doc.kind) {
    case 'overview':
      return null;
    case 'commitDiff':
    case 'file':
    case 'worktreeDiff':
    case 'historyDiff':
    case 'conflict':
    case 'tags':
      return doc.repoPath;
  }
}

/** 작업 트리 diff 문서를 파생할 때 읽는 세션 슬롯 */
export type DiffSlot = Pick<SessionState, 'selectedFile'>;

/**
 * 폴더 장부에서 작업 트리 diff 문서를 파생한다 (계획 5.2, 결정 5번): 장부의 저장소마다 그 세션의 "지금 고른 파일"이
 * 작업 트리 파일(커밋·범위 diff 가 아님)이면 문서 하나. 순서는 장부 순서(처음 연 순서)다. 스토어가 없는 세션은 건너뛴다
 */
export function worktreeDiffDocs(
  ledger: RepoSessionLedger,
  slotOf: (session: SessionId) => DiffSlot | null,
  nameOf: (repoPath: string) => string,
): DocRequest[] {
  return Object.entries(ledger).flatMap(([repoPath, entry]) => {
    const file = slotOf(entry.session)?.selectedFile ?? null;
    if (file === null || file.commit !== null || file.range !== undefined) {
      return [];
    }
    return [
      worktreeDiffDoc({
        repoPath,
        repoName: nameOf(repoPath),
        path: file.path,
        staged: file.staged,
      }),
    ];
  });
}

/** 충돌 문서를 파생할 때 읽는 세션 슬롯 */
export type ConflictSlot = Pick<SessionState, 'conflict' | 'conflictDrafts'>;

/**
 * 지금 연 충돌의 초안 (ED-06). 초안은 경로별로 남는데, 같은 경로라도 다른 충돌(rebase 다음 단계)의 초안은 쓰지 않는다 —
 * 블롭 조합(`stages`)이 같을 때만 그 충돌의 초안이다. 충돌 편집기(`ConflictPane`)와 탭의 초안 표시가 같은 규칙을 쓴다.
 * 열린 충돌이 없거나 초안이 없으면 null
 */
export function openConflictDraft(slot: ConflictSlot): ConflictDraft | null {
  const open = slot.conflict;
  if (open === null) {
    return null;
  }
  const saved = slot.conflictDrafts[open.path];
  return saved !== undefined && saved.key === conflictDraftKey(open.payload.file) ? saved : null;
}

/** 충돌 하나의 초안 열쇠: 그 충돌의 블롭 조합 */
export function conflictDraftKey(file: { stages: readonly (string | null)[] }): string {
  return file.stages.join(':');
}

/**
 * 폴더 장부에서 충돌 문서를 파생한다 (계획 5.2, ED-06): 장부의 저장소마다 그 세션이 충돌 파일을 열고 있으면(`conflict`
 * 슬롯) 문서 하나. 초안이 있으면 `draft` 다. 순서는 장부 순서다. 스토어가 없는 세션은 건너뛴다
 */
export function conflictDocs(
  ledger: RepoSessionLedger,
  slotOf: (session: SessionId) => ConflictSlot | null,
  nameOf: (repoPath: string) => string,
): DocRequest[] {
  return Object.entries(ledger).flatMap(([repoPath, entry]) => {
    const slot = slotOf(entry.session);
    if (!slot?.conflict) {
      return [];
    }
    return [
      conflictDoc({
        repoPath,
        repoName: nameOf(repoPath),
        path: slot.conflict.path,
        draft: openConflictDraft(slot) !== null,
      }),
    ];
  });
}

/** 폴더 장부의 세션 문서 전부: 작업 트리 diff 문서 뒤에 충돌 문서 (탭 막대에서 저장한 문서 뒤에 온다) */
export function sessionDocsOf(
  ledger: RepoSessionLedger,
  slotOf: (session: SessionId) => (DiffSlot & ConflictSlot) | null,
  nameOf: (repoPath: string) => string,
): DocRequest[] {
  return [...worktreeDiffDocs(ledger, slotOf, nameOf), ...conflictDocs(ledger, slotOf, nameOf)];
}

/** 고른 파일이 커밋·범위 파일이면 그 출처, 작업 트리 파일이면 null */
function historyRev(file: FileTarget): HistoryDiffTarget['rev'] | null {
  if (file.range) {
    return { kind: 'range', label: file.range.label };
  }
  return file.commit !== null ? { kind: 'commit', oid: file.commit } : null;
}

/** 저장소 탭의 세션 문서를 파생할 때 읽는 세션 슬롯 */
export type RepoDocSlot = DiffSlot & ConflictSlot & Pick<SessionState, 'conflictLoading'>;

/**
 * 저장소 탭의 세션 문서 (W20, 계획 5.2): 그 탭 자신의 세션 하나에서 파생한다. 폴더 장부의 파생(`sessionDocsOf`)을 그
 * 세션 하나짜리 장부로 부르고(슬롯을 직접 주므로 장부의 세션 id 는 쓰지 않는다), 저장소 탭에만 있는 두 경우를 더한다 —
 * ① "지금 고른 파일"이 커밋·범위 파일이면 커밋·범위 파일 diff 문서 (저장소 탭은 같은 diff 화면에 그린다. 폴더 탭은
 * 커밋 diff 를 폴더 API 문서로 연다) ② 충돌을 읽는 중이고 아직 열린 충돌이 없으면 경로가 빈 충돌 문서 (옛 화면이 읽는
 * 동안 "불러오는 중" 칸을 보였다 — 읽기가 실패하면 문서가 사라진다). 순서는 diff 뒤에 충돌이다
 */
export function repoSessionDocs(
  repoPath: string,
  repoName: string,
  slot: RepoDocSlot,
): DocRequest[] {
  const ledger: RepoSessionLedger = { [repoPath]: { session: 0, held: false, usedAt: 0 } };
  const shared = sessionDocsOf(
    ledger,
    () => slot,
    () => repoName,
  );
  const file = slot.selectedFile;
  const rev = file === null ? null : historyRev(file);
  const history =
    file !== null && rev !== null
      ? [historyDiffDoc({ repoPath, repoName, path: file.path, rev })]
      : [];
  const opening =
    slot.conflict === null && slot.conflictLoading
      ? [conflictDoc({ repoPath, repoName, path: '', draft: false })]
      : [];
  return [...history, ...shared, ...opening];
}

/** 세션에서 파생한 문서인지 (저장하지 않고 세션 상태가 정한다 — 닫으면 그 세션의 슬롯을 비운다) */
export function isSessionDoc(doc: DocTarget): doc is SessionDocTarget {
  switch (doc.kind) {
    case 'worktreeDiff':
    case 'historyDiff':
    case 'conflict':
      return true;
    case 'overview':
    case 'commitDiff':
    case 'file':
    case 'tags':
      return false;
  }
}

/** 세션 문서가 비추는 슬롯: diff 문서(작업 트리·커밋·범위)는 "지금 고른 파일", 충돌 문서는 열린 충돌 */
export function sessionDocSlot(doc: SessionDocTarget): SessionDocSlot {
  switch (doc.kind) {
    case 'worktreeDiff':
    case 'historyDiff':
      return 'diff';
    case 'conflict':
      return 'conflict';
  }
}

/**
 * diff 보기 옵션의 저장 키. 저장소 탭의 세션 스토어(`session-store.ts` 의 같은 이름 상수)와 같은 키를 써서
 * 두 화면이 옵션을 함께 쓴다 — 바꾸면 양쪽을 함께 바꾼다 (`workspace-store.test.ts` 가 맞물림을 확인한다)
 */
export const PREF_DIFF_OPTIONS = 'mgit.diffOptions';

/** 에디터 탭 상태 */
export interface EditorTabs {
  /** 열린 문서 (탭 막대 순서) */
  docs: EditorDoc[];
  /**
   * 세션 상태에서 파생한 문서 (작업 트리 diff·충돌 머지 편집기 — 종류마다 저장소당 하나). 탭 막대에서 `docs` 뒤에
   * 온다. 앱 스토어가 장부(폴더 탭)·탭 자신의 세션(저장소 탭, W20)의 슬롯을 보고 맞춘다 (`setSessionDocs`). 단위
   * 테스트는 없을 수 있다
   */
  sessionDocs?: EditorDoc[];
  activeDocId: string | null;
  /** 본 순서 (마지막이 가장 최근). 닫을 때 직전에 보던 문서로 돌아가는 데 쓴다 */
  recentDocIds: string[];
}

/** 탭 막대에 보이는 문서 전부: 저장한 문서 뒤에 세션 문서 */
export function allDocs(tabs: Pick<EditorTabs, 'docs' | 'sessionDocs'>): EditorDoc[] {
  return tabs.sessionDocs && tabs.sessionDocs.length > 0
    ? [...tabs.docs, ...tabs.sessionDocs]
    : tabs.docs;
}

/** 그 id 의 문서가 열려 있는지 (세션 문서 포함) */
function hasDoc(tabs: EditorTabs, id: string): boolean {
  return tabs.docs.some((d) => d.id === id) || (tabs.sessionDocs ?? []).some((d) => d.id === id);
}

/**
 * 활성 문서가 사라졌을 때(닫힘·슬롯이 빔) 돌아갈 문서: 직전 문서(본 순서에서 아직 있는 가장 최근 문서, 없으면 탭 막대의
 * 마지막). 폴더 탭·저장소 탭이 같다 (W21 — 저장소 탭도 탭 막대가 있다)
 */
function fallbackDocId(tabs: EditorTabs): string | null {
  const recent = [...tabs.recentDocIds].reverse().find((id) => hasDoc(tabs, id));
  return recent ?? allDocs(tabs).at(-1)?.id ?? null;
}

/** 루트 종류의 첫 탭 상태: 폴더는 개요가 열려 있고(ED-07) 저장소는 비어 있다 */
export function initialTabs(rootKind: RootKind): EditorTabs {
  if (rootKind === 'folder') {
    return {
      docs: [{ ...OVERVIEW_DOC, pinned: true }],
      activeDocId: OVERVIEW_DOC.id,
      recentDocIds: [OVERVIEW_DOC.id],
    };
  }
  return { docs: [], activeDocId: null, recentDocIds: [] };
}

/** 열려 있는 문서(세션 문서 포함)를 활성화한다. 없는 문서면 그대로 둔다 */
export function docActivated(tabs: EditorTabs, id: string): EditorTabs {
  if (!hasDoc(tabs, id)) {
    return tabs;
  }
  return {
    ...tabs,
    activeDocId: id,
    recentDocIds: [...tabs.recentDocIds.filter((d) => d !== id), id],
  };
}

/**
 * 문서를 연다 (ED-02). 이미 열려 있으면 그 탭을 활성화하고(고정으로 열었으면 고정으로 바꾼다),
 * 미리보기로 열면 기존 미리보기 탭의 자리를 차지하며, 그 밖에는 끝에 새 탭을 만든다
 */
export function docOpened(tabs: EditorTabs, doc: DocRequest, mode: OpenMode): EditorTabs {
  const existing = tabs.docs.find((d) => d.id === doc.id);
  if (existing) {
    const docs =
      mode === 'pinned' && !existing.pinned
        ? tabs.docs.map((d) => (d.id === doc.id ? { ...d, pinned: true } : d))
        : tabs.docs;
    return docActivated({ ...tabs, docs }, doc.id);
  }
  const opened: EditorDoc = { ...doc, pinned: mode === 'pinned' };
  const previewAt = mode === 'preview' ? tabs.docs.findIndex((d) => !d.pinned) : -1;
  const replaced = tabs.docs[previewAt];
  if (replaced) {
    // 세션 문서는 그대로 둔다 (W21 에서 고침: 빠뜨리면 미리보기를 바꿀 때 diff·충돌 탭이 탭 막대에서 사라졌다)
    return docActivated(
      {
        ...tabs,
        docs: tabs.docs.map((d, i) => (i === previewAt ? opened : d)),
        recentDocIds: tabs.recentDocIds.filter((d) => d !== replaced.id),
      },
      opened.id,
    );
  }
  return docActivated({ ...tabs, docs: [...tabs.docs, opened] }, opened.id);
}

/**
 * 저장한 문서를 닫는다. 보고 있던 문서였으면 직전에 보던 문서로 돌아간다. 세션 문서는 여기서 닫지 않는다 —
 * 그 세션의 슬롯을 비우면 파생 목록에서 빠진다 (`sessionDocsReplaced`)
 */
export function docClosed(tabs: EditorTabs, id: string): EditorTabs {
  if (!tabs.docs.some((d) => d.id === id)) {
    return tabs;
  }
  const next: EditorTabs = {
    ...tabs,
    docs: tabs.docs.filter((d) => d.id !== id),
    recentDocIds: tabs.recentDocIds.filter((d) => d !== id),
  };
  return {
    ...next,
    activeDocId: tabs.activeDocId === id ? fallbackDocId(next) : tabs.activeDocId,
  };
}

/**
 * 세션 문서 목록을 바꾼다 (파생 목록이 새로 왔다). 사라진 문서는 본 순서에서도 빼고, 보던 문서가 사라졌으면 직전에
 * 보던 문서로 돌아간다. 새로 생긴 문서는 활성화하지 않는다 (여는 쪽이 `revealDoc` 으로 보인다)
 */
export function sessionDocsReplaced(tabs: EditorTabs, sessionDocs: EditorDoc[]): EditorTabs {
  const next: EditorTabs = { ...tabs, sessionDocs };
  const live = (id: string) => hasDoc(next, id);
  const pruned: EditorTabs = { ...next, recentDocIds: tabs.recentDocIds.filter(live) };
  const activeDocId =
    tabs.activeDocId === null || live(tabs.activeDocId) ? tabs.activeDocId : fallbackDocId(pruned);
  return { ...pruned, activeDocId };
}

/** 두 세션 문서 목록이 같은지 (같으면 상태를 바꾸지 않는다 — 세션 상태가 바뀔 때마다 탭 막대를 다시 그리지 않게) */
export function sameSessionDocs(a: readonly EditorDoc[], b: readonly EditorDoc[]): boolean {
  return a.length === b.length && a.every((doc, i) => JSON.stringify(doc) === JSON.stringify(b[i]));
}

/** 미리보기 탭을 고정 탭으로 바꾼다 */
export function docPinned(tabs: EditorTabs, id: string): EditorTabs {
  if (!tabs.docs.some((d) => d.id === id && !d.pinned)) {
    return tabs;
  }
  return { ...tabs, docs: tabs.docs.map((d) => (d.id === id ? { ...d, pinned: true } : d)) };
}

/**
 * 저장소 탭 브랜치 트리의 화면 상태 (W22). 브랜치 트리는 Git 도구 창 로그 탭 안에 있어 콘솔·터미널로 바꾸거나 숨기면
 * 내려간다 — 다시 붙어도 펼침·고른 행·검색어가 남게 탭의 워크스페이스에 둔다 (탭을 닫으면 사라진다, 저장하지 않는다)
 */
export interface BranchTreeViewState {
  /** 사용자가 바꾼 펼침 (노드 id → 펼쳤는지). 없는 노드는 노드의 기본값을 따른다 */
  expansion: Readonly<Record<string, boolean>>;
  /** 고른 행의 노드 id (마지막으로 누른 행) */
  selected: readonly string[];
  search: string;
}

/** 브랜치 트리 화면 상태의 처음 값 */
export const INITIAL_BRANCH_TREE_VIEW: BranchTreeViewState = {
  expansion: {},
  selected: [],
  search: '',
};

/** 태그 문서의 상태 필터 (TG-10 ③): 전체 또는 고른 원격과 견준 상태 하나 */
export type TagFilter = 'all' | 'localOnly' | 'remoteOnly' | 'same' | 'diverged';

/** 태그 문서의 정렬 열: 이름·상태·날짜 (날짜는 `tag_list`, C3b) */
export type TagSortKey = 'name' | 'state' | 'date';

/**
 * 태그 문서를 여는 쪽이 남기는 요청 (C4): 문서가 받아 처리하고 지운다. `seq` 가 바뀌어야 새 요청이다
 * - `pushAll` (TG-13): 그 원격(null 이면 기본 원격)을 확인하고 "로컬에만" 을 모두 골라 push 단추에 포커스
 * - `remoteOnly`: 그 원격의 "원격에만" 필터로 연다
 */
export type TagsDocRequest =
  | { kind: 'pushAll'; remote: string | null; seq: number }
  | { kind: 'remoteOnly'; remote: string; seq: number };

/** 태그 문서의 화면 상태 (TG-10 ⑦): 탭의 워크스페이스에 두고 저장하지 않는다 */
export interface TagsViewState {
  /** 견줄 원격. null 이면 기본(업스트림의 원격 → origin → 첫 원격) */
  remote: string | null;
  filter: TagFilter;
  search: string;
  sort: { key: TagSortKey; desc: boolean };
  /** 고른 tag 이름 (다중 선택, 필터로 숨어도 남는다) */
  selected: readonly string[];
  /** 키보드 커서가 있는 tag 이름 */
  cursor: string | null;
  /** 범위 선택(⇧)의 기준 tag 이름 */
  anchor: string | null;
  /** 여는 쪽의 요청 (처리하면 null) */
  request: TagsDocRequest | null;
}

/** 태그 문서 화면 상태의 처음 값: 전체, 이름 역순 (새 버전이 위로) */
export const INITIAL_TAGS_VIEW: TagsViewState = {
  remote: null,
  filter: 'all',
  search: '',
  sort: { key: 'name', desc: true },
  selected: [],
  cursor: null,
  anchor: null,
  request: null,
};

/** 앱 탭 하나의 워크스페이스 화면 상태 (탭 id 별로 하나, 저장하지 않는다 — diff 옵션만 앱 전역 설정) */
export interface WorkspaceState extends EditorTabs {
  rootKind: RootKind;
  sessionDocs: EditorDoc[];
  /**
   * Commit 도구 창(폴더 모드)의 커밋 메시지 초안 (W14). 도구 창을 Project 와 번갈아 띄워도 남는다. 탭을 닫으면
   * 사라진다 (저장하지 않는다)
   */
  commitMessage: string;
  /** Commit 도구 창 변경 트리에서 접은 행 id (저장소·디렉터리). 기본은 모두 펼침 */
  commitCollapsed: readonly string[];
  /**
   * Commit 도구 창 변경 트리에 보일 저장소 (W19, 작업 띠의 "충돌 해결"). 트리가 그 저장소 줄까지 스크롤하고 알리면
   * (`ackCommitReveal`) 빈다. 트리가 아직 없거나 변경 목록에 그 저장소가 아직 없으면 생길 때까지 남는다
   */
  commitReveal: { repoPath: string; seq: number } | null;
  /**
   * 활성 저장소의 절대 경로 (WS-07). 프로젝트 트리에서 저장소(나 그 안의 항목)를 고르거나, 에디터 탭이
   * 활성화되면(그 문서의 저장소) 바뀐다. 저장소 밖의 항목·저장소 없는 문서(개요)는 바꾸지 않는다. 없으면 null.
   * 로그 필터·개요의 체크 선택과는 따로다
   */
  activeRepo: string | null;
  /** 커밋 diff 탭들의 보기 방식 (나란히/통합). 탭을 오가도 유지한다 */
  diffMode: DiffMode;
  /** 커밋 diff 탭들의 보기 옵션. 저장소 탭과 같은 설정(`mgit.diffOptions`)을 읽고 쓴다 */
  diffOptions: DiffViewOptions;
  /** 저장소 탭 브랜치 트리의 펼침·고른 행·검색어 (W22). 폴더 탭은 쓰지 않는다 */
  branchTree: BranchTreeViewState;
  /** 저장소 탭 태그 문서의 원격·필터·검색·정렬·선택 (C3a). 폴더 탭은 쓰지 않는다 */
  tagsView: TagsViewState;

  openDoc(doc: DocRequest, mode: OpenMode): void;
  activateDoc(id: string): void;
  /**
   * 열려 있는 문서(세션 문서 포함)를 보인다: 활성화하고 "문서가 열렸다"고 알린다 (아래 도구 창 최대화 해제, WS-03).
   * 세션 문서를 연 쪽이 슬롯을 채운 뒤에 부른다
   */
  revealDoc(id: string): void;
  /** 문서를 닫는다. 세션 문서면 그 세션의 슬롯을 비우게 알리고(`closeSessionDoc`) 파생 목록이 바뀌기를 기다린다 */
  closeDoc(id: string): void;
  pinDoc(id: string): void;
  /** 세션에서 파생한 문서 목록을 바꾼다 (앱 스토어가 장부·세션 슬롯이 바뀔 때 부른다). 같으면 아무것도 하지 않는다 */
  setSessionDocs(docs: readonly DocRequest[]): void;
  setCommitMessage(message: string): void;
  setCommitCollapsed(ids: readonly string[]): void;
  /** Commit 도구 창 변경 트리를 그 저장소 줄까지 스크롤하게 한다 (펼치는 것은 부르는 쪽이 `setCommitCollapsed` 로) */
  revealCommitRepo(repoPath: string): void;
  /** 트리가 `seq` 의 요청대로 스크롤했다 (그 뒤에 온 새 요청은 남긴다) */
  ackCommitReveal(seq: number): void;
  /** Commit 도구 창 변경 트리의 스크롤 위치를 기억한다 (도구 창을 다시 띄웠을 때 돌아갈 자리, 구독 상태 밖) */
  rememberCommitScroll(top: number): void;
  commitScrollTop(): number;
  /**
   * 활성 저장소를 정한다. null 이면 바꾸지 않는다 (저장소 밖의 항목을 골랐을 때). 잠겨 있으면(`activeRepoLocked`)
   * 다른 저장소로 옮기지 않는다 — 문서 열기·활성화·닫기도 같다
   */
  setActiveRepo(path: string | null): void;
  /**
   * 저장소 목록이 바뀌었을 때(재스캔) 활성 저장소가 목록에서 빠졌으면 비운다 (`activeRepoInList`). 목록을 아직 못
   * 읽었으면(null) 그대로 둔다. `setActiveRepo(null)` 은 "그대로" 라서 비우는 길을 따로 둔다
   */
  retainActiveRepo(repoPaths: readonly string[] | null): void;
  /** 문서 화면의 스크롤 위치를 기억한다 (탭을 다시 활성화했을 때 돌아갈 자리). 다시 그릴 값이 아니라 구독 상태 밖에 둔다 */
  rememberDocScroll(id: string, top: number): void;
  /** 기억해 둔 스크롤 위치. 없으면 0 */
  docScrollTop(id: string): number;
  /**
   * 저장소 탭 로그(그래프)의 스크롤 기준을 기억한다 (W21). 로그는 Git 도구 창의 탭이라 콘솔·터미널로 바꾸거나 숨기면
   * 내려간다 — 다시 붙을 때 이 기준에서 시작한다(폴더 탭의 타임라인 기준과 같은 길). 다시 그릴 값이 아니라 구독 상태 밖에 둔다
   */
  rememberLogAnchor(anchor: GraphScrollAnchor): void;
  /** 기억해 둔 로그 스크롤 기준. 없으면 null (맨 위에서 시작) */
  logAnchor(): GraphScrollAnchor | null;
  setDiffMode(mode: DiffMode): void;
  /** 옵션 일부를 바꾸고 저장한다 */
  setDiffOptions(patch: Partial<DiffViewOptions>): void;
  /** 브랜치 트리 화면 상태의 일부를 바꾼다 (W22) */
  setBranchTree(patch: Partial<BranchTreeViewState>): void;
  /** 태그 문서 화면 상태의 일부를 바꾼다 (C3a) */
  setTagsView(patch: Partial<TagsViewState>): void;
}

export type WorkspaceStore = StoreApi<WorkspaceState>;

export interface WorkspaceDeps {
  /** 문서가 열렸을 때. 아래 도구 창이 본문을 덮고 있으면(최대화) 풀어야 문서가 보인다 (WS-03) */
  onDocOpened?: () => void;
  /**
   * 활성 저장소를 다른 저장소로 옮기지 못하게 잠겼는지 (W13, 계획 5.1): 범위 세션(활성 저장소의 숨은 세션)이
   * 바쁘거나 세션을 여는 중이면 참. 앱 스토어가 장부를 보고 답한다. 없으면 잠그지 않는다. 트리 선택·탭 활성화가
   * 바꾸는 것은 막고 선택 자체는 그대로 움직인다. 저장소가 목록에서 빠질 때(`retainActiveRepo`)는 보지 않는다
   */
  activeRepoLocked?: () => boolean;
  /**
   * 세션 문서를 닫을 때 (W14·W15·W20·W21): 그 문서의 세션 슬롯을 비운다 (diff 는 `closeFile`, 충돌은 `closeConflict`).
   * 앱 스토어가 문서의 세션을 찾고(폴더 탭은 장부에서 문서의 저장소로, 저장소 탭은 탭 자신의 세션) 충돌 초안이 있으면 먼저
   * 확인한다. 없으면 세션 문서는 닫히지 않는다
   */
  closeSessionDoc?: (doc: SessionDocTarget) => void;
}

/** 탭 상태만 골라 낸다 (전이 함수에 넘길 때) */
function tabsOf(state: EditorTabs): EditorTabs {
  return {
    docs: state.docs,
    sessionDocs: state.sessionDocs ?? [],
    activeDocId: state.activeDocId,
    recentDocIds: state.recentDocIds,
  };
}

/**
 * 탭 상태가 바뀐 뒤의 활성 저장소 (WS-07): 활성 문서(세션 문서 포함)에 저장소가 있으면 그 저장소, 없으면(개요·
 * 저장소 밖 파일) 지금 값 그대로
 */
export function activeRepoAfter(tabs: EditorTabs, current: string | null): string | null {
  const doc = allDocs(tabs).find((d) => d.id === tabs.activeDocId);
  return (doc ? docRepoPath(doc) : null) ?? current;
}

/**
 * 저장소 목록이 바뀐 뒤의 활성 저장소 (WS-07): 목록에 아직 있으면 그대로, 빠졌으면 null (없는 저장소를 가리키지
 * 않게). 활성 저장소가 없거나 목록을 아직 못 읽었으면(null) 그대로
 */
export function activeRepoInList(
  active: string | null,
  repoPaths: readonly string[] | null,
): string | null {
  if (active === null || repoPaths === null) {
    return active;
  }
  return repoPaths.includes(active) ? active : null;
}

/** 워크스페이스 스토어를 만든다. 앱 스토어가 탭을 열 때 만들고 닫을 때 버린다 */
export function createWorkspaceStore(rootKind: RootKind, deps: WorkspaceDeps = {}): WorkspaceStore {
  // 문서별 스크롤 위치. 닫힌 문서의 것은 탭이 바뀔 때 버린다
  const scrolls = new Map<string, number>();
  // Commit 도구 창 변경 트리의 스크롤 위치 (다시 그릴 값이 아니라 구독 상태 밖에 둔다)
  let commitScroll = 0;
  // Commit 도구 창 "저장소 보이기" 요청 차례 (요청마다 오른다)
  let commitRevealSeq = 0;
  // 저장소 탭 로그의 스크롤 기준 (다시 그릴 값이 아니라 구독 상태 밖에 둔다)
  let logAnchor: GraphScrollAnchor | null = null;
  /** 탭 상태를 싣는다. 열린 문서에 없는 스크롤 기억은 버린다 */
  const applyTabs = (tabs: EditorTabs, activeRepo: string | null) => {
    for (const id of [...scrolls.keys()]) {
      if (!hasDoc(tabs, id)) {
        scrolls.delete(id);
      }
    }
    return { ...tabs, sessionDocs: tabs.sessionDocs ?? [], activeRepo };
  };
  /** 활성 저장소 후보를 잠금에 비춰 본 결과 (잠겨 있으면 지금 값을 지킨다) */
  const settle = (current: string | null, candidate: string | null) =>
    nextActiveRepo(current, candidate, deps.activeRepoLocked?.() ?? false);
  /** 탭이 바뀐 뒤의 활성 저장소: 보던 문서가 바뀌었을 때만 따라간다 */
  const followActive = (before: WorkspaceState, tabs: EditorTabs) =>
    tabs.activeDocId !== before.activeDocId
      ? settle(before.activeRepo, activeRepoAfter(tabs, before.activeRepo))
      : before.activeRepo;
  return createStore<WorkspaceState>()((set, get) => ({
    rootKind,
    ...initialTabs(rootKind),
    sessionDocs: [],
    activeRepo: null,
    diffMode: readDiffMode(),
    diffOptions: readDiffOptions(),
    commitMessage: '',
    commitCollapsed: [],
    commitReveal: null,
    branchTree: INITIAL_BRANCH_TREE_VIEW,
    tagsView: INITIAL_TAGS_VIEW,

    openDoc(doc, mode) {
      const current = get().activeRepo;
      const tabs = docOpened(tabsOf(get()), doc, mode);
      set(applyTabs(tabs, settle(current, activeRepoAfter(tabs, current))));
      deps.onDocOpened?.();
    },

    activateDoc(id) {
      const current = get().activeRepo;
      const tabs = docActivated(tabsOf(get()), id);
      set(applyTabs(tabs, settle(current, activeRepoAfter(tabs, current))));
    },

    revealDoc(id) {
      if (hasDoc(get(), id)) {
        get().activateDoc(id);
        deps.onDocOpened?.();
      }
    },

    closeDoc(id) {
      const before = get();
      const session = before.sessionDocs.find((d) => d.id === id);
      if (session) {
        // 파생 문서: 그 세션의 슬롯을 비우면 앱 스토어가 목록을 다시 만든다 (`setSessionDocs`)
        if (isSessionDoc(session)) {
          deps.closeSessionDoc?.(session);
        }
        return;
      }
      const tabs = docClosed(tabsOf(before), id);
      set(applyTabs(tabs, followActive(before, tabs)));
    },

    pinDoc(id) {
      set(docPinned(tabsOf(get()), id));
    },

    setSessionDocs(docs) {
      const before = get();
      const next: EditorDoc[] = docs.map((doc) => ({ ...doc, pinned: true }));
      if (sameSessionDocs(before.sessionDocs, next)) {
        return;
      }
      const tabs = sessionDocsReplaced(tabsOf(before), next);
      set(applyTabs(tabs, followActive(before, tabs)));
    },

    setCommitMessage(message) {
      set({ commitMessage: message });
    },

    setCommitCollapsed(ids) {
      set({ commitCollapsed: [...ids] });
    },

    revealCommitRepo(repoPath) {
      commitRevealSeq += 1;
      set({ commitReveal: { repoPath, seq: commitRevealSeq } });
    },

    ackCommitReveal(seq) {
      if (get().commitReveal?.seq === seq) {
        set({ commitReveal: null });
      }
    },

    rememberCommitScroll(top) {
      commitScroll = top;
    },

    commitScrollTop() {
      return commitScroll;
    },

    setActiveRepo(path) {
      const next = settle(get().activeRepo, path);
      if (next !== get().activeRepo) {
        set({ activeRepo: next });
      }
    },

    retainActiveRepo(repoPaths) {
      const next = activeRepoInList(get().activeRepo, repoPaths);
      if (next !== get().activeRepo) {
        set({ activeRepo: next });
      }
    },

    rememberDocScroll(id, top) {
      scrolls.set(id, top);
    },

    docScrollTop(id) {
      return scrolls.get(id) ?? 0;
    },

    rememberLogAnchor(anchor) {
      logAnchor = anchor;
    },

    logAnchor() {
      return logAnchor;
    },

    setDiffMode(mode) {
      set({ diffMode: mode });
      writePref(PREF_DIFF_MODE, mode);
    },

    setDiffOptions(patch) {
      const next = { ...get().diffOptions, ...patch };
      set({ diffOptions: next });
      writePref(PREF_DIFF_OPTIONS, next);
    },

    setTagsView(patch) {
      set({ tagsView: { ...get().tagsView, ...patch } });
    },

    setBranchTree(patch) {
      set({ branchTree: { ...get().branchTree, ...patch } });
    },
  }));
}
