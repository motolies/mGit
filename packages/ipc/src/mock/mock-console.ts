// 목이 흉내 내는 git 쓰기 명령 기록 (W19 ② 폴더 콘솔, WS-23).
//
// 폴더 장면에서 상태를 바꾸는 쓰기 — 일괄 작업(`folderBatch`), 폴더 stage·unstage·commit, 세션의 충돌 흐름(해결·되돌리기·
// Continue·Skip·Abort) — 가 코어처럼 그 저장소에서 돈 쓰기 명령의 기록을 남긴다: 인자, 종료 코드, stderr 꼬리, 걸린 시간.
// 기록을 어디로 보낼지(그 저장소를 품은 폴더 세션의 `folderCommandLogged`, 그 저장소를 연 세션의 `commandLogged`)는
// `mock-client.ts` 가 정한다. 흉내 내지 않는 것: 읽기 명령(코어도 폴더로는 보내지 않는다), 충돌 해결의 보관 ref 쓰기
// (`hash-object`·`mktree`·`commit-tree`·`update-ref`), 전역 `-c` 설정 인자, 일괄 작업 뒤의 상태 변화(push 해도 ahead 가
// 그대로라 다시 하면 같은 결과다)

import { IpcClientError } from '../client';
import type {
  BatchOp,
  BatchResult,
  CommandLogRecord,
  ConflictSide,
  IndexTarget,
  IndexWriteResult,
  OpKind,
  RepoResult,
  RepoSummary,
  StatusEntry,
  UnresolveMode,
} from '../types';
import { mockReason, pick } from './mock-l10n';
import { type MockFolderData, mockFolderEntries } from './mock-workspace';

/** 목이 돌린 것으로 치는 git 명령 하나 (작업 디렉터리는 기록을 만들 때 준다) */
export interface MockCommand {
  /** `git` 뒤의 인자 */
  args: string[];
  /** 종료 코드 (0 = 성공) */
  status: number;
  /** stderr 꼬리 */
  stderr: string;
  elapsedMs: number;
}

/** 일괄 작업 흉내의 결과: 응답과, 저장소(작업 디렉터리)마다 돌린 명령 (결과 순서) */
export interface MockBatchRun {
  result: BatchResult;
  commands: { cwd: string; command: MockCommand }[];
}

/** 장면 저장소의 원격 호스트 (기록의 URL·stderr 에 쓴다) */
const MOCK_REMOTE_HOST = 'git.example.com:acme';

/** 문자열에서 고른 작은 정수 (같은 저장소·같은 명령이면 늘 같은 시간·해시가 나오게) */
function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** 걸린 시간: `base` + 이름에서 고른 0~`spread` ms */
function elapsedOf(key: string, base: number, spread: number): number {
  return base + (hashOf(key) % (spread + 1));
}

/** 짧은 커밋 해시 흉내 (7자) */
function shortOf(key: string): string {
  return hashOf(key).toString(16).padStart(8, '0').slice(0, 7);
}

/** 성공한 명령 */
function ran(args: string[], elapsedMs: number, stderr = ''): MockCommand {
  return { args, status: 0, stderr, elapsedMs };
}

/**
 * 기록 번호를 매겨 명령 기록을 만드는 함수를 돌려준다. 번호는 장면의 저장소 탭 기록(`commandLogged`, 1부터)과 겹치지
 * 않게 10001 부터 오른다. 시작 시각은 "지금 끝났다"로 친다 (`now` − 걸린 시간)
 */
export function createMockRecorder(
  now: () => number = Date.now,
): (cwd: string, command: MockCommand) => CommandLogRecord {
  let next = 10_001;
  return (cwd, command) => ({
    id: next++,
    args: [...command.args],
    cwd,
    startedAt: now() - command.elapsedMs,
    elapsedMs: command.elapsedMs,
    status: command.status,
    stderrTail: command.stderr,
    isWrite: true,
    cancelled: false,
  });
}

/** ref 전체 이름을 화면용 짧은 이름으로 (`refs/remotes/origin/x` → `origin/x`, 코어 `short_ref`) */
function shortRef(name: string): string {
  return name.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
}

