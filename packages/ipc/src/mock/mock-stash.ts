// 목의 폴더 일괄 stash (셋째 묶음 G): 코어 `folder_stash.rs` 의 건너뜀 규칙·묶음 표시·묶음 목록을 흉내 낸다. 저장하면
// 그 저장소의 변경 항목을 stash 항목으로 옮겨 두었다가(변경 목록·요약에서 빠진다) 꺼내면 되돌린다. 흉내 내지 않는 것:
// 꺼낼 때의 충돌, 워크트리끼리 함께 쓰는 stash 목록, 일괄 작업 밖에서 만든 stash. 새로고침하면 처음 상태로 돌아간다.

import type { BatchOp, RepoResult, StashBatch, StatusEntry } from '../types';
import { mockReason, pick } from './mock-l10n';
import { type MockFolderData, mockFolderEntries, setMockFolderEntries } from './mock-workspace';

/** 목의 일괄 stash 항목 하나 */
interface MockStash {
  repo: string;
  batch: string;
  /** 사용자 메시지 (한 줄로 다듬은 것, 없으면 빈 문자열) */
  message: string;
  /** 만든 시각 (epoch 초) */
  time: number;
  /** 저장할 때의 branch (분리 HEAD 면 null) */
  branch: string | null;
  /** 저장할 때 치운 변경 항목 */
  entries: StatusEntry[];
}

/** 장면마다의 일괄 stash 목록 (최근 것이 앞). 장면 자료의 모양을 바꾸지 않게 곁에 둔다 */
const stashes = new WeakMap<MockFolderData, MockStash[]>();

/** 그 장면의 일괄 stash 목록 (없으면 만든다) */
function stashesOf(data: MockFolderData): MockStash[] {
  let list = stashes.get(data);
  if (!list) {
    list = [];
    stashes.set(data, list);
  }
  return list;
}

/** 미추적 파일 항목인지 */
function isUntracked(entry: StatusEntry): boolean {
  return entry.index === 'untracked' || entry.worktree === 'untracked';
}

/** 커밋하지 않은 변경(stage·작업 트리)인지 — 코어가 일괄 pull·checkout 에서 "변경 있음" 으로 보는 것 */
function isTrackedChange(entry: StatusEntry): boolean {
  const idle = ['unmodified', 'untracked', 'ignored'];
  return !idle.includes(entry.index) || !idle.includes(entry.worktree);
}

/** 사용자 메시지를 한 줄로 (코어 `one_line`) */
function oneLine(message: string): string {
  return message.replace(/\p{Cc}/gu, ' ').trim();
}

/** stash 메시지: 한 줄 메시지 끝에 묶음 표시 (코어 `tagged_message`) */
export function mockStashMessage(batch: string, message: string | null | undefined): string {
  const tag = `[mgit-batch:${batch}]`;
  const text = oneLine(message ?? '');
  return text === '' ? tag : `${text} ${tag}`;
}

/**
 * 일괄 stash 저장의 건너뜀 사유 (코어 `push_one` 의 순서): 진행 중 작업·충돌 → 변경 없음(미추적 파일만 있고 넣지 않으면
 * 그 사유). 저장할 것이 있으면 null
 */
export function mockStashPushSkip(
  entries: readonly StatusEntry[],
  inOp: boolean,
  includeUntracked: boolean,
): string | null {
  if (inOp || entries.some((e) => e.conflict)) {
    return mockReason.inProgress();
  }
  const tracked = entries.some((e) => !isUntracked(e) && isTrackedChange(e));
  const untracked = entries.some(isUntracked);
  if (tracked || (includeUntracked && untracked)) {
    return null;
  }
  return untracked ? mockReason.untrackedOnly() : mockReason.noStashChanges();
}

/** 그 저장소의 그 묶음 항목과 지금 인덱스 (저장소의 일괄 stash 중 최근 것부터 센다). 없으면 null */
export function mockStashFind(
  data: MockFolderData,
  repo: string,
  batch: string,
): { stash: MockStash; index: number } | null {
  const own = stashesOf(data).filter((s) => s.repo === repo);
  const index = own.findIndex((s) => s.batch === batch);
  const stash = own[index];
  return stash ? { stash, index } : null;
}

/**
 * 일괄 stash 꺼내기의 이름 (코어 `pop_label_in` 흉내): 앞쪽 세 대상 저장소에서 그 묶음 항목을 찾아 저장할 때의 메시지로
 * 짓는다. 못 찾거나 메시지가 없으면 묶음 id 로 (`mockBatchLabel` 과 같은 글자)
 */
