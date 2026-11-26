// 목이 흉내 내는 git 쓰기 명령 기록 (W19 ② 폴더 콘솔, WS-23).
//
// 폴더 장면에서 상태를 바꾸는 쓰기 — 일괄 작업(`folderBatch`), 폴더 stage·unstage·commit, 세션의 충돌 흐름(해결·되돌리기·
// Continue·Skip·Abort) — 가 코어처럼 그 저장소에서 돈 쓰기 명령의 기록을 남긴다: 인자, 종료 코드, stderr 꼬리, 걸린 시간.
// 기록을 어디로 보낼지(그 저장소를 품은 폴더 세션의 `folderCommandLogged`, 그 저장소를 연 세션의 `commandLogged`)는
// `mock-client.ts` 가 정한다. 흉내 내지 않는 것: 읽기 명령(코어도 폴더로는 보내지 않는다), 충돌 해결의 보관 ref 쓰기
// (`hash-object`·`mktree`·`commit-tree`·`update-ref`), 전역 `-c` 설정 인자, 일괄 작업 뒤의 상태 변화(push 해도 ahead 가
// 그대로라 다시 하면 같은 결과다). 예외: pull·branch 업데이트(BR-09)가 옮긴 로컬 branch 는 ↓ 를 0 으로 만든다
// (`applyMockBatchMoves` — 화면에서 업데이트 뒤 ↓ 가 사라지는 것을 보도록)

import { IpcClientError } from '../client';
import type {
  BatchOp,
  BatchResult,
  BranchUpdate,
  CommandLogRecord,
  ConflictSide,
  FolderBranch,
  FolderBranchIn,
  IndexTarget,
  IndexWriteResult,
  IntegrationPreview,
  OpKind,
  RefLabel,
  RefMove,
  RepoResult,
  RepoSummary,
  StatusEntry,
  UnresolveMode,
} from '../types';
import { applyMockBranchDeletion, mockDeleteBranches } from './mock-branch-delete';
import { mockReason, pick } from './mock-l10n';
import {
  mockStashFind,
  mockStashMessage,
  mockStashPopLabel,
  mockStashPushSkip,
} from './mock-stash';
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

