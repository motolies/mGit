// B5: 원격 tag 보고서 → 화면 모양 (`features/tags/tag-sync.ts`, TG-09) 과 브랜치 칸 tag 행·묶음 요약

import type { RefLabel, TagSyncEntry, TagSyncReport, TagSyncState } from '@mgit/ipc';
import { formatTime, S } from '@mgit/ui';
import { describe, expect, it } from 'vitest';
import { buildRepoBranchTree, REPO_GROUP_IDS } from '../features/branches/repo-branch-tree';
import {
  localTagSync,
  localTagSyncLines,
  tagGroupSummary,
  tagGroupSync,
  tagStateOn,
  tagStateText,
} from '../features/tags/tag-sync';

const OID = 'a'.repeat(40);

/** 항목 하나 */
const entry = (name: string, state: TagSyncState): TagSyncEntry => ({
  name,
  state,
  localObject: null,
  localCommit: null,
  remoteObject: null,
  remoteCommit: null,
});

/** 보고서 하나 (기본: 확인함, 같음뿐) */
const rep = (remote: string, over: Partial<TagSyncReport> = {}): TagSyncReport => ({
  remote,
  checkedAt: Date.UTC(2026, 10, 23, 5, 2),
  stale: false,
  lastError: null,
  counts: { localOnly: 0, remoteOnly: 0, same: 0, diverged: 0, unknown: 0 },
  entries: [],
  pushUrlDiffers: false,
  ...over,
});

/** 목 장면과 같은 모양: origin 은 v2.4.0 push 안 됨·v2.3.1 다름·v2.2.0 같은 commit 다름·원격에만 2개, upstream 은 확인 안 함 */
const origin = rep('origin', {
  entries: [
    entry('v1.9.0', { kind: 'remoteOnly' }),
    entry('v2.2.0', { kind: 'diverged', sameCommit: true }),
    entry('v2.3.1', { kind: 'diverged', sameCommit: false }),
    entry('v2.4.0', { kind: 'localOnly' }),
    entry('v2.5.0-rc.1', { kind: 'remoteOnly' }),
  ],
});
const NAMES = ['v2.4.0', 'v2.3.1', 'v2.3.0', 'v2.2.0'];

describe('원격 하나에서의 상태', () => {
  it('확인 전이면 null, 항목이 없으면 같음, 있으면 그 상태', () => {
    expect(tagStateOn(undefined, 'v1')).toBeNull();
    expect(tagStateOn(rep('origin', { checkedAt: null }), 'v1')).toBeNull();
    expect(tagStateOn(origin, 'v2.3.0')).toEqual({ kind: 'same' });
    expect(tagStateOn(origin, 'v2.4.0')).toEqual({ kind: 'localOnly' });
    expect(tagStateText(tagStateOn(origin, 'v2.2.0'))).toBe(S.tag.state.divergedSameCommit);
    expect(tagStateText(null)).toBe(S.tag.state.notChecked);
  });
});

describe('트리 행 (TG-09 ①, D18 원격들을 합친다)', () => {
  it('확인한 원격이 없으면 아무것도 없다', () => {
    expect(localTagSync({}, ['origin'], 'v1')).toBeNull();
    expect(localTagSyncLines({}, ['origin'], 'v1')).toBeNull();
  });

  it('확인한 모든 원격에 없으면 push 안 됨, 하나라도 다르면 다름. 툴팁은 원격 목록 순서로 확인 안 한 원격까지', () => {
    const reports = { origin };
    // 표시 판정에는 문자열이 없다 (행마다 부른다). 툴팁 줄은 따로 필요할 때 만든다
    expect(localTagSync(reports, ['origin', 'upstream'], 'v2.4.0')).toEqual({
      unpushed: true,
      differs: false,
    });
    expect(localTagSyncLines(reports, ['origin', 'upstream'], 'v2.4.0')).toEqual([
      S.tag.state.line('origin', S.tag.state.localOnly),
      S.tag.state.line('upstream', S.tag.state.notChecked),
    ]);
    expect(localTagSync(reports, ['origin'], 'v2.3.1')).toMatchObject({
      unpushed: false,
      differs: true,
    });
    // 다른 원격에 있으면 push 안 됨이 아니다
    const both = { origin, upstream: rep('upstream') };
    expect(localTagSync(both, ['origin', 'upstream'], 'v2.4.0')?.unpushed).toBe(false);
  });
});

