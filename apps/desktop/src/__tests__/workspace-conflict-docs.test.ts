import type { ConflictPayload } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { describe, expect, it, vi } from 'vitest';
import { docDetail, docTitle, docTooltip } from '../features/workspace/doc-labels';
import { editorKeyDoc } from '../global-keys';
import type { ConflictDraft } from '../store/session-store';
import {
  type ConflictSlot,
  conflictDoc,
  conflictDocId,
  conflictDocs,
  createWorkspaceStore,
  docRepoPath,
  isSessionDoc,
  openConflictDraft,
  type SessionDocTarget,
  sessionDocsOf,
  worktreeDiffDocId,
} from '../store/workspace-store';

const API = '/f/api';
const WEB = '/f/web';

/** 열린 충돌 하나 (블롭 조합으로 초안 열쇠가 정해진다) */
function open(path: string, stages: (string | null)[] = ['1', '2', '3']): ConflictSlot['conflict'] {
  return { path, payload: { file: { path, stages } } as unknown as ConflictPayload };
}

/** 초안 */
const draft = (key: string): ConflictDraft => ({ text: 'x', ranges: [], key });

describe('충돌 문서의 파생 (ED-06, W15: 저장하지 않고 세션의 충돌 슬롯에서)', () => {
  it('장부의 저장소마다 그 세션이 충돌 파일을 열고 있으면 문서 하나. 초안은 같은 충돌(블롭 조합)의 것만 센다', () => {
    const slots: Record<number, ConflictSlot> = {
      1: { conflict: open('src/A.kt'), conflictDrafts: { 'src/A.kt': draft('1:2:3') } },
      2: { conflict: open('B.kt'), conflictDrafts: { 'B.kt': draft('다른 충돌') } },
      3: { conflict: null, conflictDrafts: { 'C.kt': draft('1:2:3') } },
    };
    const ledger = {
      [API]: { session: 1, held: true, usedAt: 1 },
      [WEB]: { session: 2, held: true, usedAt: 2 },
      '/f/c': { session: 3, held: true, usedAt: 3 },
      '/f/gone': { session: 9, held: true, usedAt: 4 },
    };
    const docs = conflictDocs(
      ledger,
      (s) => slots[s] ?? null,
      (repo) => `name:${repo}`,
    );
    expect(docs).toEqual([
      {
        kind: 'conflict',
        id: conflictDocId(API),
        repoPath: API,
        repoName: `name:${API}`,
        path: 'src/A.kt',
        draft: true,
      },
      {
        kind: 'conflict',
        id: conflictDocId(WEB),
        repoPath: WEB,
        repoName: `name:${WEB}`,
        path: 'B.kt',
        draft: false,
      },
    ]);
    // 저장소당 하나: 같은 저장소의 다른 파일이면 id 가 같다
    expect(conflictDoc({ repoPath: API, repoName: 'a', path: 'x', draft: false }).id).toBe(
      conflictDoc({ repoPath: API, repoName: 'a', path: 'y', draft: true }).id,
    );
    expect(openConflictDraft({ conflict: null, conflictDrafts: {} })).toBeNull();
  });

  it('세션 문서 전부: 작업 트리 diff 문서 뒤에 충돌 문서. 둘 다 세션 문서이고 저장소가 있다', () => {
    const ledger = { [API]: { session: 1, held: true, usedAt: 1 } };
    const docs = sessionDocsOf(
      ledger,
      () => ({
        selectedFile: { path: 'a.ts', staged: false, commit: null },
        conflict: open('B.kt'),
        conflictDrafts: {},
      }),
      () => 'api',
    );
    expect(docs.map((d) => d.id)).toEqual([worktreeDiffDocId(API), conflictDocId(API)]);
    for (const doc of docs) {
      expect(isSessionDoc(doc)).toBe(true);
      expect(docRepoPath(doc)).toBe(API);
    }
  });

  it('충돌 문서는 늘 고정 탭이고, 닫으면 저장하지 않으므로 그 문서의 세션 슬롯을 비우게 알린다', () => {
    const closeSessionDoc = vi.fn<(doc: SessionDocTarget) => void>();
    const ws = createWorkspaceStore('folder', { closeSessionDoc });
    ws.getState().setSessionDocs([
      conflictDoc({ repoPath: API, repoName: 'api', path: 'A.kt', draft: false }),
    ]);
    expect(ws.getState().sessionDocs.map((d) => [d.id, d.pinned])).toEqual([
      [conflictDocId(API), true],
    ]);
    ws.getState().revealDoc(conflictDocId(API));
    expect(ws.getState().activeRepo).toBe(API);
    ws.getState().closeDoc(conflictDocId(API));
    expect(closeSessionDoc).toHaveBeenCalledWith(expect.objectContaining({ kind: 'conflict' }));
    expect(ws.getState().sessionDocs).toHaveLength(1);
  });
});

describe('충돌 탭의 글자와 Esc', () => {
  const doc = (draftOn: boolean) =>
    conflictDoc({
      repoPath: API,
      repoName: 'catalog-service',
      path: 'src/x/FacetBuilder.kt',
      draft: draftOn,
    });

  it('제목은 파일 이름(초안이 있으면 표시), 보조 글자는 저장소 이름, 툴팁은 저장소·경로·초안', () => {
    expect(docTitle(doc(false))).toBe('FacetBuilder.kt');
    expect(docTitle(doc(true))).toBe(S.workspace.conflictTitle('FacetBuilder.kt', true));
    expect(docTitle(doc(true))).not.toBe(docTitle(doc(false)));
    expect(docDetail(doc(false))).toBe('catalog-service');
    expect(docTooltip(doc(true))).toBe(
      S.workspace.conflictTip('catalog-service', 'src/x/FacetBuilder.kt', true),
    );
  });

  it('Esc 가 보는 종류는 저장소 탭의 충돌 화면과 같은 conflict 다 (편집기 안의 Esc 는 편집기 몫)', () => {
    expect(editorKeyDoc({ ...doc(false), pinned: true })).toBe('conflict');
  });
});
