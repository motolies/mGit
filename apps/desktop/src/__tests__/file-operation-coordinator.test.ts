import {
  createNullClient,
  type FsEditableFile,
  type FsOperationPlan,
  type FsOperationResult,
} from '@mgit/ipc';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeFileOperation } from '../features/project/file-operation-coordinator';
import { fileEditors } from '../store/file-editor-store';
import { createWorkspaceStore, fileViewDoc } from '../store/workspace-store';

const sessions = vi.hoisted(() => vi.fn());
vi.mock('../store/session-registry', () => ({
  fileWorkspaceSessions: sessions,
  getSessionStore: () => undefined,
}));
afterEach(() => {
  for (const doc of fileEditors.documents())
    for (const source of [...doc.sources.values()])
      fileEditors.release(source.session, source.path);
});

/** 두 Project의 같은 실제 파일을 준비한다. */
function setup() {
  const a = createWorkspaceStore('repo');
  const b = createWorkspaceStore('folder');
  const state = () => ({
    selected: 'api/a.ts',
    anchor: 'api/a.ts',
    selection: { 'api/a.ts': true },
    expanded: { '': true, api: true },
    revealSeq: 0,
    reload: vi.fn(async () => {}),
  });
  const makeTree = () => {
    let value = state();
    return {
      getState: () => value,
      setState: (next: Partial<typeof value>) => {
        value = { ...value, ...next };
      },
    };
  };
  const projects = [
    {
      id: 1,
      root: '/w',
      repoPaths: ['/w/api'],
      workspace: a,
      tree: makeTree(),
      refresh: vi.fn(async () => {}),
    },
    {
      id: 2,
      root: '/w/api',
      repoPaths: ['/w/api'],
      workspace: b,
      tree: makeTree(),
      refresh: vi.fn(async () => {}),
    },
  ];
  sessions.mockReturnValue(projects);
  a.getState().openDoc(
    fileViewDoc({ path: 'api/a.ts', name: 'a.ts', repoPath: '/w/api', repoName: 'api' }),
    'pinned',
  );
  b.getState().openDoc(
    fileViewDoc({ path: 'a.ts', name: 'a.ts', repoPath: '/w/api', repoName: 'api' }),
    'pinned',
  );
  let moved = false;
  const client = {
    ...createNullClient(),
    fsReadEditableFile: vi.fn(
      async (_session: number, path: string): Promise<FsEditableFile> => ({
        kind: 'text',
        text: 'source',
        size: 6,
        fileKey: moved ? 'new' : path.endsWith('a.ts') ? 'old' : 'target',
        revision: '1',
        bom: false,
        lineEnding: 'lf',
      }),
    ),
    fsExecuteOperation: vi.fn(async (): Promise<FsOperationResult> => {
      moved = true;
      return {
        id: 'op',
        items: [
          {
            status: 'committed' as const,
            source: '/w/api/a.ts',
            destination: '/w/api/b.ts',
            directory: false,
            error: null,
          },
        ],
      };
    }),
  };
  const plan: FsOperationPlan = {
    id: 'op',
    kind: 'rename',
    items: [
      {
        id: '1',
        source: '/w/api/a.ts',
        destination: '/w/api/b.ts',
        conflict: 'none',
        sourceSize: null,
        destinationSize: null,
        sourceMtimeMs: null,
        destinationMtimeMs: null,
        directory: false,
        error: null,
      },
    ],
  };
  return { projects, a, b, client, plan };
}

describe('파일 작업의 공유 문서 반영', () => {
  it('두 Project의 경로와 별칭을 함께 바꾸며 기존 대상 문서도 같은 객체로 합친다', async () => {
    const { client, plan, a, b, projects } = setup();
    const source = await fileEditors.open(client, 1, 'api/a.ts');
    await fileEditors.open(client, 2, 'a.ts');
    const target = await fileEditors.open(client, 1, 'api/b.ts');
    expect(target).not.toBe(source);
    await executeFileOperation(client, plan, [], 1);
    expect(fileEditors.get(1, 'api/b.ts')).toBe(source);
    expect(fileEditors.get(2, 'b.ts')).toBe(source);
    expect(fileEditors.get(1, 'api/a.ts')).toBeUndefined();
    expect(a.getState().docs.map((doc) => doc.id)).toContain('file:api/b.ts');
    expect(b.getState().docs.map((doc) => doc.id)).toContain('file:b.ts');
    expect(projects[0]?.tree.getState().selected).toBe('api/b.ts');
  });
  it('파일 이동 후 편집 조회가 실패해도 성공한 탭 경로 갱신을 마친다', async () => {
    const { client, plan, a } = setup();
    await fileEditors.open(client, 1, 'api/a.ts');
    client.fsReadEditableFile.mockRejectedValueOnce(new Error('temporarily denied'));
    const result = await executeFileOperation(client, plan, [], 1);
    expect(result.items[0]?.status).toBe('committed');
    expect(a.getState().docs.map((doc) => doc.id)).toContain('file:api/b.ts');
    expect(fileEditors.get(1, 'api/a.ts')).toBeUndefined();
  });
});

describe('부분 게시와 대상 타입 변경', () => {
  it('원본 제거 실패 후에도 목적지의 실제 변경을 읽고 원본 탭은 유지한다', async () => {
    const { client, plan, a } = setup();
    await fileEditors.open(client, 1, 'api/a.ts');
    const target = await fileEditors.open(client, 1, 'api/b.ts');
    client.fsExecuteOperation.mockImplementationOnce(async () => {
      client.fsReadEditableFile.mockImplementation(async (_session, path) => ({
        kind: 'text',
        text: path.endsWith('b.ts') ? 'published copy' : 'source',
        size: 6,
        fileKey: path.endsWith('b.ts') ? 'target' : 'old',
        revision: path.endsWith('b.ts') ? '2' : '1',
        bom: false,
        lineEnding: 'lf',
      }));
      return {
        id: 'op',
        items: [
          {
            status: 'failed',
            source: '/w/api/a.ts',
            destination: '/w/api/b.ts',
            directory: false,
            error: 'copied, source retained',
          },
        ],
      };
    });
    await executeFileOperation(client, plan, [], 1);
    expect(a.getState().docs.map((doc) => doc.id)).toContain('file:api/a.ts');
    expect('state' in target && target.state.doc.toString()).toBe('published copy');
  });

  it('파일이 바이너리로 교체되면 텍스트 편집기 별칭을 해제한다', async () => {
    const { client, plan } = setup();
    await fileEditors.open(client, 1, 'api/b.ts');
    client.fsExecuteOperation.mockImplementationOnce(async () => {
      client.fsReadEditableFile.mockResolvedValue({ kind: 'binary', size: 12 });
      return {
        id: 'op',
        items: [
          {
            status: 'committed',
            source: '/external/blob',
            destination: '/w/api/b.ts',
            directory: false,
            error: null,
          },
        ],
      };
    });
    await executeFileOperation(client, { ...plan, kind: 'copy' }, [], 1);
    expect(fileEditors.get(1, 'api/b.ts')).toBeUndefined();
  });
});