/** 일괄 작업의 진행 라벨 (코어 `BatchOp::label`, 화면 언어로) */
export function mockBatchLabel(op: BatchOp): string {
  switch (op.kind) {
    case 'fetch':
      return pick('일괄 fetch', 'Batch fetch');
    case 'pull':
      return pick('일괄 pull', 'Batch pull');
    case 'push':
      return pick('일괄 push', 'Batch push');
    case 'createBranch': {
      if (op.startPoint) {
        const from = shortRef(op.startPoint);
        return pick(
          `일괄 branch 만들기: ${op.name} (${from} 에서)`,
          `Batch create branch: ${op.name} (from ${from})`,
        );
      }
      return pick(`일괄 branch 만들기: ${op.name}`, `Batch create branch: ${op.name}`);
    }
    case 'checkout':
      return pick(`일괄 checkout: ${op.name}`, `Batch checkout: ${op.name}`);
    case 'checkoutRemote':
      return pick(
        `일괄 checkout: ${op.remote}/${op.branch}`,
        `Batch checkout: ${op.remote}/${op.branch}`,
      );
    case 'worktree':
      return pick(`일괄 워크트리: ${op.branch}`, `Batch worktree: ${op.branch}`);
  }
}

/** 장면 저장소가 가진 브랜치인지 (브랜치 목록 기준 — 워크트리는 원 저장소의 브랜치를 본다) */
function hasBranch(data: MockFolderData, repo: string, name: string, remote: boolean): boolean {
  const index = data.folderCommitDetail.repoIndex[repo];
  const owner = index === undefined ? repo : (data.folderTimeline[index]?.path ?? repo);
  return data.folderBranches.branches.some(
    (b) => b.remote === remote && b.name === name && b.repos.some((r) => r.path === owner),
  );
}

/** 작업 트리에 커밋하지 않은 변경이 있는지 (코어: staged + unstaged + 충돌 > 0, untracked 는 세지 않는다) */
function isDirty(entries: readonly StatusEntry[]): boolean {
  const idle = ['unmodified', 'untracked', 'ignored'];
  return entries.some((e) => e.conflict || !idle.includes(e.index) || !idle.includes(e.worktree));
}

/** 저장소 하나에 일괄 작업을 적용한 결과: 건너뜀(명령 없음) 또는 돌린 명령 하나 */
type BatchStep = { skip: string } | { failed: string } | { command: MockCommand };

/**
 * 저장소 하나의 일괄 작업 (코어 `run_batch_one` 의 건너뜀 규칙 흉내). 요약에 실패한 저장소는 상태를 못 읽어 명령 없이
 * 실패한다. 실패하는 명령: 갈라진 브랜치(ahead·behind 둘 다 > 0)의 push(거부)·pull(--ff-only 불가), 이미 있는 branch
 * 만들기, 없는 branch 로 checkout
 */