export function mockStashPopLabel(
  data: MockFolderData,
  batch: string,
  targets: readonly string[],
): string {
  const ahead = targets.slice(0, 3);
  const message =
    stashesOf(data).find((s) => s.batch === batch && ahead.includes(s.repo))?.message ?? '';
  return message === ''
    ? pick(`스태시 일괄 꺼내기 (${batch})`, `Batch stash pop (${batch})`)
    : pick(`스태시 일괄 꺼내기: ${message}`, `Batch stash pop: ${message}`);
}

/** 요약 줄의 stash 수를 `delta` 만큼 바꾼다 (대시보드의 스태시 열, 0 아래로 내려가지 않는다) */
function bumpStashCount(data: MockFolderData, repo: string, delta: number): void {
  data.folderSummaries = data.folderSummaries.map((row) =>
    row.path === repo ? { ...row, stashCount: Math.max(0, (row.stashCount ?? 0) + delta) } : row,
  );
}

/**
 * 일괄 stash 의 상태 변화를 장면에 반영한다: 저장에 성공한 저장소는 변경 항목(미추적 파일은 넣기로 했을 때만)을 stash
 * 항목으로 옮기고, 꺼내기에 성공한 저장소는 그 항목의 변경을 되돌리고 항목을 지운다. 요약의 stash 수도 함께 바꾼다
 * (워크트리끼리 함께 쓰는 수는 흉내 내지 않는다)
 */
export function applyMockBatchStashes(
  data: MockFolderData,
  op: BatchOp,
  results: readonly RepoResult[],
): void {
  if (op.kind !== 'stashPush' && op.kind !== 'stashPop') {
    return;
  }
  const done = results.filter((r) => r.ok && !r.skipped);
  for (const r of done) {
    const entries = mockFolderEntries(data, r.path);
    if (op.kind === 'stashPush') {
      const taken = entries.filter(
        (e) => (!isUntracked(e) && isTrackedChange(e)) || (op.includeUntracked && isUntracked(e)),
      );
      setMockFolderEntries(
        data,
        r.path,
        entries.filter((e) => !taken.includes(e)),
      );
      stashesOf(data).unshift({
        repo: r.path,
        batch: op.batch,
        message: oneLine(op.message ?? ''),
        time: Math.floor(Date.now() / 1000),
        branch: data.folderSummaries.find((s) => s.path === r.path)?.branch ?? null,
        entries: taken,
      });
      bumpStashCount(data, r.path, 1);
      continue;
    }
    const found = mockStashFind(data, r.path, op.batch);
    if (!found) {
      continue;
    }
    const back = found.stash.entries;
    setMockFolderEntries(
      data,
      r.path,
      [...entries.filter((e) => !back.some((b) => b.path === e.path)), ...back].sort((a, b) =>
        a.path.localeCompare(b.path),
      ),
    );
    const list = stashesOf(data);
    list.splice(list.indexOf(found.stash), 1);
    bumpStashCount(data, r.path, -1);
  }
}

/**
 * 일괄 stash 묶음 목록 (코어 `folder_stash_batches` 흉내): 대상 저장소(빈 목록 = 전부)의 항목을 묶음별로 모아 최근
 * 묶음부터. 묶음마다 저장소의 가장 최근 항목 하나, 메시지·시각은 가장 최근 항목의 것이다
 */
export function mockFolderStashBatches(
  data: MockFolderData,
  repos: readonly string[],
): StashBatch[] {
  type Row = { path: string; name: string; index: number; branch: string | null; time: number };
  const batches = new Map<string, { id: string; message: string; time: number; repos: Row[] }>();
  for (const s of stashesOf(data)) {
    if (repos.length > 0 && !repos.includes(s.repo)) {
      continue;
    }
    const batch = batches.get(s.batch) ?? {
      id: s.batch,
      message: s.message,
      time: s.time,
      repos: [],
    };
    batches.set(s.batch, batch);
    if (batch.repos.some((r) => r.path === s.repo)) {
      continue;
    }
    if (s.time > batch.time) {
      batch.time = s.time;
      batch.message = s.message;
    }
    batch.repos.push({
      path: s.repo,
      name: data.folderSummaries.find((row) => row.path === s.repo)?.name ?? s.repo,
      index: mockStashFind(data, s.repo, s.batch)?.index ?? 0,
      branch: s.branch,
      time: s.time,
    });
  }
  return [...batches.values()]
    .map((b) => ({ ...b, repos: [...b.repos].sort((x, y) => x.path.localeCompare(y.path)) }))
    .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
}
