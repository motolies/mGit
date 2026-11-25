import { describe, expect, it } from 'vitest';
import { createMockFileOperations } from '../mock/mock-file-operations';
import { createMockFs } from '../mock/mock-fs';
import type { FsOperationDecision, FsOperationRequest } from '../types';

/** 서로 다른 두 Project의 작업을 같은 목 파일시스템에서 실행한다. */
function setup() {
  const roots = ['/source', '/target'];
  const fs = createMockFs({
    folder: null,
    repos: roots.map((path) => ({ path, files: ['readme.txt'] })),
    fallbackFiles: [],
  });
  const operations = createMockFileOperations(
    fs,
    (session) => roots[session - 1] ?? '',
    () => {},
  );
  const run = async (request: FsOperationRequest, decisions: FsOperationDecision[] = []) => {
    const plan = await operations.fsPrepareOperation(request);
    return operations.fsExecuteOperation(plan.id, decisions);
  };
  return { fs, operations, run };
}

describe('Project 파일 작업 IPC 목', () => {
  it('새 파일 생성·저장·교차 Project cut 붙여넣기와 진행률을 제공한다', async () => {
    const { fs, operations, run } = setup();
    expect(
      (await run({ kind: 'createFile', sources: [], destination: { session: 1, path: 'new.txt' } }))
        .items[0]?.status,
    ).toBe('committed');
    const file = fs.readEditable('/source', 'new.txt');
    expect(file.kind).toBe('text');
    if (file.kind !== 'text') throw new Error('텍스트여야 한다');
    fs.save('/source', 'new.txt', file.revision, 'edited');
    await operations.fsClipboardWrite([{ kind: 'session', session: 1, path: 'new.txt' }], true);
    const clipboard = await operations.fsClipboardRead();
    if (!clipboard) throw new Error('clipboard가 있어야 한다');
    const plan = await operations.fsPrepareOperation({
      kind: 'move',
      sources: [{ kind: 'external', token: clipboard.token, index: 0 }],
      destination: { session: 2, path: '' },
    });
    expect(plan.items[0]?.sourceSize).toBe(6);
    const result = await operations.fsExecuteOperation(plan.id, []);
    expect(result.items[0]?.status).toBe('committed');
    expect(fs.kind('/source', 'new.txt')).toBeNull();
    expect(fs.read('/target', 'new.txt')).toMatchObject({ kind: 'text', text: 'edited' });
    expect(await operations.fsOperationProgress(plan.id)).toEqual({
      completed: 1,
      total: 1,
      currentPath: null,
    });
    await operations.fsClipboardWrite([], true);
    expect(await operations.fsClipboardRead()).toBeNull();
  });

  it('충돌에서 새 이름을 선택하면 기존 목적지 내용을 유지한다', async () => {
    const { fs, operations } = setup();
    const before = fs.read('/target', 'readme.txt');
    const plan = await operations.fsPrepareOperation({
      kind: 'copy',
      sources: [{ kind: 'session', session: 1, path: 'readme.txt' }],
      destination: { session: 2, path: '' },
    });
    expect(plan.items[0]?.conflict).toBe('file');
    const result = await operations.fsExecuteOperation(plan.id, [
      { itemId: '0', action: 'rename', name: 'renamed.txt' },
    ]);
    expect(result.items[0]?.destination).toBe('/target/renamed.txt');
    expect(fs.read('/target', 'readme.txt')).toEqual(before);
    expect(fs.kind('/source', 'readme.txt')).toBe('file');
  });

  it('병합 이동의 건너뛴 항목과 원본 폴더는 유지한다', async () => {
    const { fs, operations } = setup();
    fs.create('/source', 'folder', true);
    fs.create('/target', 'folder', true);
    fs.create('/source', 'folder/a.txt', false);
    fs.create('/source', 'folder/b.txt', false);
    fs.create('/target', 'folder/a.txt', false);
    const plan = await operations.fsPrepareOperation({
      kind: 'move',
      sources: [{ kind: 'session', session: 1, path: 'folder' }],
      destination: { session: 2, path: '' },
    });
    const result = await operations.fsExecuteOperation(plan.id, [
      { itemId: '0', action: 'merge', name: null },
      { itemId: '0/0', action: 'skip', name: null },
    ]);
    expect(result.items.map((item) => item.status)).toEqual(['skipped', 'committed']);
    expect(fs.kind('/source', 'folder/a.txt')).toBe('file');
    expect(fs.kind('/source', 'folder/b.txt')).toBeNull();
    expect(fs.kind('/target', 'folder/b.txt')).toBe('file');
  });

  it('취소한 준비 계획은 실행되지 않는다', async () => {
    const { operations, fs } = setup();
    const plan = await operations.fsPrepareOperation({
      kind: 'createFile',
      sources: [],
      destination: { session: 1, path: 'cancelled.txt' },
    });
    await operations.fsCancelOperation(plan.id);
    await expect(operations.fsExecuteOperation(plan.id, [])).rejects.toThrow();
    expect(fs.kind('/source', 'cancelled.txt')).toBeNull();
  });

  it('준비 시 보호된 경로를 거부한다', async () => {
    const { operations } = setup();
    await expect(
      operations.fsPrepareOperation({
        kind: 'createFile',
        sources: [],
        destination: { session: 1, path: '.git/config' },
      }),
    ).rejects.toThrow();
  });
});
