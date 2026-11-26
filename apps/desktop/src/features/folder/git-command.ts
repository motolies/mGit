// 선택한 저장소들에 git 명령 실행 (MR-14)의 입력 해석과 위험 판단 (순수 함수).
//
// 명령은 셸을 거치지 않는다: 입력을 셸처럼 따옴표·역슬래시만 풀어 인자 배열로 나누고 코어가 그 배열로 git 을 실행한다
// (명세 2.3 "인자 배열로만 실행", MR-14 "임의의 git 명령"). 그래서 셸만 하는 일(파이프·리디렉션·여러 명령·변수·명령 치환)은
// 글자 그대로 git 에 가면 뜻이 달라지므로 입력 단계에서 막는다. 글롭(`*.md`)·`~`·`!` 는 git 에 그대로 넘긴다.
//
// 위험 판단은 "확인 한 번 더" 를 띄울지 정한다. 놓치는 것이 지나치게 묻는 것보다 나쁘므로, 하위 명령을 알 수 없거나(별칭
// 포함) 외부 프로그램을 돌리는 설정을 넘기는 것도 위험으로 본다.

/** 입력을 해석하지 못한 사유 */
export type CommandParseError = 'empty' | 'unclosedQuote' | 'shellSyntax';

/** 입력 해석 결과: `git` 뒤의 인자 배열, 또는 사유 */
export type ParsedCommand = { ok: true; args: string[] } | { ok: false; error: CommandParseError };

/** 따옴표 밖에서 셸만 뜻을 가지는 글자 (파이프·여러 명령·리디렉션·변수·명령 치환·묶음) */
const SHELL_ONLY = new Set(['|', '&', ';', '<', '>', '`', '$', '(', ')']);

/**
 * 입력 한 줄을 인자 배열로 나눈다. 공백이 인자를 나누고, 작은따옴표 안은 글자 그대로, 큰따옴표 안은 `\"`·`\\`·`\$`·`` \` ``
 * 만 풀며, 따옴표 밖의 역슬래시는 다음 글자를 그대로 둔다 (셸과 같다). 맨 앞의 `git` 은 뗀다. 따옴표 밖의 셸 문법
 * (`|`·`&`·`;`·`<`·`>`·`` ` ``·`$`·`(`·`)`)과 큰따옴표 안의 `$`·`` ` `` 는 거부한다
 */
export function parseGitCommand(input: string): ParsedCommand {
  const tokens: string[] = [];
  let current = '';
  let inToken = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    if (quote === "'") {
      if (c === "'") {
        quote = null;
      } else {
        current += c;
      }
      continue;
    }
    if (quote === '"') {
      const next = input.charAt(i + 1);
      if (c === '"') {
        quote = null;
      } else if (c === '\\' && '"\\$`'.includes(next) && next !== '') {
        current += next;
        i++;
      } else if (c === '$' || c === '`') {
        return { ok: false, error: 'shellSyntax' };
      } else {
        current += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
    } else if (c === '\\') {
      // 끝의 역슬래시 하나는 버린다
      if (i + 1 < input.length) {
        current += input.charAt(i + 1);
        inToken = true;
        i++;
      }
    } else if (/\s/.test(c)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
    } else if (SHELL_ONLY.has(c)) {
      return { ok: false, error: 'shellSyntax' };
    } else {
      current += c;
      inToken = true;
    }
  }
  if (quote !== null) {
    return { ok: false, error: 'unclosedQuote' };
  }
  if (inToken) {
    tokens.push(current);
  }
  if (tokens[0] === 'git') {
    tokens.shift();
  }
  return tokens.length === 0 ? { ok: false, error: 'empty' } : { ok: true, args: tokens };
}

/** 따옴표 없이 그대로 써도 되는 인자 */
const PLAIN_ARG = /^[A-Za-z0-9_@%+=:,./^~-]+$/;

