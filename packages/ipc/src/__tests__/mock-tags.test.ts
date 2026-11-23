import { afterEach, describe, expect, it } from 'vitest';
import { type IpcClient, toIpcError } from '../client';
import { createMockClient } from '../mock/mock-client';
import { mockTagNameError, repoTagData } from '../mock/mock-tags';
import type { SessionEvent, SessionId, TagRefResult } from '../types';

const ROWS = 400;

/** 실패 주입 손잡이 */
const g = globalThis as { __mgitMockTagFail?: unknown };

/** 저장소 장면을 열고 받은 이벤트를 모은다 */
async function openRepoScene(): Promise<{
  client: IpcClient;
  session: SessionId;
  events: SessionEvent[];
}> {
  const client = createMockClient({ rows: ROWS, scene: 'repo', progressIntervalMs: 0 });
  const [path] = await client.takeStartupPaths();
  const events: SessionEvent[] = [];
  const opened = await client.openRepo(path ?? '', (e) => events.push(e));
  events.length = 0;
  return { client, session: opened.session, events };
}

/** 이름별 상태 */
function statuses(results: readonly TagRefResult[]): Record<string, string> {
  return Object.fromEntries(results.map((r) => [r.name, r.status]));
}

/** 세션의 지금 tag 이름 */
async function localTags(client: IpcClient, session: SessionId): Promise<string[]> {
  const state = await client.repoState(session);
  return state.refs.labels.filter((l) => l.kind.kind === 'tag').map((l) => l.shortName);
}

afterEach(() => {
  delete g.__mgitMockTagFail;
});

describe('repoTagData', () => {
  it('origin 에 상태 다섯 가지, upstream 에 같음·없음·원격에만이 있다', () => {
    const oidAt = (row: number) => row.toString(16).padStart(40, '0');
    const data = repoTagData(
      [
        ['v2.4.0', 45, true],
        ['v2.3.1', 96, true],
        ['v2.3.0', 140, false],
        ['v2.2.0', 310, true],
      ],
      oidAt,
      42,
    );
    const origin = Object.fromEntries((data.remotes.origin ?? []).map((t) => [t.name, t]));
    // 로컬에만
    expect(origin['v2.4.0']).toBeUndefined();
    // 다른 commit
    expect(origin['v2.3.1']?.peeled).toBe(oidAt(97));
    expect(origin['v2.3.1']?.object).not.toBe(data.local['v2.3.1']);
    // 같음 (경량)
    expect(origin['v2.3.0']?.object).toBe(data.local['v2.3.0']);
    // 같은 commit 다른 객체: 원격은 경량, 로컬은 annotated
    expect(origin['v2.2.0']).toEqual({ name: 'v2.2.0', object: oidAt(310), peeled: null });
    expect(data.local['v2.2.0']).not.toBe(oidAt(310));
    // 원격에만 둘
    expect(Object.keys(origin).filter((n) => data.local[n] === undefined)).toEqual([
      'v2.5.0-rc.1',
      'v1.9.0',
    ]);
    expect((data.remotes.upstream ?? []).map((t) => t.name)).toEqual([
      'v2.3.0',
      'v2.2.0',
      'v3.0.0-alpha.1',
    ]);
  });
});

describe('mockTagNameError', () => {
  it('코어 check_tag_name 처럼 refspec 을 깨는 이름을 거부한다', () => {
    for (const ok of ['v1.0', 'release/2024-01', 'v1+build']) {
      expect(mockTagNameError(ok)).toBeNull();
    }
    for (const bad of [
      '',
      '-v',
      'a..b',
      'a b',
      'v1:main',
      'v*',
      'v?',
      'v[1]',
      'v^{}',
      'v~1',
      'a@{0',
      '/v',
      'v/',
    ]) {
      expect(mockTagNameError(bad)).not.toBeNull();
    }
  });
});