/** 40자 커밋 해시 흉내 (같은 키면 늘 같은 값) */
function oidOf(key: string): string {
  return Array.from({ length: 5 }, (_, i) =>
    hashOf(`${key}:${i}`).toString(16).padStart(8, '0'),
  ).join('');
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
    case 'merge':
      return pick(`일괄 병합: ${op.reference}`, `Batch merge: ${op.reference}`);
    case 'rebase':
      return pick(`일괄 리베이스: ${op.reference}`, `Batch rebase: ${op.reference}`);
    case 'deleteRemoteBranch':
      return pick('원격 브랜치 일괄 삭제', 'Delete remote branches');
    case 'deleteLocalBranches':
      return pick('로컬 브랜치 강제 삭제', 'Force delete local branches');
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
    case 'updateBranch':
      return pick(`일괄 업데이트: ${op.name}`, `Batch update: ${op.name}`);
    case 'deleteBranch':
      return pick(`로컬 브랜치 일괄 삭제: ${op.name}`, `Delete local branch: ${op.name}`);
    case 'renameBranch':
      return pick(`일괄 이름 바꾸기: ${op.from} → ${op.to}`, `Batch rename: ${op.from} → ${op.to}`);
    case 'stashPush': {
      const message = (op.message ?? '').trim();
      return message === ''
        ? pick('스태시 일괄 저장', 'Batch stash')
        : pick(`스태시 일괄 저장: ${message}`, `Batch stash: ${message}`);
    }
    case 'stashPop':
      return pick(`스태시 일괄 꺼내기 (${op.batch})`, `Batch stash pop (${op.batch})`);
    case 'runCommand': {
      const command = op.args.map((a) => (/[\s'"]/.test(a) ? `'${a}'` : a)).join(' ');
      return pick(`명령 실행: git ${command}`, `Run: git ${command}`);
    }
  }
}

/** 상태 항목의 짧은 상태 글자 (`git status --short` 의 한 칸) */
function shortStatusLetter(state: string): string {
  const letters: Record<string, string> = {
    modified: 'M',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    copied: 'C',
    typeChanged: 'T',
    unmerged: 'U',
  };
  return letters[state] ?? ' ';
}

/**
 * 일괄 명령 흉내 (`BatchOp::RunCommand`, MR-14): 몇 가지 읽기 명령만 장면에서 그럴듯한 출력을 만든다 — `status`(짧은
 * 꼴), `branch`(현재 branch), `rev-parse --abbrev-ref HEAD`, `rev-parse --verify <branch>`(그 로컬 branch 가 없으면 종료 코드
 * 128). 그 밖의 명령은 출력 없이 성공한다. 장면 상태는 바꾸지 않는다
 */
function mockGitCommand(
  data: MockFolderData,
  path: string,
  summary: RepoSummary,
  args: readonly string[],
): { status: number; stdout: string; stderr: string } {
  const words = args.filter((a) => !a.startsWith('-'));
  const [sub, ...rest] = words;
  const branch = summary.branch ?? null;
  if (sub === 'status') {
    const lines = mockFolderEntries(data, path).map((e) =>
      e.index === 'untracked'
        ? `?? ${e.path}`
        : `${shortStatusLetter(e.index)}${shortStatusLetter(e.worktree)} ${e.path}`,
    );
    return {
      status: 0,
      stdout: [`## ${branch ?? 'HEAD (no branch)'}`, ...lines].join('\n').concat('\n'),
      stderr: '',
    };
  }
  if (sub === 'branch' && rest.length === 0) {
    return { status: 0, stdout: branch === null ? '' : `* ${branch}\n`, stderr: '' };
  }
  if (sub === 'rev-parse' && args.includes('--abbrev-ref')) {
    return { status: 0, stdout: `${branch ?? 'HEAD'}\n`, stderr: '' };
  }
  if (sub === 'rev-parse' && args.includes('--verify')) {
    const name = rest[0] ?? '';
    return hasBranch(data, path, name, false)
      ? { status: 0, stdout: `${'0'.repeat(40)}\n`, stderr: '' }
      : { status: 128, stdout: '', stderr: 'fatal: Needed a single revision\n' };
  }
  return { status: 0, stdout: '', stderr: '' };
}

/** 일괄 명령 흉내의 저장소별 결과와 돌린 명령 (`mockFolderBatch` 의 일괄 명령 갈래) */
function mockRunCommand(
  data: MockFolderData,
  op: Extract<BatchOp, { kind: 'runCommand' }>,
  targets: readonly string[],
): MockBatchRun {
  const commands: MockBatchRun['commands'] = [];
  const results: RepoResult[] = targets.map((path) => {
    const summary = data.folderSummaries.find((s) => s.path === path);
    const name = summary?.name ?? path.split('/').pop() ?? path;
    if (!summary) {
      return { path, name, ok: false, skipped: null, message: `not a git repository: ${path}` };
    }
    const out = mockGitCommand(data, path, summary, op.args);
    commands.push({
      cwd: path,
      command: { args: [...op.args], status: out.status, stderr: out.stderr, elapsedMs: 12 },
    });
    const ok = out.status === 0;
    return {
      path,
      name,
      ok,
      skipped: null,
      message: ok ? '' : (out.stderr.trim().split('\n').pop() ?? ''),
      command: {
        status: out.status,
        elapsedMs: 12,
        stdout: out.stdout,
        stdoutTruncated: false,
        stderr: out.stderr,
        stderrTruncated: false,
      },
    };
  });
  const failed = results.filter((r) => !r.ok).length;
  return {
    commands,
    result: {
      label: mockBatchLabel(op),
      results,
      succeeded: results.length - failed,
      skipped: 0,
      failed,
    },
  };
}

/** 원 저장소 경로 (워크트리는 원 저장소의 브랜치를 본다 — 브랜치 목록 기준) */
function ownerOf(data: MockFolderData, repo: string): string {
  const index = data.folderCommitDetail.repoIndex[repo];
  return index === undefined ? repo : (data.folderTimeline[index]?.path ?? repo);
}

/** 장면 저장소가 가진 브랜치인지 (브랜치 목록 기준 — 워크트리는 원 저장소의 브랜치를 본다) */
function hasBranch(data: MockFolderData, repo: string, name: string, remote: boolean): boolean {
  const owner = ownerOf(data, repo);
  return data.folderBranches.branches.some(
    (b) => b.remote === remote && b.name === name && b.repos.some((r) => r.path === owner),
  );
}

/** 작업 트리에 커밋하지 않은 변경이 있는지 (코어: staged + unstaged + 충돌 > 0, untracked 는 세지 않는다) */
function isDirty(entries: readonly StatusEntry[]): boolean {
  const idle = ['unmodified', 'untracked', 'ignored'];
  return entries.some((e) => e.conflict || !idle.includes(e.index) || !idle.includes(e.worktree));
}

/** 그 저장소의 로컬 branch `name` 의 상태 (브랜치 목록 기준). 없으면 undefined */
function localBranchIn(
  data: MockFolderData,
  repo: string,
  name: string,
): FolderBranchIn | undefined {
  const owner = ownerOf(data, repo);
  return data.folderBranches.branches
    .find((b) => !b.remote && b.name === name)
    ?.repos.find((r) => r.path === owner);
}

/** 옮긴 branch 흉내: 전후 커밋은 저장소·branch 로 고른 해시다. `commits` 0 이면 전후가 같다 */
function movedOf(repo: string, branch: string, commits: number): RefMove {
  const from = oidOf(`${repo}:${branch}:from`);
  return { branch, from, to: commits > 0 ? oidOf(`${repo}:${branch}:to`) : from, commits };
}

/**
 * 저장소 하나에 일괄 작업을 적용한 결과: 건너뜀(명령 없음), 돌린 명령 하나, 또는 branch 를 옮긴 명령들(pull·branch
 * 업데이트 — 결과의 `moved`)
 */
type BatchStep =
  | { skip: string; dirty?: true }
  | { failed: string }
  | { command: MockCommand; upstreamSet?: string }
  | { run: MockCommand[]; moved?: RefMove };

/** 커밋하지 않은 변경으로 건너뜀 (코어 `RepoResult::skip_dirty` — 결과 알림이 stash 후 다시 실행을 안내한다) */
function dirtySkip(): BatchStep {
  return { skip: mockReason.dirty(), dirty: true };
}

/**
 * 업스트림이 없는 branch 를 새 업스트림으로 게시하는 push (코어 `publish_args` 흉내): 분리 HEAD·원격 없음은 건너뛰고,
 * 원격은 저장소별로 고른 것(목록에 있을 때만), 없으면 origin, origin 도 없으면 건너뛴다 (코어 `upstream_remote`)
 */
function publishStep(
  summary: RepoSummary,
  chosen: string | null,
  key: string,
  url: string,
): BatchStep {
  const branch = summary.branch ?? null;
  if (branch === null) {
    return { skip: mockReason.detached() };
  }
  const remotes = summary.remotes ?? [];
  if (remotes.length === 0) {
    return { skip: mockReason.noRemotes() };
  }
  if (chosen !== null && !remotes.includes(chosen)) {
    return { skip: mockReason.unknownRemote(chosen) };
  }
  const remote = chosen ?? (remotes.includes('origin') ? 'origin' : null);
  if (remote === null) {
    return { skip: mockReason.remoteNotChosen() };
  }
  return {
    command: ran(
      ['push', '-u', '--end-of-options', remote, `refs/heads/${branch}:refs/heads/${branch}`],
      elapsedOf(key, 700, 900),
      `To ${url}\n * [new branch]      ${branch} -> ${branch}\nbranch '${branch}' set up to track '${remote}/${branch}'.`,
    ),
    upstreamSet: `${remote}/${branch}`,
  };
}

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
    case 'merge':
    case 'rebase':
      return { skip: 'Handled by integration flow' };
    case 'deleteRemoteBranch':
    case 'deleteLocalBranches':
      return { skip: 'Handled by deletion flow' };
    case 'runCommand':
      return { skip: 'Handled by command flow' };
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
        return dirtySkip();
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
      // 받은 commit 수 = behind (ff-only 흉내). 이미 최신이면 0
      return {
        run: [ran(args, elapsedOf(key, 520, 900), `From ${url}`)],
        moved: movedOf(repo, branch ?? '', behind),
      };
    }
    case 'push': {
      if (!upstream) {
        const plan = op.newUpstream ?? null;
        if (plan === null) {
          return { skip: mockReason.noUpstream() };
        }
        const chosen = (plan.remotes ?? []).find((choice) => choice.path === repo)?.remote ?? null;
        return publishStep(summary, chosen, key, url);
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
        return dirtySkip();
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
        return dirtySkip();
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
    case 'updateBranch': {
      // 코어 `update_branch_one` 흉내: branch·업스트림 → (현재 branch 면 진행 중·더티) → 업스트림만 fetch → 비교 → 옮김
      const local = localBranchIn(data, repo, op.name);
      if (!local) {
        return { skip: mockReason.noBranch() };
      }
      const upstreamName = local.upstream ?? null;
      if (upstreamName === null) {
        return { skip: mockReason.noUpstream() };
      }
      // 다른 워크트리에서 checkout 중이면 건드리지 않는다: 워크트리에서 본 원 저장소의 현재 branch, 또는 원 저장소에서 본
      // 워크트리의 현재 branch
      const owner = ownerOf(data, repo);
      const elsewhere =
        repo !== owner && local.current
          ? owner
          : data.folderSummaries.find(
              (s) => s.path !== repo && ownerOf(data, s.path) === owner && s.branch === op.name,
            )?.path;
      if (elsewhere !== undefined) {
        return { skip: mockReason.otherWorktree(elsewhere) };
      }
      const current = branch === op.name;
      if (current && inOp) {
        return { skip: mockReason.inProgress() };
      }
      if (current && dirty) {
        return dirtySkip();
      }
      const remoteBranch = upstreamName.replace(/^origin\//, '');
      if (local.gone) {
        // 업스트림이 원격에서 사라졌다: 코어는 fetch 가 실패한다
        return { failed: `fatal: couldn't find remote ref refs/heads/${remoteBranch}` };
      }
      const fetched = ran(
        [
          'fetch',
          '--end-of-options',
          'origin',
          `+refs/heads/${remoteBranch}:refs/remotes/${upstreamName}`,
        ],
        elapsedOf(`${key}:fetch`, 380, 700),
        `From ${url}`,
      );
      const a = local.ahead ?? 0;
      const b = local.behind ?? 0;
      if (a > 0 && b > 0) {
        return { skip: mockReason.diverged(a, b) };
      }
      if (a > 0) {
        return { skip: mockReason.ahead(a) };
      }
      const moved = movedOf(repo, op.name, b);
      if (b === 0) {
        return { run: [fetched], moved };
      }
      const move = current
        ? ['merge', '--ff-only', moved.to]
        : ['branch', '-f', '--end-of-options', op.name, moved.to];
      return { run: [fetched, ran(move, elapsedOf(`${key}:move`, 8, 40))], moved };
    }
    case 'deleteBranch': {
      const local = localBranchIn(data, repo, op.name);
      if (!local) return { skip: mockReason.noBranch() };
      if (inOp) return { skip: mockReason.inProgress() };
      const owner = ownerOf(data, repo);
      const checkedOut = data.folderSummaries.find(
        (item) => ownerOf(data, item.path) === owner && item.branch === op.name,
      );
      if (local.current || checkedOut)
        return { failed: 'Cannot delete a branch checked out in a worktree' };
      if ((local.ahead ?? 0) > 0) return { failed: 'Branch is not fully merged' };
      return { command: ran(['branch', '-d', '--', op.name], elapsedOf(key, 8, 30)) };
    }
    case 'renameBranch': {
      // 코어 `rename_args` 흉내: branch 없음 → 새 이름 있음 → `branch -m` (현재 branch·다른 워크트리 branch 도 바꾼다)
      if (!localBranchIn(data, repo, op.from)) {
        return { skip: mockReason.noBranch() };
      }
      if (localBranchIn(data, repo, op.to)) {
        return { skip: mockReason.nameTaken(op.to) };
      }
      return {
        command: ran(['branch', '-m', '--end-of-options', op.from, op.to], elapsedOf(key, 8, 30)),
      };
    }
    case 'worktree': {
      const dest = `${op.destRoot.replace(/\/+$/, '')}/${name}`;
      const args = op.createBranch
        ? ['worktree', 'add', '-b', op.branch, dest]
        : ['worktree', 'add', dest, op.branch];
      return { command: ran(args, elapsedOf(key, 90, 300), `Preparing worktree (${op.branch})`) };
    }
    case 'stashPush': {
      // 코어 `folder_stash::push_one` 흉내: 진행 중·충돌 → 변경 없음(미추적 파일만이면 그 사유) → `stash push`
      const skip = mockStashPushSkip(entries, inOp, op.includeUntracked);
      if (skip !== null) {
        return { skip };
      }
      const args = [
        'stash',
        'push',
        ...(op.includeUntracked ? ['--include-untracked'] : []),
        '-m',
        mockStashMessage(op.batch, op.message),
      ];
      return { command: ran(args, elapsedOf(key, 40, 120)) };
    }
    case 'stashPop': {
      // 코어 `pop_one` 흉내: 진행 중·충돌 → 묶음 항목 없음 → oid 로 apply, 인덱스로 drop (목은 충돌을 흉내 내지 않는다)
      if (inOp || entries.some((e) => e.conflict)) {
        return { skip: mockReason.inProgress() };
      }
      const found = mockStashFind(data, repo, op.batch);
      if (!found) {
        return { skip: mockReason.noBatchStash() };
      }
      return {
        run: [
          ran(
            ['stash', 'apply', '--quiet', oidOf(`${repo}:stash:${op.batch}`)],
            elapsedOf(key, 40, 120),
          ),
          ran(
            ['stash', 'drop', '--quiet', `stash@{${found.index}}`],
            elapsedOf(`${key}:drop`, 8, 20),
          ),
        ],
      };
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
  if (op.kind === 'deleteBranch' && repos.length === 0) throw new Error('No deletion targets');
  if (op.kind === 'merge' || op.kind === 'rebase') {
    if (!op.targets.length) throw new Error('No confirmed integration targets');
    const preview = mockIntegrationPreview(
      data,
      op.reference,
      op.targets.map((t) => t.path),
    );
    const commands: MockBatchRun['commands'] = [];
    const results: RepoResult[] = preview.map((row) => {
      const target = op.targets.find((t) => t.path === row.path);
      const skipped =
        row.reason ??
        (!target ||
        target.currentBranch !== row.currentBranch ||
        target.head !== row.head ||
        target.sourceOid !== row.sourceOid
          ? pick(
              '확인 이후 브랜치 또는 커밋이 변경되었습니다. 다시 확인하세요.',
              'Branch or commit changed after confirmation. Preview again.',
            )
          : null);
      if (skipped) return { path: row.path, name: row.name, ok: true, skipped, message: '' };
      const args =
        op.kind === 'merge'
          ? [
              'merge',
              '--no-edit',
              '--no-autostash',
              ...(op.mode === 'noFf'
                ? ['--no-ff']
                : op.mode === 'ffOnly'
                  ? ['--ff-only']
                  : op.mode === 'squash'
                    ? ['--squash']
                    : []),
            ]
          : ['rebase', '--no-autostash', '--no-update-refs'];
      if (op.kind === 'rebase')
        commands.push({
          cwd: row.path,
          command: ran(
            ['update-ref', `refs/mgit/backup/${target?.currentBranch}/mock`, target?.head ?? ''],
            10,
          ),
        });
      commands.push({
        cwd: row.path,
        command: ran([...args, '--end-of-options', target?.sourceOid ?? ''], 50),
      });
      const squashed = op.kind === 'merge' && op.mode === 'squash';
      return {
        path: row.path,
        name: row.name,
        ok: true,
        skipped: null,
        message: squashed
          ? pick(
              '스쿼시 병합을 준비했습니다. 변경 내용을 확인한 뒤 커밋하세요.',
              'Squash merge prepared. Review the changes and commit them.',
            )
          : '',
        integration: squashed ? 'squashed' : 'clean',
      };
    });
    const skipped = results.filter((r) => r.skipped).length;
    return {
      commands,
      result: {
        label: mockBatchLabel(op),
        results,
        succeeded: results.length - skipped,
        skipped,
        failed: 0,
      },
    };
  }
  const deletion =
    op.kind === 'deleteRemoteBranch' || op.kind === 'deleteLocalBranches' ? op : null;
  const targets = data.openFolder
    .filter((repo) => !deletion || deletion.targets.some((target) => target.path === repo.path))
    .filter((r) => repos.length === 0 || repos.includes(r.path))
    .map((r) => r.path)
    .sort();
  if (targets.length === 0) {
    throw new IpcClientError({
      kind: 'internal',
      message: pick('대상 저장소가 없습니다', 'No target repositories'),
    });
  }
  if (op.kind === 'runCommand') {
    if (op.args.length === 0) {
      throw new IpcClientError({
        kind: 'internal',
        message: pick('실행할 git 명령을 입력하세요.', 'Enter a git command to run'),
      });
    }
    return mockRunCommand(data, op, targets);
  }
  const commands: MockBatchRun['commands'] = [];
  const results: RepoResult[] = targets.map((path) => {
    const summary = data.folderSummaries.find((s) => s.path === path);
    const name = summary?.name ?? path.split('/').pop() ?? path;
    if (!summary) {
      return { path, name, ok: false, skipped: null, message: `not a git repository: ${path}` };
    }
    if (deletion) {
      const target = deletion.targets.find((item) => item.path === path);
      if (!target)
        return { path, name, ok: false, skipped: null, message: 'Missing deletion target' };
      if (target.excluded) return { path, name, ok: true, skipped: 'Excluded', message: '' };
      const branchDeletion = mockDeleteBranches(
        target,
        deletion.kind === 'deleteRemoteBranch' && deletion.deleteLocal,
        deletion.kind === 'deleteLocalBranches',
      );
      applyMockBranchDeletion(data.folderBranches, target, branchDeletion);
      const ok =
        !target.error && branchDeletion.locals.every((local) => local.status === 'deleted');
      return { path, name, ok, skipped: null, message: target.error ?? '', branchDeletion };
    }
    const step = batchStep(data, op, path, summary);
    if ('skip' in step) {
      return {
        path,
        name,
        ok: true,
        skipped: step.skip,
        message: '',
        ...(step.dirty ? { skippedDirty: true } : {}),
      };
    }
    if ('failed' in step) {
      return { path, name, ok: false, skipped: null, message: step.failed };
    }
    if ('run' in step) {
      for (const command of step.run) {
        commands.push({ cwd: path, command });
      }
      return {
        path,
        name,
        ok: true,
        skipped: null,
        message: '',
        ...(step.moved ? { moved: step.moved } : {}),
      };
    }
    commands.push({ cwd: path, command: step.command });
    const ok = step.command.status === 0;
    return {
      path,
      name,
      ok,
      skipped: null,
      message: ok ? '' : step.command.stderr.trim(),
      ...(ok && step.upstreamSet ? { upstreamSet: step.upstreamSet } : {}),
    };
  });
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  return {
    result: {
      label:
        op.kind === 'stashPop' ? mockStashPopLabel(data, op.batch, targets) : mockBatchLabel(op),
      results,
      succeeded: results.length - skipped - failed,
      skipped,
      failed,
    },
    commands,
  };
}

/**
 * pull·branch 업데이트가 옮긴 로컬 branch 를 장면에 반영한다 (BR-09): 받은 commit 이 있으면 그 저장소의 그 branch 는
 * ↓ 가 0 이 되고, 현재 branch 면 요약의 behind 도 0 이 된다. 브랜치 목록·요약을 새 객체로 바꿔 다시 읽으면 바뀐 값이
 * 온다. 그래프의 ref 위치는 옮기지 않는다
 */
export function applyMockBatchMoves(data: MockFolderData, results: readonly RepoResult[]): void {
  const moves = results.flatMap((r) =>
    r.moved && r.moved.commits > 0
      ? [{ owner: ownerOf(data, r.path), path: r.path, moved: r.moved }]
      : [],
  );
  if (moves.length === 0) {
    return;
  }
  const hit = (path: string, branch: string) =>
    moves.some((m) => m.owner === path && m.moved.branch === branch);
  data.folderBranches = {
    ...data.folderBranches,
    branches: data.folderBranches.branches.map((b) =>
      b.remote || !b.repos.some((r) => hit(r.path, b.name))
        ? b
        : {
            ...b,
            repos: b.repos.map((r) => (hit(r.path, b.name) ? { ...r, behind: 0 } : r)),
          },
    ),
  };
  data.folderSummaries = data.folderSummaries.map((s) =>
    moves.some((m) => m.path === s.path && m.moved.branch === s.branch) ? { ...s, behind: 0 } : s,
  );
}

/**
 * 일괄 이름 바꾸기가 바꾼 branch 를 장면에 반영한다: 바꾼 저장소(워크트리면 원 저장소)를 `from` 의 저장소 목록에서
 * `to` 로 옮기고(없으면 `to` 를 만든다, 비면 `from` 을 지운다), 그 branch 가 현재인 요약의 이름도 바꾼다. 브랜치
 * 목록·요약을 새 객체로 바꿔 다시 읽으면 바뀐 값이 온다. 그래프의 ref 이름은 바꾸지 않는다
 */
export function applyMockBatchRenames(
  data: MockFolderData,
  op: BatchOp,
  results: readonly RepoResult[],
): void {
  if (op.kind !== 'renameBranch') {
    return;
  }
  const owners = new Set(
    results.filter((r) => r.ok && !r.skipped).map((r) => ownerOf(data, r.path)),
  );
  if (owners.size === 0) {
    return;
  }
  const from = data.folderBranches.branches.find((b) => !b.remote && b.name === op.from);
  const moving = (from?.repos ?? []).filter((r) => owners.has(r.path));
  const others = data.folderBranches.branches.filter((b) => b !== from);
  const target = others.find((b) => !b.remote && b.name === op.to);
  const renamed: FolderBranch = target
    ? { ...target, repos: [...target.repos, ...moving] }
    : { name: op.to, remote: false, remoteName: null, repos: moving };
  const left = (from?.repos ?? []).filter((r) => !owners.has(r.path));
  data.folderBranches = {
    ...data.folderBranches,
    branches: [
      ...others.filter((b) => b !== target),
      ...(from && left.length > 0 ? [{ ...from, repos: left }] : []),
      renamed,
    ],
  };
  data.folderSummaries = data.folderSummaries.map((s) =>
    s.branch === op.from && owners.has(ownerOf(data, s.path)) ? { ...s, branch: op.to } : s,
  );
}

/**
 * 저장소 탭 branch 업데이트 흉내 (BR-09, 코어 `Core::update_branch`): 라벨의 ahead·behind 로 결과를 정하고, 옮겼으면 그
 * 라벨을 업스트림 라벨의 커밋으로 옮기고 ↓ 를 0 으로 둔 라벨 목록을 준다 (옮기지 않았으면 null). 돌린 명령도 준다.
 * branch·업스트림이 없거나 다른 워크트리에서 checkout 중이면 코어처럼 오류 문구로 던진다
 */
export function mockUpdateLocalBranch(
  labels: readonly RefLabel[],
  name: string,
): { result: BranchUpdate; labels: RefLabel[] | null; commands: MockCommand[] } {
  const full = `refs/heads/${name}`;
  const label = labels.find((l) => l.fullName === full);
  if (!label) {
    throw new Error(mockReason.noBranch());
  }
  if (!label.upstream) {
    throw new Error(mockReason.noUpstream());
  }
  if (label.worktreePath && !label.isCurrent) {
    throw new Error(mockReason.otherWorktree(label.worktreePath));
  }
  const upstream = label.upstream.replace(/^refs\/remotes\//, '');
  const remoteRef = `refs/heads/${upstream.split('/').slice(1).join('/')}`;
  if (label.upstreamGone) {
    // 업스트림이 원격에서 사라졌다: 코어는 fetch 가 실패한다
    throw new Error(`fatal: couldn't find remote ref ${remoteRef}`);
  }
  const commands = [
    ran(
      [
        'fetch',
        '--progress',
        '--end-of-options',
        upstream.split('/')[0] ?? 'origin',
        `+${remoteRef}:refs/remotes/${upstream}`,
      ],
      elapsedOf(`${full}:fetch`, 380, 700),
    ),
  ];
  const ahead = label.ahead ?? 0;
  const behind = label.behind ?? 0;
  if (ahead > 0 && behind > 0) {
    return { result: { kind: 'diverged', ahead, behind }, labels: null, commands };
  }
  if (ahead > 0) {
    return { result: { kind: 'ahead', commits: ahead }, labels: null, commands };
  }
  if (behind === 0) {
    return { result: { kind: 'upToDate' }, labels: null, commands };
  }
  const to =
    labels.find((l) => l.fullName === `refs/remotes/${upstream}`)?.target ?? oidOf(`${full}:to`);
  commands.push(
    ran(
      label.isCurrent ? ['merge', '--ff-only', to] : ['branch', '-f', '--end-of-options', name, to],
      elapsedOf(`${full}:move`, 8, 40),
    ),
  );
  return {
    result: { kind: 'updated', from: label.target, to, commits: behind },
    labels: labels.map((l) => (l.fullName === full ? { ...l, target: to, behind: 0 } : l)),
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

/** 목에서도 실제 브랜치 목록과 작업 상태를 확인하고 동일 스냅샷을 실행에 사용한다. */
export function mockIntegrationPreview(
  data: MockFolderData,
  reference: string,
  repos: readonly string[],
): IntegrationPreview[] {
  if (!reference.startsWith('refs/heads/') && !reference.startsWith('refs/remotes/'))
    throw new Error('A fully qualified branch reference is required');
  for (const path of repos)
    if (!data.openFolder.some((repo) => repo.path === path))
      throw new Error('Repository is outside this folder');
  const remote = reference.startsWith('refs/remotes/');
  const name = reference.replace(/^refs\/(heads|remotes)\//, '');
  return data.folderSummaries
    .filter((repo) => !repos.length || repos.includes(repo.path))
    .map((repo) => {
      const exists = hasBranch(data, repo.path, name, remote);
      const reason =
        repo.error ??
        (!repo.branch || repo.detached
          ? pick(
              '현재 브랜치의 커밋이 필요합니다 (분리된 HEAD 또는 빈 저장소)',
              'A committed current branch is required (detached or unborn HEAD)',
            )
          : !exists
            ? mockReason.noBranch()
            : reference === `refs/heads/${repo.branch}`
              ? pick('현재 브랜치와 같은 브랜치입니다', 'The selected branch is the current branch')
              : repo.op || repo.conflicted
                ? mockReason.inProgress()
                : repo.changed
                  ? mockReason.dirty()
                  : null);
      return {
        path: repo.path,
        name: repo.name,
        currentBranch: repo.branch ?? null,
        head: repo.branch ? oidOf(`${repo.path}:head:${repo.branch}`) : null,
        sourceOid: exists ? oidOf(`${ownerOf(data, repo.path)}:${reference}`) : null,
        reason,
      };
    });
}

/** 삭제에 성공한 로컬 브랜치만 장면에서 제거하고 원격 브랜치는 유지한다. */
export function applyMockBatchDeletes(
  data: MockFolderData,
  op: BatchOp,
  results: readonly RepoResult[],
): void {
  if (op.kind !== 'deleteBranch') return;
  const owners = new Set(
    results
      .filter((result) => result.ok && !result.skipped)
      .map((result) => ownerOf(data, result.path)),
  );
  data.folderBranches = {
    ...data.folderBranches,
    branches: data.folderBranches.branches.flatMap((branch) => {
      if (branch.remote || branch.name !== op.name) return [branch];
      const repos = branch.repos.filter((repo) => !owners.has(repo.path));
      return repos.length ? [{ ...branch, repos }] : [];
    }),
  };
}