function batchStep(
  data: MockFolderData,
  op: BatchOp,
  repo: string,
  summary: RepoSummary,
): BatchStep {
  if (summary.error) {
    return { failed: summary.error };
  }
  const name = summary.name;
  const entries = mockFolderEntries(data, repo);
  const dirty = isDirty(entries);
  const inOp = summary.op !== null && summary.op !== undefined;
  const branch = summary.branch ?? null;
  const upstream = summary.ahead !== null && summary.ahead !== undefined && branch !== null;
  const ahead = summary.ahead ?? 0;
  const behind = summary.behind ?? 0;
  const url = `${MOCK_REMOTE_HOST}/${name}.git`;
  const key = `${repo}:${op.kind}`;
  switch (op.kind) {
    case 'fetch': {
      const args = ['fetch', '--all', ...(op.prune ? ['--prune'] : [])];
      const stderr =
        behind > 0 && branch
          ? `From ${url}\n   ${shortOf(`${key}:old`)}..${shortOf(`${key}:new`)}  ${branch} -> origin/${branch}`
          : '';
      return { command: ran(args, elapsedOf(key, 380, 900), stderr) };
    }
    case 'pull': {
      if (inOp) {
        return { skip: mockReason.inProgress() };
      }
      if (dirty) {
        return { skip: mockReason.dirty() };
      }
      if (!upstream) {
        return { skip: mockReason.noUpstream() };
      }
      const args = ['pull', '--ff-only'];
      if (ahead > 0 && behind > 0) {
        return {
          command: {
            args,
            status: 128,
            stderr: [
              "hint: Diverging branches can't be fast-forwarded, you need to either:",
              'hint:   git merge --no-ff',
              'hint: or:',
              'hint:   git rebase',
              'fatal: Not possible to fast-forward, aborting.',
            ].join('\n'),
            elapsedMs: elapsedOf(key, 520, 700),
          },
        };
      }
      return { command: ran(args, elapsedOf(key, 520, 900), `From ${url}`) };
    }
    case 'push': {
      if (!upstream) {
        return { skip: mockReason.noUpstream() };
      }
      if (ahead === 0) {
        return { skip: mockReason.nothingToPush() };
      }
      if (behind > 0) {
        return {
          command: {
            args: ['push'],
            status: 1,
            stderr: [
              `To ${url}`,
              ` ! [rejected]        ${branch} -> ${branch} (fetch first)`,
              `error: failed to push some refs to '${url}'`,
              'hint: Updates were rejected because the remote contains work that you do not',
              'hint: have locally. This is usually caused by another repository pushing to',
              "hint: the same ref. If you want to integrate the remote changes, use 'git pull'",
              'hint: before pushing again.',
            ].join('\n'),
            elapsedMs: elapsedOf(key, 700, 600),
          },
        };
      }
      return {
        command: ran(
          ['push'],
          elapsedOf(key, 700, 900),
          `To ${url}\n   ${shortOf(`${key}:old`)}..${shortOf(`${key}:new`)}  ${branch} -> ${branch}`,
        ),
      };
    }
    case 'createBranch': {
      if (op.checkout && inOp) {
        return { skip: mockReason.inProgress() };
      }
      const start = op.startPoint ?? null;
      const args =
        start !== null
          ? op.checkout
            ? ['checkout', '-q', '--no-track', '-b', op.name, start, '--']
            : ['branch', '--no-track', '--', op.name, start]
          : op.checkout
            ? ['checkout', '-q', '-b', op.name]
            : ['branch', '--', op.name];
      if (hasBranch(data, repo, op.name, false)) {
        return {
          command: {
            args,
            status: 128,
            stderr: `fatal: a branch named '${op.name}' already exists`,
            elapsedMs: elapsedOf(key, 8, 20),
          },
        };
      }
      return { command: ran(args, elapsedOf(key, 12, 40)) };
    }
    case 'checkout': {
      if (inOp) {
        return { skip: mockReason.inProgress() };
      }
      if (dirty) {
        return { skip: mockReason.dirty() };
      }
      if (branch === op.name) {
        return { skip: mockReason.alreadyOnBranch() };
      }
      const args = ['checkout', '-q', op.name, '--'];
      if (!hasBranch(data, repo, op.name, false)) {
        return {
          command: {
            args,
            status: 128,
            stderr: `fatal: invalid reference: ${op.name}`,
            elapsedMs: elapsedOf(key, 6, 20),
          },
        };
      }
      return { command: ran(args, elapsedOf(key, 40, 160)) };
    }
    case 'checkoutRemote': {
      if (inOp) {
        return { skip: mockReason.inProgress() };
      }
      if (dirty) {
        return { skip: mockReason.dirty() };
      }
      const tracking = `${op.remote}/${op.branch}`;
      if (!hasBranch(data, repo, tracking, true)) {
        return { skip: mockReason.remoteBranchMissing(tracking) };
      }
      if (branch === op.branch) {
        return { skip: mockReason.alreadyOnBranch() };
      }
      const args = hasBranch(data, repo, op.branch, false)
        ? ['switch', '-q', '--end-of-options', op.branch]
        : [
            'switch',
            '-q',
            '--track',
            '-c',
            op.branch,
            '--end-of-options',
            `refs/remotes/${tracking}`,
          ];
      return { command: ran(args, elapsedOf(key, 40, 160)) };
    }
    case 'worktree': {
      const dest = `${op.destRoot.replace(/\/+$/, '')}/${name}`;
      const args = op.createBranch
        ? ['worktree', 'add', '-b', op.branch, dest]
        : ['worktree', 'add', dest, op.branch];
      return { command: ran(args, elapsedOf(key, 90, 300), `Preparing worktree (${op.branch})`) };
    }
  }
}

/**
 * 폴더 일괄 작업 흉내 (`folderBatch`): 대상 저장소(빈 목록 = 전부, 목록 밖 경로는 코어처럼 조용히 빠진다)마다 코어의
 * 건너뜀 규칙을 따르고, 돌린 명령의 결과로 성공·실패를 정한다. 결과는 경로순, 메시지는 실패면 stderr(코어처럼 앞뒤 공백을
 * 뺀 값), 성공이면 빈 문자열(stdout 흉내 없음). 대상이 없으면 코어처럼 거부한다
 */
export function mockFolderBatch(
  data: MockFolderData,
  op: BatchOp,
  repos: readonly string[],
): MockBatchRun {
  const targets = data.openFolder
    .filter((r) => repos.length === 0 || repos.includes(r.path))
    .map((r) => r.path)
    .sort();
  if (targets.length === 0) {
    throw new IpcClientError({
      kind: 'internal',
      message: pick('대상 저장소가 없습니다', 'No target repositories'),
    });
  }
  const commands: MockBatchRun['commands'] = [];
  const results: RepoResult[] = targets.map((path) => {
    const summary = data.folderSummaries.find((s) => s.path === path);
    const name = summary?.name ?? path.split('/').pop() ?? path;
    if (!summary) {
      return { path, name, ok: false, skipped: null, message: `not a git repository: ${path}` };
    }
    const step = batchStep(data, op, path, summary);
    if ('skip' in step) {
      return { path, name, ok: true, skipped: step.skip, message: '' };
    }
    if ('failed' in step) {
      return { path, name, ok: false, skipped: null, message: step.failed };
    }
    commands.push({ cwd: path, command: step.command });
    const ok = step.command.status === 0;
    return { path, name, ok, skipped: null, message: ok ? '' : step.command.stderr.trim() };
  });
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  return {
    result: {
      label: mockBatchLabel(op),
      results,
      succeeded: results.length - skipped - failed,
      skipped,
      failed,
    },
    commands,
  };
}