describe('목 tag push', () => {
  it('로컬에만은 올리고, 같으면 upToDate, 원격이 다르면 이름 충돌. 원격 표가 바뀐다', async () => {
    const { client, session, events } = await openRepoScene();
    const results = await client.pushTags(session, 'origin', ['v2.4.0', 'v2.3.0', 'v2.3.1']);
    expect(results.map((r) => r.name)).toEqual(['v2.4.0', 'v2.3.0', 'v2.3.1']);
    expect(statuses(results)).toEqual({
      'v2.4.0': 'pushed',
      'v2.3.0': 'upToDate',
      'v2.3.1': 'rejectedExists',
    });
    expect(results[2]?.message).toBe('already exists');
    // 다시 보내면 이제 같다
    const again = await client.pushTags(session, 'origin', ['v2.4.0']);
    expect(statuses(again)).toEqual({ 'v2.4.0': 'upToDate' });
    // op 시작·끝이 한 쌍이고, 일부 실패면 ok 가 아니다
    const ops = events.filter(
      (e) => e.type === 'operationStarted' || e.type === 'operationFinished',
    );
    expect(ops[0]).toMatchObject({
      type: 'operationStarted',
      kind: 'push',
      label: 'push origin v2.4.0 v2.3.0 v2.3.1',
    });
    expect(ops[1]).toMatchObject({ type: 'operationFinished', ok: false, cancelled: false });
    expect(ops[3]).toMatchObject({ type: 'operationFinished', ok: true, message: '' });
    expect(events.some((e) => e.type === 'commandLogged')).toBe(true);
  });

  it('등록되지 않은 원격·잘못된 이름은 op 를 닫고 거부한다', async () => {
    const { client, session, events } = await openRepoScene();
    await expect(client.pushTags(session, 'nope', ['v2.4.0'])).rejects.toSatisfy(
      (e) => toIpcError(e).kind === 'internal',
    );
    await expect(client.pushTags(session, 'origin', ['v*'])).rejects.toBeDefined();
    const finished = events.filter((e) => e.type === 'operationFinished');
    expect(finished).toHaveLength(2);
    expect(finished.every((e) => e.type === 'operationFinished' && !e.ok)).toBe(true);
  });

  it('실패 주입: 이름 충돌과 인증 실패', async () => {
    const { client, session } = await openRepoScene();
    g.__mgitMockTagFail = { pushExists: ['v2.4.0'] };
    expect(statuses(await client.pushTags(session, 'origin', ['v2.4.0']))).toEqual({
      'v2.4.0': 'rejectedExists',
    });
    g.__mgitMockTagFail = { auth: ['upstream'] };
    const err = await client.pushTags(session, 'upstream', ['v2.4.0']).catch(toIpcError);
    expect(err).toMatchObject({ kind: 'gitFailed', hint: { kind: 'authFailed' } });
    // origin 은 영향 없다
    expect(statuses(await client.pushTags(session, 'origin', ['v2.4.0']))).toEqual({
      'v2.4.0': 'pushed',
    });
  });
});

describe('목 원격 tag 삭제', () => {
  it('diverged 가 섞이면 아무것도 지우지 않고(notRun), 빼거나 expectedRemote 를 채워 다시 부르면 지운다', async () => {
    const { client, session } = await openRepoScene();
    const items = ['v2.3.0', 'v2.2.0', 'v1.9.0', 'v2.4.0'].map((name) => ({ name }));
    const before = await client.lookupRemoteTags(session, 'origin', ['v2.3.0', 'v2.2.0', 'v1.9.0']);
    const results = await client.deleteRemoteTags(session, 'origin', items);
    expect(statuses(results)).toEqual({
      'v2.3.0': 'notRun',
      'v2.2.0': 'diverged',
      'v1.9.0': 'notRun',
      'v2.4.0': 'notRun',
    });
    // 확인 전에는 원격 표가 하나도 바뀌지 않는다
    expect(
      await client.lookupRemoteTags(session, 'origin', ['v2.3.0', 'v2.2.0', 'v1.9.0']),
    ).toEqual(before);
    const diverged = results.find((r) => r.name === 'v2.2.0');
    // 같은 commit 다른 객체: 원격 객체가 곧 commit 이다
    expect(diverged?.remoteCommit).toBe(diverged?.remoteOid);

    // [다른 tag 는 건너뛰고 삭제]: diverged 를 빼면 나머지만 (원격에만 있는 tag 는 비교 없이)
    const skip = await client.deleteRemoteTags(
      session,
      'origin',
      items.filter((i) => i.name !== 'v2.2.0'),
    );
    expect(statuses(skip)).toEqual({
      'v2.3.0': 'deleted',
      'v1.9.0': 'deleted',
      'v2.4.0': 'alreadyAbsent',
    });
    // [그래도 원격에서 삭제]: expectedRemote 를 채우면 지운다. 기대값이 지금과 다르면 rejectedStale
    const stale = await client.deleteRemoteTags(session, 'origin', [
      { name: 'v2.2.0', expectedRemote: '0'.repeat(40) },
    ]);
    expect(stale[0]?.status).toBe('rejectedStale');
    const retry = await client.deleteRemoteTags(session, 'origin', [
      { name: 'v2.2.0', expectedRemote: diverged?.remoteOid ?? null },
    ]);
    expect(statuses(retry)).toEqual({ 'v2.2.0': 'deleted' });
    // 지운 것은 다시 지우면 alreadyAbsent
    expect(
      statuses(await client.deleteRemoteTags(session, 'origin', [{ name: 'v2.3.0' }])),
    ).toEqual({
      'v2.3.0': 'alreadyAbsent',
    });
    // 원격 삭제는 로컬 tag 를 건드리지 않는다
    expect(await localTags(client, session)).toContain('v2.3.0');
  });

  it('실패 주입: 한 원격의 서버 거부, 강제 diverged', async () => {
    const { client, session } = await openRepoScene();
    g.__mgitMockTagFail = { deleteRemote: ['upstream'], diverged: ['v2.3.0'] };
    const up = await client.deleteRemoteTags(session, 'upstream', [{ name: 'v2.2.0' }]);
    expect(up[0]).toMatchObject({ status: 'rejectedRemote', message: 'pre-receive hook declined' });
    // 주입된 diverged 가 섞이면 나머지(원격에만 있는 v1.9.0)도 notRun 이고 원격 표가 그대로다
    const mixed = await client.deleteRemoteTags(session, 'origin', [
      { name: 'v2.3.0' },
      { name: 'v1.9.0' },
    ]);
    expect(statuses(mixed)).toEqual({ 'v2.3.0': 'diverged', 'v1.9.0': 'notRun' });
    expect(await client.lookupRemoteTags(session, 'origin', ['v1.9.0'])).toHaveLength(1);
    const origin = await client.deleteRemoteTags(session, 'origin', [{ name: 'v2.3.0' }]);
    expect(origin[0]?.status).toBe('diverged');
    const retry = await client.deleteRemoteTags(session, 'origin', [
      { name: 'v2.3.0', expectedRemote: origin[0]?.remoteOid ?? null },
    ]);
    expect(retry[0]?.status).toBe('deleted');
  });
});

