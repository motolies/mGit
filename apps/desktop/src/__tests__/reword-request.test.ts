import { createMockClient, GraphRangeCache } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../store/app-store-instance';
import { createFolderStore } from '../store/folder-store';
import { sessionBusy, sessionHasWork } from '../store/repo-sessions';
import {
  finishRewordRequest,
  requestRepoReword,
  saveRewordRequest,
  useRewordRequest,
} from '../store/reword-request';
import { clearSessionRegistry, registerFolder, registerSession } from '../store/session-registry';
import { createSessionStore } from '../store/session-store';

const original = useAppStore.getState();
const FOLDER = -1;
const PATH = '/repo';
const OID = 'a'.repeat(40);

/** 그래프가 없는 숨은 세션을 준비하되 이미 열린 탭이 있는 상태도 보존한다. */
async function setup() {
  const client = createMockClient({ rows: 10 });
  const opened = await client.openRepo(PATH, () => {});
  const id = opened.session;
  const cache = new GraphRangeCache({
    fetchWindow: vi.fn(async () => {
      throw new Error('graph must not be used');
    }),
  });
  client.commitContainingRefs = vi.fn(async () => ({ timedOut: false, head: true, branches: [] }));
  client.commitMessage = vi.fn(async () => 'subject\n\nbody');
  client.rewordCommit = vi.fn(async () => 'clean' as const);
  const store = createSessionStore(opened, client, cache, { profile: 'light' });
  store.setState({ selectedCommit: 'unchanged', diff: null, range: null });
  registerSession(id, { store, cache });
  const folder = createFolderStore(
    { session: FOLDER, path: '/folder', repos: [{ path: PATH, kind: 'standalone' }] },
    client,
  );
  folder.setState({ refresh: vi.fn(async () => {}), reloadTimeline: vi.fn(async () => {}) });
  registerFolder(FOLDER, folder);
  const open = vi.fn();
  const withRepoSession = vi.fn(async (_folder, _path, run) => {
    run(store.getState());
    return true;
  });
  const notice = vi.fn();
  useAppStore.setState({
    activeSessionId: FOLDER,
    sessions: {
      [FOLDER]: { id: FOLDER, kind: 'folder', path: '/folder', name: 'folder', parent: null },
      [id]: { id, kind: 'repo', path: PATH, name: 'repo', parent: FOLDER },
    },
    openRepositoryAt: open,
    withRepoSession,
    notice,
  });
  return { id, store, folder, client, open, withRepoSession, notice };
}

/** 준비된 요청이 없는 픽스처는 즉시 실패시킨다. */
function currentRequest() {
  const request = useRewordRequest.getState().request;
  if (!request) throw new Error('missing reword request');
  return request;
}

afterEach(() => {
  const request = useRewordRequest.getState().request;
  if (request) finishRewordRequest(request);
  useAppStore.setState({ activeSessionId: null });
  useAppStore.setState(original);
  clearSessionRegistry();
});

