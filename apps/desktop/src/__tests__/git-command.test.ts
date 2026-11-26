import { describe, expect, it } from 'vitest';
import {
  type CommandDanger,
  commandDangers,
  commandRewritesWorkTree,
  containsSecret,
  formatGitCommand,
  gitInvocation,
  parseGitCommand,
  RECENT_COMMANDS_LIMIT,
  stripAnsi,
  withRecentCommand,
} from '../features/folder/git-command';

/** 입력 한 줄을 인자 배열로 (해석하지 못하면 테스트 실패) */
function argsOf(input: string): string[] {
  const parsed = parseGitCommand(input);
  if (!parsed.ok) {
    throw new Error(`해석 실패: ${input} (${parsed.error})`);
  }
  return parsed.args;
}

/** 입력 한 줄의 위험 */
const dangersOf = (input: string): CommandDanger[] => commandDangers(argsOf(input));

describe('입력 해석 (셸을 거치지 않는 인자 배열)', () => {
  it('공백으로 나누고 맨 앞 git 은 떼며, 따옴표·역슬래시는 셸처럼 푼다', () => {
    expect(argsOf('git status -sb')).toEqual(['status', '-sb']);
    expect(argsOf('  log   --oneline  ')).toEqual(['log', '--oneline']);
    expect(argsOf(`log --format='%h %s' "--grep=a \\"b\\"" c\\ d`)).toEqual([
      'log',
      '--format=%h %s',
      '--grep=a "b"',
      'c d',
    ]);
    // 이어 붙은 따옴표 조각은 한 인자, 빈 따옴표는 빈 인자
    expect(argsOf(`commit -m 'it'\\''s' ''`)).toEqual(['commit', '-m', "it's", '']);
    // 글롭·~·!·# 는 git 에 그대로 넘긴다
    expect(argsOf('ls-files *.md ~ !x #1')).toEqual(['ls-files', '*.md', '~', '!x', '#1']);
    // 작은따옴표 안의 셸 문법은 글자 그대로다
    expect(argsOf(`log --grep='a|b; $x'`)).toEqual(['log', '--grep=a|b; $x']);
  });

  it('빈 명령·닫히지 않은 따옴표·셸 문법은 거부한다', () => {
    expect(parseGitCommand('')).toEqual({ ok: false, error: 'empty' });
    expect(parseGitCommand('  git  ')).toEqual({ ok: false, error: 'empty' });
    expect(parseGitCommand(`log --grep='x`)).toEqual({ ok: false, error: 'unclosedQuote' });
    expect(parseGitCommand('log "x')).toEqual({ ok: false, error: 'unclosedQuote' });
    for (const input of [
      'log | head',
      'status && rm -rf x',
      'status; ls',
      'log > out.txt',
      'log < in',
      'log $HOME',
      'log `whoami`',
      'log $(whoami)',
      'log "$HOME"',
      'log "`id`"',
      'status &',
    ]) {
      expect(parseGitCommand(input), input).toEqual({ ok: false, error: 'shellSyntax' });
    }
  });

  it('다시 입력할 수 있는 꼴로 되돌린다 (되읽으면 같은 배열)', () => {
    const samples = [
      ['status', '-sb'],
      ['log', '--format=%h %s', '--grep=it\'s "x"', 'HEAD~1', '@{u}'],
      ['commit', '-m', '', 'a$b`c|d'],
    ];
    for (const args of samples) {
      const line = formatGitCommand(args);
      expect(line.startsWith('git ')).toBe(true);
      expect(argsOf(line)).toEqual(args);
    }
    expect(formatGitCommand(['status', '-sb'])).toBe('git status -sb');
  });

  it('전역 옵션과 하위 명령을 나눈다', () => {
    expect(
      gitInvocation(['-C', '../x', '-c', 'a=b', '--git-dir=y', '--no-pager', 'log', '-1']),
    ).toEqual({
      globals: [
        { flag: '-C', value: '../x' },
        { flag: '-c', value: 'a=b' },
        { flag: '--git-dir', value: 'y' },
        { flag: '--no-pager', value: null },
      ],
      name: 'log',
      rest: ['-1'],
    });
    expect(gitInvocation(['--version']).name).toBeNull();
  });
});