describe('목 로컬 tag 삭제', () => {
  it('라벨에서 빼고 refsChanged·graphReloaded 를 보낸다. 없는 이름이 섞이면 아무것도 지우지 않는다', async () => {
    const { client, session, events } = await openRepoScene();
    await expect(client.deleteLocalTags(session, ['v2.3.0', 'nope'])).rejects.toSatisfy(
      (e) => toIpcError(e).kind === 'internal',
    );
    expect(await localTags(client, session)).toEqual(['v2.4.0', 'v2.3.1', 'v2.3.0', 'v2.2.0']);

    await client.deleteLocalTags(session, ['v2.3.0', 'v2.2.0']);
    expect(await localTags(client, session)).toEqual(['v2.4.0', 'v2.3.1']);
    const refs = events.find((e) => e.type === 'refsChanged');
    expect(
      refs?.type === 'refsChanged' && refs.refs.labels.some((l) => l.shortName === 'v2.3.0'),
    ).toBe(false);
    expect(events.some((e) => e.type === 'graphReloaded')).toBe(true);
    const window = await client.graphWindow(session, 0, ROWS);
    expect(window.rows.flatMap((r) => r.refs.map((l) => l.shortName))).not.toContain('v2.3.0');
    // 로컬에서 지운 tag 는 원격 삭제에서 비교 없이 지운다 (원격에만 있는 tag 가 됐다)
    const results = await client.deleteRemoteTags(session, 'origin', [{ name: 'v2.3.0' }]);
    expect(results[0]?.status).toBe('deleted');
  });
});