describe('묶음 머리 요약 (TG-09 ②)', () => {
  it('개수는 0 인 것을 빼고 `push 안 됨 · 원격에만 · 다름 · 시각`, 모두 0 이면 원격과 같음', () => {
    const sync = tagGroupSync({ origin }, ['origin', 'upstream'], NAMES);
    expect(sync).toMatchObject({
      unpushed: 1,
      remoteOnly: 2,
      differs: 2,
      stale: false,
      failures: [],
    });
    const time = formatTime(origin.checkedAt ?? 0);
    expect(tagGroupSummary(sync, false)).toBe(
      [
        S.tag.tree.summaryUnpushed(1),
        S.tag.tree.summaryRemoteOnly(2),
        S.tag.tree.summaryDiffers(2),
        time,
      ].join(' · '),
    );
    const same = tagGroupSync({ origin: rep('origin') }, ['origin'], NAMES);
    expect(tagGroupSummary(same, false)).toBe(`${S.tag.tree.summarySame} · ${time}`);
  });

  it('확인 전이면 비어 있고, 확인 중이면 앞에 표시. 오래됨·실패 종류를 뒤에 붙인다. 원격끼리 겹친 원격에만은 한 번', () => {
    expect(tagGroupSync({}, ['origin'], NAMES)).toBeNull();
    expect(tagGroupSummary(null, false)).toBe('');
    expect(tagGroupSummary(null, true)).toBe(S.tag.tree.checking);
    const failedOnly = tagGroupSync(
      {
        origin: rep('origin', {
          checkedAt: null,
          lastError: { kind: 'auth', at: 1, message: 'x' },
        }),
      },
      ['origin'],
      NAMES,
    );
    expect(tagGroupSummary(failedOnly, false)).toBe(S.tag.check.failed.auth);
    const upstream = rep('upstream', {
      checkedAt: 0,
      stale: true,
      entries: [entry('v1.9.0', { kind: 'remoteOnly' })],
      lastError: { kind: 'network', at: 2, message: 'y' },
    });
    const sync = tagGroupSync({ origin, upstream }, ['origin', 'upstream'], NAMES);
    expect(sync).toMatchObject({ remoteOnly: 2, checkedAt: 0, stale: true, failures: ['network'] });
    expect(tagGroupSummary(sync, true).split(' · ')).toEqual([
      S.tag.tree.checking,
      S.tag.tree.summaryRemoteOnly(2),
      S.tag.tree.summaryDiffers(2),
      formatTime(0),
      S.tag.tree.stale,
      S.tag.check.failed.network,
    ]);
  });
});

describe('브랜치 칸 tag 행과 묶음 (buildRepoBranchTree)', () => {
  const tag = (name: string): RefLabel =>
    ({
      fullName: `refs/tags/${name}`,
      shortName: name,
      kind: { kind: 'tag', annotated: true },
      target: OID,
      isCurrent: false,
      upstreamGone: false,
    }) as RefLabel;
  const build = (tagReports: Record<string, TagSyncReport>, tagChecking = false) =>
    buildRepoBranchTree({
      labels: NAMES.map(tag),
      head: { state: 'attached', branch: 'main', oid: OID },
      worktrees: [],
      backups: [],
      radar: [],
      path: '/r',
      tagReports,
      remoteNames: ['origin', 'upstream'],
      tagChecking,
      isFavorite: () => false,
    });
  const tagsGroup = (nodes: ReturnType<typeof build>) =>
    nodes.find((n) => n.id === REPO_GROUP_IDS.tags);

  it('확인 전에는 행·묶음에 아무 표시가 없다 (지금까지의 모양)', () => {
    const group = tagsGroup(build({}));
    expect(group?.suffix).toBeUndefined();
    expect(group?.children?.map((c) => [c.label, c.suffix, c.badges, c.detail?.()])).toEqual(
      NAMES.map((n) => [n, undefined, undefined, undefined]),
    );
  });

  it('확인 뒤: push 안 됨 suffix, 다름 배지(툴팁은 행 툴팁의 원격별 상태), 원격에만 있는 tag 는 행이 없다', () => {
    const group = tagsGroup(build({ origin }));
    expect(group?.suffix).toContain(S.tag.tree.summaryUnpushed(1));
    const byName = Object.fromEntries((group?.children ?? []).map((c) => [c.label, c]));
    expect(Object.keys(byName).sort()).toEqual([...NAMES].sort());
    expect(byName['v2.4.0']?.suffix).toBe(S.tag.tree.unpushed);
    expect(byName['v2.4.0']?.badges).toBeUndefined();
    const lines = [
      S.tag.state.line('origin', S.tag.state.diverged),
      S.tag.state.line('upstream', S.tag.state.notChecked),
    ].join('\n');
    // 배지는 따로 툴팁을 두지 않는다 — 행 툴팁(늦게 만드는 원격별 상태)이 보인다
    expect(byName['v2.3.1']?.badges).toEqual([{ icon: 'tagDiffers', text: S.tag.tree.differs }]);
    expect(byName['v2.3.1']?.detail?.()).toBe(lines);
    expect(byName['v2.3.0']?.suffix).toBeUndefined();
    expect(byName['v2.3.0']?.badges).toBeUndefined();
  });

  it('확인 중이면 묶음 요약 앞에 확인 중 표시', () => {
    expect(tagsGroup(build({}, true))?.suffix).toBe(S.tag.tree.checking);
  });
});
