import { GraphView, RefLabels, refLabelItems } from '@mgit/graph-view';
import {
  type CommitDetail,
  createNullClient,
  MockGraphSource,
  type RefLabel,
  type TimelineInfo,
} from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useStore } from 'zustand';
import { createFolderStore, type FolderStore } from '../store/folder-store';

afterEach(cleanup);

/** 실제 폴더 스토어의 그래프와 선택 상세 ref를 함께 그립니다. */
function View({ store }: { store: FolderStore }) {
  const timeline = useStore(store, (state) => state.timeline);
  return (
    <>
      <GraphView
        cache={timeline.cache}
        totalRows={timeline.totalRows}
        initialRect={{ width: 1200, height: 240 }}
      />
      <div data-testid="detail-refs">
        {timeline.detail?.state === 'ready' && timeline.detail.detail ? (
          <RefLabels items={refLabelItems(timeline.detail.detail.refs, true)} wrap />
        ) : null}
      </div>
    </>
  );
}

describe('폴더 재로드의 그래프·상세 ref 일관성', () => {
  it('원격 ref가 이동하면 같은 커밋의 선택 상세도 새 그래프와 함께 갱신합니다', async () => {
    const mock = new MockGraphSource({ rows: 2, latencyMs: 0 });
    const source = await mock.fetchWindow(0, 2);
    const row = source.rows[0];
    const local = row?.refs.find((ref) => ref.kind.kind === 'localBranch');
    if (!row || !local) throw new Error('첫 로컬 브랜치가 없습니다');
    const remote: RefLabel = {
      ...local,
      fullName: `refs/remotes/origin/${local.shortName}`,
      shortName: `origin/${local.shortName}`,
      kind: { kind: 'remoteBranch', remote: 'origin' },
      isCurrent: false,
    };
    let refs = [local, remote];
    let generation = 1;
    const info = (): TimelineInfo => ({
      generation,
      rows: 2,
      finished: true,
      maxPerRepo: 10000,
      scoped: false,
      repos: [
        {
          index: 0,
          name: 'api',
          path: '/f/api',
          color: 0,
          headBranch: 'main',
          truncated: false,
          inScope: true,
        },
      ],
    });
    const store = createFolderStore(
      { session: 42, path: '/f', repos: [] },
      {
        ...createNullClient(),
        folderTimelineOpen: async () => info(),
        folderTimelineInfo: async () => info(),
        folderTimelineWindow: async () => ({
          ...source,
          generation,
          rows: source.rows.map((item, index) => ({
            ...item,
            repo: 0,
            refs: index === 0 ? refs : [],
          })),
        }),
        folderCommitDetail: async (): Promise<CommitDetail> => ({
          oid: row.oid,
          parents: [],
          children: [],
          row: 0,
          authorName: row.authorName,
          authorEmail: row.authorEmail,
          authorTime: row.authorTime,
          committerName: row.authorName,
          committerEmail: row.authorEmail,
          committerTime: row.commitTime,
          message: row.subject,
          files: [],
          refs,
        }),
      },
    );
    await store.getState().openTimeline();
    const { container, getByTestId } = render(<View store={store} />);
    act(() => store.getState().selectTimelineRow('/f/api', row.oid));
    const paired = S.graph.refs.paired('origin', local.shortName);
    await waitFor(() => expect(getByTestId('detail-refs').textContent).toContain(paired));
    await waitFor(() =>
      expect(container.querySelector('[data-row="0"]')?.textContent).toContain(paired),
    );

    refs = [local];
    generation = 2;
    act(() =>
      store.getState().applyEvent({
        type: 'graphReloaded',
        session: 42,
        generation,
        rows: 2,
        laneCount: 1,
      }),
    );
    await waitFor(() =>
      expect(container.querySelector('[data-row="0"]')?.textContent).not.toContain(paired),
    );
    await waitFor(() => {
      expect(getByTestId('detail-refs').textContent).toContain(local.shortName);
      expect(getByTestId('detail-refs').textContent).not.toContain(paired);
    });
    expect(store.getState().timeline.selected).toEqual({ repoPath: '/f/api', oid: row.oid });
    store.getState().dispose();
  });
});