describe('목 원격 tag 상태 (B3)', () => {
  it('확인 전에는 비어 있고, 확인하면 상태 다섯 가지를 센다', async () => {
    const { client, session, events } = await openRepoScene();
    const before = await client.remoteTags(session, 'origin', false);
    expect(before).toMatchObject({ remote: 'origin', checkedAt: null, entries: [] });
    expect(events.some((e) => e.type === 'operationStarted')).toBe(false);

    const r = await client.remoteTags(session, null, true);
    expect(r.remote).toBe('origin');
    expect(r.checkedAt).not.toBeNull();
    expect(r.counts).toEqual({ localOnly: 1, remoteOnly: 2, same: 1, diverged: 2, unknown: 0 });
    expect(r.entries.map((e) => e.name)).toEqual([
      'v1.9.0',
      'v2.2.0',
      'v2.3.1',
      'v2.4.0',
      'v2.5.0-rc.1',
    ]);
    const state = (n: string) => r.entries.find((e) => e.name === n)?.state;
    expect(state('v2.2.0')).toEqual({ kind: 'diverged', sameCommit: true });
    expect(state('v2.3.1')).toEqual({ kind: 'diverged', sameCommit: false });
    expect(state('v2.4.0')).toEqual({ kind: 'localOnly' });
    expect(state('v1.9.0')).toEqual({ kind: 'remoteOnly' });
    const started = events.find((e) => e.type === 'operationStarted');
    expect(started).toMatchObject({ kind: 'tagCheck', label: 'ls-remote --tags origin' });
    expect(events.some((e) => e.type === 'operationFinished' && e.ok)).toBe(true);

    const up = await client.remoteTags(session, 'upstream', true);
    expect(up.counts).toEqual({ localOnly: 2, remoteOnly: 1, same: 2, diverged: 0, unknown: 0 });
  });

  it('push·삭제 뒤에는 다시 확인하지 않아도 보고서가 바뀐다', async () => {
    const { client, session } = await openRepoScene();
    await client.remoteTags(session, 'origin', true);
    await client.pushTags(session, 'origin', ['v2.4.0']);
    await client.deleteRemoteTags(session, 'origin', [{ name: 'v1.9.0' }]);
    const r = await client.remoteTags(session, 'origin', false);
    expect(r.counts).toEqual({ localOnly: 0, remoteOnly: 1, same: 2, diverged: 2, unknown: 0 });
  });

  it('조회 실패 주입: 이전 값을 두고 lastError, 단일 조회와 원격 삭제는 거부. 오래됨 주입', async () => {
    const { client, session } = await openRepoScene();
    const good = await client.remoteTags(session, 'upstream', true);
    g.__mgitMockTagFail = { lookup: ['upstream'], stale: ['origin'] };
    const offline = await client.remoteTags(session, 'upstream', true);
    expect(offline.lastError?.kind).toBe('network');
    expect(offline.checkedAt).toBe(good.checkedAt);
    expect(offline.counts).toEqual(good.counts);
    await expect(client.lookupRemoteTags(session, 'upstream', ['v2.3.0'])).rejects.toSatisfy(
      (e) => toIpcError(e).kind === 'gitFailed',
    );
    await expect(
      client.deleteRemoteTags(session, 'upstream', [{ name: 'v2.3.0' }]),
    ).rejects.toSatisfy((e) => toIpcError(e).kind === 'gitFailed');
    expect((await client.remoteTags(session, 'origin', true)).stale).toBe(true);
    // 처음 확인이 실패면 checkedAt 없이 오류만
    g.__mgitMockTagFail = { auth: true };
    const fresh = await openRepoScene();
    const never = await fresh.client.remoteTags(fresh.session, 'origin', true);
    expect(never.checkedAt).toBeNull();
    expect(never.lastError?.kind).toBe('auth');
    delete g.__mgitMockTagFail;
    expect((await client.remoteTags(session, 'upstream', true)).lastError).toBeNull();
  });

  it('단일 조회는 원격에 있는 것만 요청 순서대로 준다', async () => {
    const { client, session } = await openRepoScene();
    const found = await client.lookupRemoteTags(session, 'origin', ['v2.4.0', 'v2.2.0', 'v2.3.1']);
    expect(found.map((t) => t.name)).toEqual(['v2.2.0', 'v2.3.1']);
    expect(found[0]?.peeled).toBeNull();
    expect(found[1]?.peeled).not.toBeNull();
  });

  it('합성 tag (tags=N) 가 라벨과 원격 표에 고르게 섞인다', async () => {
    const client = createMockClient({
      rows: ROWS,
      scene: 'repo',
      progressIntervalMs: 0,
      tags: 1_000,
    });
    const [path] = await client.takeStartupPaths();
    const { session } = await client.openRepo(path ?? '', () => {});
    expect(await localTags(client, session)).toHaveLength(1_004);
    const r = await client.remoteTags(session, 'origin', true);
    expect(r.counts).toEqual({
      localOnly: 1 + 200,
      remoteOnly: 2 + 100,
      same: 1 + 400,
      diverged: 2 + 400,
      unknown: 0,
    });
  });
});

