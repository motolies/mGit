import { describe, expect, it } from 'vitest';
import { createMockClient } from '../mock/mock-client';

/** 폴더 로그에서 선택한 커밋을 같은 저장소의 전체 프로필에서 다시 찾는다. */
describe('폴더 하위 저장소의 공통 이력', () => {
  it.each([false, true])('가벼운 세션 승격=%s: 해시·본문·ref·HEAD를 보존한다', async (promote) => {
    const client = createMockClient({ rows: 300, scene: 'folder', progressIntervalMs: 0 });
    const [path] = await client.takeStartupPaths();
    const folder = await client.openFolder(path ?? '', () => {});
    const info = await client.folderTimelineOpen(folder.session);
    const repo = info.repos.find((item) => item.name === 'billing-service');
    if (!repo) throw new Error('Missing billing fixture');
    const timeline = await client.folderTimelineWindow(folder.session, 0, 300);
    const rows = timeline.rows.filter((row) => row.repo === repo.index);
    const target = rows.find((row) => row.inHead);
    if (!target) throw new Error('Missing commit fixture');
    const light = promote
      ? await client.folderOpenRepoSession(folder.session, repo.path, () => {})
      : null;
    const opened = await client.openRepo(repo.path, () => {});
    if (light) expect(opened.session).toBe(light.session);
    const index = await client.findRow(opened.session, target.oid);
    expect(index).not.toBeNull();
    const graph = await client.graphWindow(opened.session, 0, 300);
    expect(graph.rows.map((row) => row.oid)).toEqual(rows.map((row) => row.oid));
    expect(graph.rows.map((row) => row.refs)).toEqual(rows.map((row) => row.refs));
    expect(graph.rows[index ?? 0]?.subject).toBe(target.subject);
    expect(opened.state.refs.labels).toEqual(rows.flatMap((row) => row.refs));
    const head = rows.find((row) => row.isHead);
    if (head && opened.state.refs.head.state !== 'unborn') {
      expect(opened.state.refs.head.oid).toBe(head.oid);
    }
    const detail = await client.commitDetail(opened.session, target.oid);
    expect(await client.commitMessage(opened.session, target.oid)).toBe(detail.message);
    expect(detail.message.startsWith(target.subject)).toBe(true);
    const folderDetail = await client.folderCommitDetail(folder.session, repo.path, target.oid);
    expect(detail.message).toBe(folderDetail.message);
    await client.closeRepo(opened.session);
    await client.closeFolder(folder.session);
  });
});