/**
 * 폴더 stage·unstage 가 돌린 명령 (코어 `index_write` 의 인자): stage = `add -A`, unstage = `restore --staged`. 대상 안에
 * 충돌이 있어 건너뛴 경로가 있으면 코어처럼 경로를 stdin 으로 넘기는 꼴이다. git 을 돌리지 않았으면(`ran` 거짓) null
 */
export function mockIndexCommand(
  op: 'stage' | 'unstage',
  target: IndexTarget,
  result: IndexWriteResult,
): MockCommand | null {
  if (!result.ran) {
    return null;
  }
  const head = op === 'stage' ? ['add', '-A'] : ['restore', '--staged'];
  const paths = target.kind === 'all' ? ['.'] : target.paths;
  const args =
    result.skipped.length > 0
      ? [...head, '--pathspec-from-file=-', '--pathspec-file-nul']
      : [...head, '--', ...paths];
  return ran(args, elapsedOf(`${op}:${paths.join('\u0000')}`, 9, 40));
}

/**
 * 폴더 일괄 commit 이 저장소마다 돌린 명령 (코어 `folder_commit`): `stageAll` 이면 진행 중 작업으로 건너뛰지 않은 저장소에
 * `add -A`, 커밋한 저장소에 `commit -q -F -`. 결과의 경로순
 */
export function mockCommitCommands(
  result: BatchResult,
  stageAll: boolean,
): { cwd: string; command: MockCommand }[] {
  return result.results.flatMap((r) => {
    const out: { cwd: string; command: MockCommand }[] = [];
    if (stageAll && r.skipped !== mockReason.inProgress()) {
      out.push({ cwd: r.path, command: ran(['add', '-A'], elapsedOf(`${r.path}:add`, 10, 40)) });
    }
    if (r.ok && !r.skipped) {
      out.push({
        cwd: r.path,
        command: ran(['commit', '-q', '-F', '-'], elapsedOf(`${r.path}:commit`, 60, 240)),
      });
    }
    return out;
  });
}

/** 진행 중 작업 종류의 git 서브커맨드 (코어 `op_continue`·`op_skip`·`op_abort`) */
const OP_COMMAND: Record<OpKind, string> = {
  merge: 'merge',
  rebase: 'rebase',
  cherryPick: 'cherry-pick',
  revert: 'revert',
  am: 'am',
  bisect: 'bisect',
};

/** 진행 중 작업을 계속·건너뛰기·중단한 명령. bisect 중단은 `bisect reset` 이다 */
export function mockOpCommand(kind: OpKind, action: 'continue' | 'skip' | 'abort'): MockCommand {
  const args =
    kind === 'bisect' && action === 'abort'
      ? ['bisect', 'reset']
      : [OP_COMMAND[kind], `--${action}`];
  return ran(args, elapsedOf(`${kind}:${action}`, 70, 260));
}

/** 충돌 하나를 해결한 명령들 (코어 `resolve_file`·`resolve_side`·`resolve_delete`) */
export function mockResolveCommands(
  path: string,
  how: { kind: 'file' } | { kind: 'side'; side: ConflictSide } | { kind: 'delete'; keep: boolean },
): MockCommand[] {
  const add = ran(['add', '--', path], elapsedOf(`add:${path}`, 8, 30));
  switch (how.kind) {
    case 'file':
      return [add];
    case 'side':
      return [ran(['checkout', `--${how.side}`, '--', path], elapsedOf(`co:${path}`, 8, 30)), add];
    case 'delete':
      return how.keep ? [add] : [ran(['rm', '-q', '--', path], elapsedOf(`rm:${path}`, 8, 30))];
  }
}

/** 해결을 충돌 상태로 되돌린 명령 (코어 `unresolve`) */
export function mockUnresolveCommand(path: string, mode: UnresolveMode): MockCommand {
  const args =
    mode === 'remake'
      ? ['checkout', '-m', '--', path]
      : ['update-index', '--unresolve', '--', path];
  return ran(args, elapsedOf(`unresolve:${path}`, 8, 30));
}