describe('위험 판단 (놓치는 것이 더 나쁘다)', () => {
  it('강제 push·원격 삭제', () => {
    for (const input of [
      'push --force',
      'push -f origin main',
      'push -uf origin main',
      'push --force-with-lease',
      'push --force-with-lease=main:abc',
      'push --force-if-includes',
      'push origin +main',
      'push origin +refs/heads/a:refs/heads/a',
    ]) {
      expect(dangersOf(input), input).toContain('forcePush');
    }
    for (const input of [
      'push --delete origin x',
      'push -d origin x',
      'push origin :feature',
      'push --prune origin',
    ]) {
      expect(dangersOf(input), input).toContain('remoteDelete');
    }
    expect(dangersOf('push --mirror')).toEqual(['forcePush', 'remoteDelete']);
    expect(dangersOf('push -u origin main')).toEqual([]);
    expect(dangersOf('push')).toEqual([]);
  });

  it('커밋하지 않은 변경·추적하지 않는 파일·스태시를 버리는 명령', () => {
    for (const input of [
      'reset --hard',
      'reset --hard origin/main',
      'reset --merge',
      'clean -fd',
      'clean -f -x',
      'clean -i',
      'checkout .',
      'checkout -- src/a.ts',
      'checkout HEAD~1 src/a.ts',
      'checkout -f main',
      'checkout --theirs a.txt',
      'switch -f main',
      'switch --discard-changes main',
      'restore a.txt',
      'restore -SW a.txt',
      'restore --worktree --staged .',
      'rm a.txt',
      'rm -rf dir',
      'stash drop',
      'stash clear',
      'checkout-index -f -a',
      'read-tree -u HEAD',
      'merge --abort',
      'cherry-pick --abort',
      'rebase --abort',
      'submodule deinit -f lib',
      'submodule update --force',
    ]) {
      expect(dangersOf(input), input).toContain('discardChanges');
    }
    for (const input of [
      'reset',
      'reset HEAD a.txt',
      'reset --soft HEAD~1',
      'clean -n',
      'clean -nd',
      'clean --dry-run',
      'checkout main',
      'checkout -b feature origin/feature',
      'switch main',
      'switch -c feature',
      'restore --staged a.txt',
      'rm --cached a.txt',
      'stash',
      'stash pop',
      'stash list',
      'merge origin/main',
    ]) {
      expect(dangersOf(input), input).not.toContain('discardChanges');
    }
  });

  it('ref·설정·객체 삭제, 이력 다시 쓰기', () => {
    for (const input of [
      'branch -D old',
      'branch -d old',
      'branch --delete old',
      'branch -rd origin/old',
      'branch -f main HEAD~3',
      'branch -M main',
      'checkout -B main',
      'switch -C main',
      'tag -d v1',
      'tag -f v1',
      'update-ref refs/heads/main HEAD~1',
      'symbolic-ref -d HEAD',
      'reflog expire --expire=now --all',
      'gc --prune=now',
      'prune',
      'remote remove origin',
      'remote rm origin',
      'worktree remove ../wt',
      'worktree prune',
      'notes remove HEAD',
      'config --unset user.email',
      'config unset user.email',
      'replace -d abc',
      'lfs prune',
    ]) {
      expect(dangersOf(input), input).toContain('deleteRefs');
    }
    for (const input of [
      'rebase main',
      'rebase -i HEAD~3',
      'commit --amend --no-edit',
      'filter-branch --tree-filter x HEAD',
      'filter-repo --path a',
      'replace abc def',
      'lfs migrate import',
    ]) {
      expect(dangersOf(input), input).toContain('rewriteHistory');
    }
    for (const input of ['branch', 'branch -vv', 'branch -m old new', 'tag', 'tag -a v1 -m x']) {
      expect(dangersOf(input), input).toEqual([]);
    }
    expect(dangersOf('rebase --show-current-patch')).toEqual([]);
    expect(dangersOf('commit -m fix')).toEqual([]);
  });

  it('외부 프로그램·셸 명령, 다른 경로, 알 수 없는 명령(별칭)', () => {
    for (const input of [
      '-c alias.x=!rm\\ -rf\\ ~ x',
      '-c core.sshCommand=evil fetch',
      '-c core.pager=less log',
      '-c credential.helper=store fetch',
      '-c protocol.ext.allow=always fetch',
      '--config-env=core.editor=EDITOR commit',
      '--exec-path=/tmp/x status',
      'submodule foreach git clean -fdx',
      'rebase -x make HEAD~2',
      'bisect run ./test.sh',
      'difftool',
      'mergetool',
      'send-email x.patch',
      'help -w log',
      'push --receive-pack=/bin/x',
    ]) {
      expect(dangersOf(input), input).toContain('runsProgram');
    }
    // 셸이 아닌 별칭과 일반 설정은 위험이 아니다
    expect(dangersOf('-c alias.st=status st')).toEqual(['unknownCommand']);
    expect(dangersOf('-c color.ui=always log')).toEqual([]);
    for (const input of ['-C ../other status', '--git-dir=/x/.git log', '--work-tree /x status']) {
      expect(dangersOf(input), input).toContain('otherPath');
    }
    for (const input of ['nuke', 'st', 'npm install', 'statsu']) {
      expect(dangersOf(input), input).toContain('unknownCommand');
    }
    for (const input of ['status -sb', 'log --oneline -5', 'fetch --all', 'pull', '--version']) {
      expect(dangersOf(input), input).toEqual([]);
    }
  });

  it('여러 까닭은 중복 없이 확인 창 차례로', () => {
    expect(dangersOf('-C ../x push --force --delete origin x')).toEqual([
      'forcePush',
      'remoteDelete',
      'otherPath',
    ]);
  });
});