describe('목 tag 가져오기·목록 (C2)', () => {
  it('원격에만 있는 tag 를 받아 라벨·그래프·목록에 넣고, 같으면 upToDate, 다르면 덮어쓰기 전까지 거부', async () => {
    const { client, session, events } = await openRepoScene();
    const results = await client.fetchTags(session, 'origin', ['v2.5.0-rc.1', 'v2.3.0'], false);
    expect(statuses(results)).toEqual({ 'v2.5.0-rc.1': 'fetched', 'v2.3.0': 'upToDate' });
    expect(results[0]?.remoteCommit).not.toBe(results[0]?.remoteOid);
    expect(await localTags(client, session)).toContain('v2.5.0-rc.1');
    expect(events.some((e) => e.type === 'refsChanged')).toBe(true);
    const started = events.find((e) => e.type === 'operationStarted');
    expect(started).toMatchObject({
      kind: 'fetch',
      label: 'fetch origin v2.5.0-rc.1 v2.3.0',
    });
    const window = await client.graphWindow(session, 0, ROWS);
    expect(window.rows.flatMap((r) => r.refs.map((l) => l.shortName))).toContain('v2.5.0-rc.1');

    // 다른 v2.3.1 은 덮어쓰기 전까지 거부되고 원격 객체를 알려 준다
    const clash = await client.fetchTags(session, 'origin', ['v2.3.1'], false);
    expect(clash[0]).toMatchObject({
      status: 'rejectedExists',
      message: 'would clobber existing tag',
    });
    expect(clash[0]?.remoteOid).not.toBeNull();
    const forced = await client.fetchTags(session, 'origin', ['v2.3.1'], true);
    expect(forced[0]?.status).toBe('fetched');
    // 받은 뒤에는 원격과 같다
    await client.remoteTags(session, 'origin', true);
    const report = await client.remoteTags(session, 'origin', false);
    expect(report.entries.find((e) => e.name === 'v2.3.1')).toBeUndefined();
  });

  it('원격에 없는 이름이 섞이면 전체가 멈추고, 연결 실패 주입이면 거부한다', async () => {
    const { client, session, events } = await openRepoScene();
    const err = await client
      .fetchTags(session, 'origin', ['v1.9.0', 'missing'], false)
      .catch(toIpcError);
    expect(err).toMatchObject({ kind: 'gitFailed' });
    expect(await localTags(client, session)).not.toContain('v1.9.0');
    expect(events.filter((e) => e.type === 'operationFinished')).toHaveLength(1);
    g.__mgitMockTagFail = { lookup: true };
    await expect(client.fetchTags(session, 'origin', ['v1.9.0'], false)).rejects.toSatisfy(
      (e) => toIpcError(e).kind === 'gitFailed',
    );
  });

  it('tag 목록은 종류·날짜·commit 제목·tag 제목·tagger 를 준다', async () => {
    const { client, session } = await openRepoScene();
    const list = await client.tagList(session);
    expect(list.map((t) => t.name)).toEqual(['v2.2.0', 'v2.3.0', 'v2.3.1', 'v2.4.0']);
    const annotated = list.find((t) => t.name === 'v2.4.0');
    expect(annotated).toMatchObject({ annotated: true, tagSubject: 'Release v2.4.0' });
    expect(annotated?.object).not.toBe(annotated?.commit);
    expect(annotated?.tagger).toMatch(/<.+>/);
    expect(annotated?.date).not.toBeNull();
    expect(annotated?.commitSubject).not.toBe('');
    const light = list.find((t) => t.name === 'v2.3.0');
    expect(light).toMatchObject({ annotated: false, tagSubject: null, tagger: null });
    expect(light?.object).toBe(light?.commit);
  });
});

describe('목 로컬 것으로 덮어쓰기 (C2b)', () => {
  it('기대값이 맞으면 덮어쓰고, 다르면 rejectedStale 로 원격 그대로', async () => {
    const { client, session, events } = await openRepoScene();
    const [remote] = await client.lookupRemoteTags(session, 'origin', ['v2.3.1']);
    const stale = await client.replaceRemoteTags(session, 'origin', [
      { name: 'v2.3.1', expectedRemote: '0'.repeat(40) },
    ]);
    expect(stale[0]?.status).toBe('rejectedStale');
    expect(await client.lookupRemoteTags(session, 'origin', ['v2.3.1'])).toEqual([remote]);

    const r = await client.replaceRemoteTags(session, 'origin', [
      { name: 'v2.3.1', expectedRemote: remote?.object ?? '' },
    ]);
    expect(r[0]?.status).toBe('pushed');
    const started = events.filter((e) => e.type === 'operationStarted');
    expect(started.at(-1)).toMatchObject({
      kind: 'push',
      label: 'push origin --force-with-lease v2.3.1',
    });
    // 덮어쓴 뒤에는 원격과 같다
    await client.remoteTags(session, 'origin', true);
    const report = await client.remoteTags(session, 'origin', false);
    expect(report.entries.find((e) => e.name === 'v2.3.1')).toBeUndefined();
    // 다시 하면 이미 같다
    const [now] = await client.lookupRemoteTags(session, 'origin', ['v2.3.1']);
    const again = await client.replaceRemoteTags(session, 'origin', [
      { name: 'v2.3.1', expectedRemote: now?.object ?? '' },
    ]);
    expect(again[0]?.status).toBe('upToDate');
  });
});