/** 인자 배열을 다시 입력할 수 있는 한 줄로 (`git status -sb`). `parseGitCommand` 로 되읽으면 같은 배열이다 */
export function formatGitCommand(args: readonly string[]): string {
  const quoted = args.map((a) => (PLAIN_ARG.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`));
  return ['git', ...quoted].join(' ');
}

/** 하위 명령 앞의 전역 옵션 하나 (`-c k=v` 는 `{ flag: '-c', value: 'k=v' }`) */
export interface GlobalOption {
  flag: string;
  value: string | null;
}

/** 인자 배열을 전역 옵션·하위 명령·나머지로 나눈 것 */
export interface GitInvocation {
  globals: GlobalOption[];
  /** 하위 명령 (`--version` 처럼 없으면 null) */
  name: string | null;
  /** 하위 명령 뒤의 인자 */
  rest: string[];
}

/** 값을 다음 인자로 받는 전역 옵션 */
const GLOBAL_WITH_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
  '--super-prefix',
]);

/** 인자 배열에서 전역 옵션과 하위 명령을 찾는다 (`--git-dir=x` 꼴과 `--git-dir x` 꼴을 모두 읽는다) */
export function gitInvocation(args: readonly string[]): GitInvocation {
  const globals: GlobalOption[] = [];
  let i = 0;
  while (i < args.length) {
    const a = args[i] ?? '';
    if (!a.startsWith('-')) {
      break;
    }
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) {
      globals.push({ flag: a.slice(0, eq), value: a.slice(eq + 1) });
      i++;
    } else if (GLOBAL_WITH_VALUE.has(a)) {
      globals.push({ flag: a, value: args[i + 1] ?? '' });
      i += 2;
    } else {
      globals.push({ flag: a, value: null });
      i++;
    }
  }
  return { globals, name: args[i] ?? null, rest: args.slice(i + 1) };
}

/** 확인을 한 번 더 받을 까닭 */
export type CommandDanger =
  | 'forcePush'
  | 'remoteDelete'
  | 'discardChanges'
  | 'deleteRefs'
  | 'rewriteHistory'
  | 'runsProgram'
  | 'otherPath'
  | 'unknownCommand';

/** 확인 창에 보이는 차례 */
const DANGER_ORDER: readonly CommandDanger[] = [
  'discardChanges',
  'forcePush',
  'remoteDelete',
  'deleteRefs',
  'rewriteHistory',
  'runsProgram',
  'otherPath',
  'unknownCommand',
];

/**
 * 알려진 git 하위 명령 (git 2.4x `git help -a` 의 주요·보조·배관 명령과 흔한 확장). 여기 없으면 별칭이거나 오타라
 * 무엇을 할지 알 수 없다
 */
// biome-ignore format: 명령 이름 목록은 한 줄에 여러 개씩 둔다
const KNOWN_COMMANDS = new Set([
  'add', 'am', 'annotate', 'apply', 'archive', 'backfill', 'bisect', 'blame', 'branch', 'bugreport',
  'bundle', 'cat-file', 'check-attr', 'check-ignore', 'check-mailmap', 'check-ref-format',
  'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'citool', 'clean', 'clone', 'column',
  'commit', 'commit-graph', 'commit-tree', 'config', 'count-objects', 'credential', 'describe',
  'diagnose', 'diff', 'diff-files', 'diff-index', 'diff-tree', 'difftool', 'fast-export',
  'fast-import', 'fetch', 'fetch-pack', 'filter-branch', 'filter-repo', 'fmt-merge-msg',
  'for-each-ref', 'for-each-repo', 'format-patch', 'fsck', 'gc', 'get-tar-commit-id', 'grep',
  'gui', 'hash-object', 'help', 'index-pack', 'init', 'instaweb', 'interpret-trailers',
  'last-modified', 'lfs', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge',
  'merge-base', 'merge-file', 'merge-tree', 'mergetool', 'mktag', 'mktree', 'multi-pack-index',
  'mv', 'name-rev', 'notes', 'pack-objects', 'pack-refs', 'prune', 'prune-packed', 'pull', 'push',
  'range-diff', 'read-tree', 'rebase', 'reflog', 'refs', 'remote', 'repack', 'replace', 'replay',
  'repo', 'request-pull', 'rerere', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm',
  'send-email', 'shortlog', 'show', 'show-branch', 'show-index', 'show-ref', 'sparse-checkout',
  'stash', 'status', 'stripspace', 'submodule', 'switch', 'symbolic-ref', 'tag', 'unpack-file',
  'unpack-objects', 'update-index', 'update-ref', 'update-server-info', 'var', 'verify-commit',
  'verify-pack', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree',
]);

/** 외부 프로그램을 띄우거나 메일을 보내는 하위 명령 (저장소 수만큼 띄운다) */
const PROGRAM_COMMANDS = new Set([
  'citool',
  'credential',
  'daemon',
  'difftool',
  'gui',
  'instaweb',
  'mergetool',
  'send-email',
]);

/** 옵션 하나가 `--long`(=값 포함) 이거나, 짧은 옵션 묶음(`-fd`)에 그 글자가 있는지 */
function optionMatches(token: string, longs: readonly string[], shorts: string): boolean {
  if (token.startsWith('--')) {
    return longs.some((l) => token === l || token.startsWith(`${l}=`));
  }
  if (/^-[A-Za-z]+$/.test(token)) {
    return [...token.slice(1)].some((c) => shorts.includes(c));
  }
  return false;
}

/** `--` 앞의 옵션 중에 맞는 것이 있는지 */
function hasOption(rest: readonly string[], longs: readonly string[], shorts = ''): boolean {
  for (const token of rest) {
    if (token === '--') {
      return false;
    }
    if (optionMatches(token, longs, shorts)) {
      return true;
    }
  }
  return false;
}

/** 옵션이 아닌 인자 (`--` 뒤는 모두). `skipValueOf` 의 옵션 바로 뒤 값은 뺀다 */
function operands(rest: readonly string[], skipValueOf: readonly string[] = []): string[] {
  const out: string[] = [];
  let afterDashes = false;
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] ?? '';
    if (afterDashes) {
      out.push(token);
    } else if (token === '--') {
      afterDashes = true;
    } else if (skipValueOf.includes(token)) {
      i++;
    } else if (!token.startsWith('-') || token === '-') {
      out.push(token);
    }
  }
  return out;
}

/** 외부 프로그램을 돌리게 하는 설정 이름인지 (`-c 이름=값`). 별칭은 값이 `!` 로 시작할 때만 (셸 명령 별칭) */
function runsProgramConfig(setting: string | null): boolean {
  if (setting === null) {
    return false;
  }
  const eq = setting.indexOf('=');
  const key = (eq < 0 ? setting : setting.slice(0, eq)).toLowerCase();
  const value = eq < 0 ? '' : setting.slice(eq + 1);
  if (key.startsWith('alias.')) {
    return value.trim().startsWith('!');
  }
  return (
    key.startsWith('pager.') ||
    key.startsWith('protocol.') ||
    /(sshcommand|\.pager|\.editor|askpass|\.helper|hookspath|fsmonitor|\.external|\.textconv|\.clean|\.smudge|\.process|\.driver|\.program|\.command|\.cmd|packobjectshook|uploadpack|receivepack)$/.test(
      key,
    )
  );
}

/** 하위 명령별 위험 (전역 옵션과 알 수 없는 명령은 `commandDangers` 가 본다) */
function subcommandDangers(name: string, rest: readonly string[]): CommandDanger[] {
  const first = rest[0] ?? '';
  switch (name) {
    case 'push': {
      const targets = operands(rest, ['-o', '--push-option', '--repo']);
      const out: CommandDanger[] = [];
      if (
        hasOption(
          rest,
          ['--force', '--force-with-lease', '--force-if-includes', '--mirror'],
          'f',
        ) ||
        targets.some((t) => t.startsWith('+'))
      ) {
        out.push('forcePush');
      }
      if (
        hasOption(rest, ['--delete', '--prune', '--mirror'], 'd') ||
        targets.some((t) => t.startsWith(':'))
      ) {
        out.push('remoteDelete');
      }
      if (hasOption(rest, ['--receive-pack', '--exec'])) {
        out.push('runsProgram');
      }
      return out;
    }
    case 'reset':
      return hasOption(rest, ['--hard', '--merge']) ? ['discardChanges'] : [];
    case 'checkout': {
      const out: CommandDanger[] = [];
      if (hasOption(rest, ['--force', '--ours', '--theirs', '--merge'], 'fm')) {
        out.push('discardChanges');
      } else {
        // `checkout -- 경로`·`checkout .`·`checkout <커밋> <경로>` 는 작업 트리 파일을 덮어쓴다
        const paths = operands(rest, ['-b', '-B', '--orphan']);
        if (rest.includes('--') || paths.includes('.') || paths.length >= 2) {
          out.push('discardChanges');
        }
      }
      if (hasOption(rest, [], 'B')) {
        out.push('deleteRefs');
      }
      return out;
    }
    case 'switch': {
      const out: CommandDanger[] = [];
      if (hasOption(rest, ['--force', '--discard-changes'], 'f')) out.push('discardChanges');
      if (hasOption(rest, ['--force-create'], 'C')) out.push('deleteRefs');
      return out;
    }
    case 'restore': {
      const staged = hasOption(rest, ['--staged'], 'S');
      const worktree = hasOption(rest, ['--worktree'], 'W');
      return staged && !worktree ? [] : ['discardChanges'];
    }
    case 'clean':
      return hasOption(rest, ['--dry-run'], 'n') ? [] : ['discardChanges'];
    case 'rm':
      return hasOption(rest, ['--cached']) ? [] : ['discardChanges'];
    case 'stash':
      return first === 'drop' || first === 'clear' ? ['discardChanges'] : [];
    case 'checkout-index':
      return hasOption(rest, ['--force'], 'f') ? ['discardChanges'] : [];
    case 'read-tree':
      return hasOption(rest, ['--reset'], 'u') ? ['discardChanges'] : [];
    case 'merge':
    case 'cherry-pick':
    case 'revert':
    case 'am':
      return hasOption(rest, ['--abort']) ? ['discardChanges'] : [];
    case 'rebase': {
      if (hasOption(rest, ['--abort'])) return ['discardChanges'];
      if (hasOption(rest, ['--show-current-patch'])) return [];
      return hasOption(rest, ['--exec'], 'x')
        ? ['rewriteHistory', 'runsProgram']
        : ['rewriteHistory'];
    }
    case 'commit':
      return hasOption(rest, ['--amend']) ? ['rewriteHistory'] : [];
    case 'filter-branch':
    case 'filter-repo':
      return ['rewriteHistory'];
    case 'replace':
      return hasOption(rest, ['--delete'], 'd') ? ['deleteRefs'] : ['rewriteHistory'];
    case 'branch':
      return hasOption(rest, ['--delete', '--force'], 'dDfMC') ? ['deleteRefs'] : [];
    case 'tag':
      return hasOption(rest, ['--delete', '--force'], 'df') ? ['deleteRefs'] : [];
    case 'update-ref':
      return ['deleteRefs'];
    case 'symbolic-ref':
      return hasOption(rest, ['--delete'], 'd') ? ['deleteRefs'] : [];
    case 'reflog':
      return first === 'expire' || first === 'delete' || first === 'drop' ? ['deleteRefs'] : [];
    case 'gc':
      return rest.some((t) => t === '--prune=now' || t === '--prune=all') ? ['deleteRefs'] : [];
    case 'prune':
    case 'prune-packed':
      return ['deleteRefs'];
    case 'remote':
      return first === 'remove' || first === 'rm' || first === 'prune' ? ['deleteRefs'] : [];
    case 'worktree':
      return first === 'remove' || first === 'prune' ? ['deleteRefs'] : [];
    case 'notes':
      return first === 'remove' || first === 'prune' ? ['deleteRefs'] : [];
    case 'config':
      return hasOption(rest, ['--unset', '--unset-all', '--remove-section', '--rename-section']) ||
        first === 'unset' ||
        first === 'remove-section' ||
        first === 'rename-section'
        ? ['deleteRefs']
        : [];
    case 'submodule':
      if (first === 'deinit') return ['discardChanges'];
      if (first === 'foreach') return ['runsProgram'];
      return first === 'update' && hasOption(rest, ['--force'], 'f') ? ['discardChanges'] : [];
    case 'lfs':
      if (first === 'prune') return ['deleteRefs'];
      return first === 'migrate' ? ['rewriteHistory'] : [];
    case 'bisect':
      return first === 'run' ? ['runsProgram'] : [];
    case 'help':
      return hasOption(rest, ['--web'], 'w') ? ['runsProgram'] : [];
    case 'grep':
      return hasOption(rest, ['--open-files-in-pager'], 'O') ? ['runsProgram'] : [];
    default:
      return PROGRAM_COMMANDS.has(name) ? ['runsProgram'] : [];
  }
}

/**
 * 확인을 한 번 더 받을 까닭 (중복 없이 확인 창 차례로). 비어 있으면 바로 실행한다. 다른 경로를 대상으로 하는 전역
 * 옵션(`-C`·`--git-dir`·`--work-tree`), 외부 프로그램을 돌리는 설정(`-c alias.x=!…`·`core.sshCommand` 등·`--exec-path=`),
 * 알 수 없는 하위 명령(별칭·오타)도 위험으로 본다
 */
export function commandDangers(args: readonly string[]): CommandDanger[] {
  const { globals, name, rest } = gitInvocation(args);
  const found = new Set<CommandDanger>();
  for (const g of globals) {
    if (g.flag === '-C' || g.flag === '--git-dir' || g.flag === '--work-tree') {
      found.add('otherPath');
    } else if (g.flag === '--exec-path' && g.value !== null) {
      found.add('runsProgram');
    } else if ((g.flag === '-c' || g.flag === '--config-env') && runsProgramConfig(g.value)) {
      found.add('runsProgram');
    }
  }
  if (name !== null) {
    if (!KNOWN_COMMANDS.has(name) && !PROGRAM_COMMANDS.has(name)) {
      found.add('unknownCommand');
    }
    for (const danger of subcommandDangers(name, rest)) {
      found.add(danger);
    }
  }
  return DANGER_ORDER.filter((d) => found.has(d));
}

/**
 * 작업 트리 파일을 건드리지 않는 하위 명령 (읽기·ref·설정·원격만 다룬다). 편집기 초안이 있어도 실행한다. 여기 없는
 * 명령(알 수 없는 별칭, 훅이 파일을 고칠 수 있는 commit 포함)은 파일을 바꿀 수 있다고 본다
 */
// biome-ignore format: 명령 이름 목록은 한 줄에 여러 개씩 둔다
const WORKTREE_SAFE = new Set([
  'annotate', 'archive', 'blame', 'branch', 'bugreport', 'bundle', 'cat-file', 'check-attr',
  'check-ignore', 'check-mailmap', 'check-ref-format', 'cherry', 'column', 'commit-graph',
  'commit-tree', 'config', 'count-objects', 'credential', 'describe', 'diagnose', 'diff',
  'diff-files', 'diff-index', 'diff-tree', 'fast-export', 'fetch', 'for-each-ref', 'format-patch',
  'fsck', 'gc', 'get-tar-commit-id', 'grep', 'hash-object', 'help', 'interpret-trailers',
  'last-modified', 'log', 'ls-files', 'ls-remote', 'ls-tree', 'maintenance', 'merge-base',
  'mktag', 'mktree', 'multi-pack-index', 'name-rev', 'notes', 'pack-refs', 'prune', 'push',
  'range-diff', 'reflog', 'refs', 'remote', 'repack', 'replace', 'repo', 'request-pull', 'rev-list',
  'rev-parse', 'shortlog', 'show', 'show-branch', 'show-index', 'show-ref', 'status', 'stripspace',
  'symbolic-ref', 'tag', 'update-ref', 'var', 'verify-commit', 'verify-pack', 'verify-tag',
  'version', 'whatchanged', 'worktree', 'write-tree',
]);

/**
 * 이 명령이 작업 트리 파일을 바꿀 수 있는지 (일괄 작업 전 편집기 초안 확인, `batch-drafts.ts`). 스태시는 목록·보기만
 * 안전하다. 하위 명령이 없으면(`--version` 등) 바꾸지 않는다
 */
export function commandRewritesWorkTree(args: readonly string[]): boolean {
  const { name, rest } = gitInvocation(args);
  if (name === null) {
    return false;
  }
  if (name === 'stash') {
    return !['list', 'show'].includes(rest[0] ?? '');
  }
  return !WORKTREE_SAFE.has(name);
}

/** URL 의 사용자 정보 (`scheme://userinfo@`) */
const URL_USERINFO = /([a-z][a-z0-9+.-]*):\/\/([^/?#\s'"@]*)@/gi;

/**
 * 인자에 자격 증명으로 보이는 것이 있는지 (코어 `redact_args` 와 같은 기준: URL 의 `사용자:비밀@`·ssh 가 아닌 `토큰@`,
 * `Authorization:` 헤더, `token=`·`password=`). 있으면 최근 명령 목록에 남기지 않는다
 */
export function containsSecret(args: readonly string[]): boolean {
  return args.some((arg) => {
    if (/authorization:|(^|[^a-z])(token|password)=/i.test(arg)) {
      return true;
    }
    for (const m of arg.matchAll(URL_USERINFO)) {
      const scheme = (m[1] ?? '').toLowerCase();
      const userinfo = m[2] ?? '';
      if (userinfo.includes(':') || !scheme.endsWith('ssh')) {
        return true;
      }
    }
    return false;
  });
}

/** ESC 글자 */
const ESC = String.fromCharCode(27);
/** BEL 글자 (OSC 끝) */
const BEL = String.fromCharCode(7);

/**
 * 터미널 제어 순서(ANSI 색·커서 이동 등)를 지운다. 출력은 터미널이 아니라 글자로 보이므로 색은 그리지 않는다 —
 * CSI(`ESC [ … 끝 글자`), OSC(`ESC ] … BEL 또는 ESC \`), 그 밖의 두 글자 순서(`ESC x`)를 뺀다
 */
export function stripAnsi(text: string): string {
  if (!text.includes(ESC)) {
    return text;
  }
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c !== ESC) {
      out += c;
      i++;
      continue;
    }
    const kind = text.charAt(i + 1);
    i += 2;
    if (kind === '[') {
      // 매개변수·중간 글자 뒤의 끝 글자(@~~)까지
      while (i < text.length) {
        const code = text.charCodeAt(i);
        i++;
        if (code >= 0x40 && code <= 0x7e) {
          break;
        }
      }
    } else if (kind === ']') {
      while (i < text.length) {
        const d = text.charAt(i);
        if (d === BEL) {
          i++;
          break;
        }
        if (d === ESC && text.charAt(i + 1) === '\\') {
          i += 2;
          break;
        }
        i++;
      }
    } else if (kind >= ' ' && kind <= '/') {
      // 중간 글자가 붙는 순서 (`ESC ( B` 글자 집합 지정 등): 중간 글자들 뒤의 끝 글자 하나까지
      while (i < text.length && text.charAt(i) >= ' ' && text.charAt(i) <= '/') {
        i++;
      }
      i++;
    }
  }
  return out;
}

/** 폴더마다 기억하는 최근 명령 수 */
export const RECENT_COMMANDS_LIMIT = 20;

/** 최근 명령 목록에 명령을 맨 앞에 올린다 (같은 명령은 하나만, 상한까지). 자격 증명이 든 명령은 남기지 않는다 */
export function withRecentCommand(recent: readonly string[], args: readonly string[]): string[] {
  if (containsSecret(args)) {
    return [...recent];
  }
  const line = formatGitCommand(args);
  return [line, ...recent.filter((item) => item !== line)].slice(0, RECENT_COMMANDS_LIMIT);
}