describe('폴더 안 커밋 메시지 수정', () => {
  it('숨은 세션에서 전체 메시지를 읽고 기존 탭·커밋 선택을 그대로 둔다', async () => {
    const { store, open, withRepoSession } = await setup();
    await requestRepoReword(FOLDER, PATH, OID);
    expect(withRepoSession).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
    expect(useAppStore.getState().activeSessionId).toBe(FOLDER);
    expect(store.getState().selectedCommit).toBe('unchanged');
    expect(store.getState().rewordEditor).toMatchObject({
      oid: OID,
      message: 'subject\n\nbody',
      phase: 'editing',
    });
    expect(sessionBusy(store.getState())).toBe(true);
    expect(sessionHasWork(store.getState())).toBe(true);
  });

  it('메시지 로딩 중 반복 요청은 합치고 폴더를 떠나면 늦은 응답을 버린다', async () => {
    const { store, client, withRepoSession } = await setup();
    let resolve!: (value: string) => void;
    client.commitMessage = vi.fn(
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    const first = requestRepoReword(FOLDER, PATH, OID);
    await vi.waitFor(() => expect(client.commitMessage).toHaveBeenCalled());
    await requestRepoReword(FOLDER, PATH, OID);
    useAppStore.setState({ activeSessionId: null });
    resolve('late');
    await first;
    expect(withRepoSession).toHaveBeenCalledOnce();
    expect(useRewordRequest.getState().request).toBeNull();
    expect(store.getState().rewordEditor).toBeNull();
  });

  it('실패 사유와 수정한 본문을 남기고 중복 저장을 막는다', async () => {
    const { store, client } = await setup();
    await requestRepoReword(FOLDER, PATH, OID);
    const request = currentRequest();
    store.getState().patchRewordEditor(request.token, { message: 'new subject\n\nfull body' });
    let reject!: (reason: Error) => void;
    client.rewordCommit = vi.fn(
      () =>
        new Promise<'clean' | 'conflicts'>((_, fail) => {
          reject = fail;
        }),
    );
    const first = saveRewordRequest(request);
    await vi.waitFor(() => expect(client.rewordCommit).toHaveBeenCalled());
    await saveRewordRequest(request);
    expect(client.rewordCommit).toHaveBeenCalledTimes(1);
    reject(new Error('hook failed'));
    await first;
    expect(store.getState().rewordEditor).toMatchObject({
      message: 'new subject\n\nfull body',
      phase: 'editing',
    });
    expect(store.getState().rewordEditor?.error).toContain('hook failed');
  });

  it.each(['clean', 'conflicts'] as const)(
    '%s 결과는 필터를 유지해 갱신하고 이전 선택만 비운다',
    async (outcome) => {
      const { store, folder, client } = await setup();
      folder.setState({
        timeline: {
          ...folder.getState().timeline,
          opened: true,
          selected: { repoPath: PATH, oid: OID },
        },
      });
      const query = folder.getState().timeline.query;
      client.rewordCommit = vi.fn(async () => outcome);
      await requestRepoReword(FOLDER, PATH, OID);
      await saveRewordRequest(currentRequest());
      expect(store.getState().lastOutcome).toBe(outcome);
      expect(folder.getState().timeline.selected).toBeNull();
      expect(folder.getState().timeline.query).toBe(query);
      expect(folder.getState().reloadTimeline).toHaveBeenCalledOnce();
      expect(store.getState().rewordEditor).toBeNull();
    },
  );

  it('확인 중 HEAD가 바뀌면 저장을 거부하고 초안을 보존한다', async () => {
    const { store, client } = await setup();
    await requestRepoReword(FOLDER, PATH, OID);
    const request = currentRequest();
    const head = store.getState().refs.head;
    if (head.state !== 'attached') throw new Error('fixture');
    store.setState({ refs: { ...store.getState().refs, head: { ...head, oid: 'b'.repeat(40) } } });
    await saveRewordRequest(request);
    expect(client.rewordCommit).not.toHaveBeenCalled();
    expect(store.getState().rewordEditor?.error).toBe(S.shortcuts.rewordChanged);
  });

  it('저장 중 이동 후 실패한 초안은 돌아왔을 때까지 보존하고 알린다', async () => {
    const { id, store, client, notice } = await setup();
    await requestRepoReword(FOLDER, PATH, OID);
    const request = currentRequest();
    let reject!: (reason: Error) => void;
    client.rewordCommit = vi.fn(
      () =>
        new Promise<'clean' | 'conflicts'>((_, fail) => {
          reject = fail;
        }),
    );
    const saving = saveRewordRequest(request);
    await vi.waitFor(() => expect(client.rewordCommit).toHaveBeenCalled());
    useAppStore.setState({ activeSessionId: id });
    reject(new Error('failed after switching'));
    await saving;
    expect(store.getState().rewordEditor?.phase).toBe('editing');
    expect(useRewordRequest.getState().request).toBe(request);
    expect(notice).toHaveBeenCalled();
    useAppStore.setState({ activeSessionId: FOLDER });
    expect(useRewordRequest.getState().request).toBe(request);
  });

  it('새로고침 실패도 저장 완료된 세션 예약을 남기지 않는다', async () => {
    const { store, folder } = await setup();
    folder.setState({
      refresh: vi.fn(async () => {
        throw new Error('refresh failed');
      }),
    });
    await requestRepoReword(FOLDER, PATH, OID);
    await saveRewordRequest(currentRequest());
    expect(store.getState().rewordEditor).toBeNull();
    expect(useRewordRequest.getState().request).toBeNull();
  });
});
