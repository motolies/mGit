import { expect, it } from 'vitest';
import { createMockClient } from '../mock/mock-client';
import type { IntegrationTarget } from '../types';

/** 실제 목 폴더의 상태로 사전 확인·실행 계약을 검사한다. */
async function setup() {
  const client = createMockClient({ rows: 100, scene: 'folder', progressIntervalMs: 0 });
  const [path] = await client.takeStartupPaths();
  if (!path) throw Error('Missing mock folder');
  const { session } = await client.openFolder(path, () => {});
  return { client, session };
}
it('확인한 저장소만 실행하며 변경·충돌·빈 승인·낡은 스냅샷을 보호한다', async () => {
  const { client, session } = await setup();
  const rows = await client.folderIntegrationPreview(session, 'refs/remotes/origin/main', []);
  expect(rows.some((row) => row.reason !== null)).toBe(true);
  const row = rows.find((row) => row.reason === null);
  if (!row?.head || !row.sourceOid || !row.currentBranch)
    throw Error('Expected eligible repository');
  const target: IntegrationTarget = {
    path: row.path,
    currentBranch: row.currentBranch,
    head: row.head,
    sourceOid: row.sourceOid,
  };
  const result = await client.folderBatch(
    session,
    { kind: 'merge', reference: 'refs/remotes/origin/main', mode: 'default', targets: [target] },
    [],
  );
  expect(result.results).toHaveLength(1);
  expect(result.results[0]?.path).toBe(row.path);
  expect(result.succeeded).toBe(1);
  const stale = await client.folderBatch(
    session,
    {
      kind: 'rebase',
      reference: 'refs/remotes/origin/main',
      targets: [{ ...target, head: '0'.repeat(40) }],
    },
    [],
  );
  expect(stale.skipped).toBe(1);
  await expect(
    client.folderBatch(
      session,
      { kind: 'rebase', reference: 'refs/remotes/origin/main', targets: [] },
      [],
    ),
  ).rejects.toThrow('No confirmed');
  await expect(client.folderIntegrationPreview(session, '--help', [])).rejects.toThrow(
    'fully qualified',
  );
  await expect(
    client.folderIntegrationPreview(session, 'refs/heads/main', ['/outside']),
  ).rejects.toThrow('outside');
});