describe('작업 트리를 바꿀 수 있는 명령 (편집기 초안 확인)', () => {
  it('읽기·ref·원격만 다루는 명령은 바꾸지 않고, 그 밖(알 수 없는 별칭·commit 포함)은 바꾼다고 본다', () => {
    for (const input of [
      'status',
      'log -5',
      'fetch',
      'push',
      'branch -D x',
      'stash list',
      'stash show',
      'config user.email',
      '--version',
    ]) {
      expect(commandRewritesWorkTree(argsOf(input)), input).toBe(false);
    }
    for (const input of ['checkout main', 'pull', 'stash', 'stash pop', 'commit -m x', 'nuke']) {
      expect(commandRewritesWorkTree(argsOf(input)), input).toBe(true);
    }
  });
});

describe('자격 증명과 최근 명령', () => {
  it('URL 의 비밀·토큰, 헤더, token=·password= 를 알아본다 (ssh 사용자 이름은 비밀이 아니다)', () => {
    expect(containsSecret(['remote', 'add', 'o', 'https://user:p4ss@host/r.git'])).toBe(true);
    expect(containsSecret(['clone', 'https://ghp_abc@github.com/o/r.git'])).toBe(true);
    expect(containsSecret(['-c', 'http.extraheader=Authorization: Bearer x', 'fetch'])).toBe(true);
    expect(containsSecret(['x', '--password=hunter2'])).toBe(true);
    expect(containsSecret(['x', 'access_token=abc'])).toBe(true);
    expect(containsSecret(['remote', 'add', 'o', 'ssh://git@host/r.git'])).toBe(false);
    expect(containsSecret(['remote', 'add', 'o', 'https://host/r.git'])).toBe(false);
    expect(containsSecret(['log', '--author=a@b.c'])).toBe(false);
  });

  it('최근 명령은 맨 앞에 하나만 두고 상한까지, 자격 증명이 든 명령은 남기지 않는다', () => {
    const recent = withRecentCommand(['git log', 'git status -sb'], ['status', '-sb']);
    expect(recent).toEqual(['git status -sb', 'git log']);
    expect(withRecentCommand(recent, ['fetch', 'https://u:p@h/r.git'])).toEqual(recent);
    const many = Array.from({ length: RECENT_COMMANDS_LIMIT }, (_, i) => `git log -${i}`);
    expect(withRecentCommand(many, ['status'])).toHaveLength(RECENT_COMMANDS_LIMIT);
  });
});

describe('터미널 제어 순서 지우기', () => {
  it('색(CSI)·제목(OSC)·두 글자 순서를 지우고 글자는 남긴다', () => {
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    expect(stripAnsi(`${esc}[1;31merror${esc}[0m: x`)).toBe('error: x');
    expect(stripAnsi(`${esc}]0;title${bel}ok ${esc}]8;;http://x${esc}\\link`)).toBe('ok link');
    expect(stripAnsi(`a${esc}(Bb`)).toBe('ab');
    expect(stripAnsi('평범한 글자')).toBe('평범한 글자');
  });
});
