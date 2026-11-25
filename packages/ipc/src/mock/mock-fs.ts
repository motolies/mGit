// 파일 트리·파일 보기 목 (W10, WS-23). 코어 `fs_tree.rs` 의 계약을 흉내 낸다: 경로 어휘 검증(`..`·`.`·
// 절대 경로·`.git`·빈 구성요소·NUL·길이), 경로 중간의 심볼릭 링크 거부, 링크 나열 거부, 정렬(디렉터리 먼저 →
// 대소문자 무시 이름 → 원래 이름), 항목 수 상한과 `truncated`·`total`, 읽기 상태(text·binary·notUtf8·
// tooLarge·unsupported·missing·denied). 거부는 코어처럼 `internal` 오류다.
//
// 트리는 장면이 준 경로 목록에서 루트를 처음 쓸 때 만들고, 디렉터리의 자식과 항목이 수천 개인 디렉터리의
// 이름은 펼칠 때 만든다(거대한 리터럴 없음). 파일 내용은 경로에서 만들어 낸다. 목 파일 시스템은 대소문자를
// 구분한다 (macOS 의 실제 파일 시스템과 다르다)

import { IpcClientError } from '../client';
import type {
  FsDirListing,
  FsEditableFile,
  FsEntry,
  FsEntryKind,
  FsFile,
  FsImage,
  FsSaveResult,
} from '../types';
import { pick } from './mock-l10n';

/** 나열 항목 수 기본 상한 (코어 `FS_LIST_DEFAULT_LIMIT`) */
export const MOCK_FS_LIST_DEFAULT_LIMIT = 2_000;
/** 나열 항목 수 상한의 최댓값 (코어 `FS_LIST_MAX_LIMIT`) */
export const MOCK_FS_LIST_MAX_LIMIT = 50_000;
/** 읽기 크기 상한 (코어 `FS_READ_MAX_BYTES`) */
export const MOCK_FS_READ_MAX_BYTES = 1024 * 1024;
/** 상대 경로 길이 상한 (코어 `REL_PATH_MAX_BYTES`·`REL_PATH_COMPONENT_MAX_BYTES`) */
const REL_PATH_MAX_BYTES = 4096;
const COMPONENT_MAX_BYTES = 255;

/** 수정 시각의 기준 (장면 데이터의 기준 시각과 같다, 밀리초) */
const BASE_MS = 1_761_600_000_000;

/** 디렉터리 노드. 자식은 처음 볼 때 만든다 */
interface MockDir {
  kind: 'dir';
  mtimeMs: number;
  /** 참이면 나열·통과가 "권한 없음" */
  denied: boolean;
  entries(): Map<string, MockNode>;
}

/** 파일 노드. 읽은 결과는 읽을 때 만든다 */
interface MockFile {
  kind: 'file';
  mtimeMs: number;
  size: number;
  read(): FsFile;
  image?: Extract<FsImage, { kind: 'image' }>;
}

/** 링크·FIFO·소켓 등 (내용 없음) */
interface MockSpecial {
  kind: 'symlink' | 'other';
  mtimeMs: number;
}

type MockNode = MockDir | MockFile | MockSpecial;

/** 저장소 하나의 작업 트리 파일 (작업 트리 기준 상대 경로) */
export interface MockFsRepo {
  name: string;
  files: readonly string[];
}

/** 장면이 정하는 파일 배치 */
export interface MockFsLayout {
  /**
   * 폴더 장면: 폴더 경로와 그 아래 저장소 디렉터리들. `logs` 는 `logs/` 의 항목 수(기본 2,400), `bigFileKiB` 를 주면
   * `samples/` 에 그 크기의 텍스트 파일을 둔다 (화면 측정용 크기 조절값)
   */
  folder: {
    path: string;
    repos: readonly MockFsRepo[];
    logs?: number;
    bigFileKiB?: number;
  } | null;
  /**
   * 저장소 장면들의 작업 트리 (모든 상태 표본을 함께 깐다). `dirs` 는 파일 없이 빈 채로 둘 디렉터리 (미초기화 서브모듈 등,
   * W25)
   */
  repos: readonly { path: string; files: readonly string[]; dirs?: readonly string[] }[];
  /** 배치에 없는 경로를 저장소로 열었을 때 깔 파일 */
  fallbackFiles: readonly string[];
}

/** 목 파일 API. 루트는 호출자가 세션에서 정한 경로다 */
export interface MockFs {
  list(root: string, dir: string, limit?: number | null): FsDirListing;
  read(root: string, path: string): FsFile;
  readImage(root: string, path: string): FsImage;
  readEditable(root: string, path: string): FsEditableFile;
  save(root: string, path: string, expectedRevision: string, text: string): FsSaveResult;
  /** 파일·링크 하나를 지운다 (Rollback 흉내). 디렉터리나 없는 경로는 그대로 둔다 */
  remove(root: string, path: string): void;
}

// ── 경로 검증 (코어와 같은 순서·문구) ─────────────────────────────────────────────

/** UTF-8 바이트 길이 */
function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * 거부 오류: 코어처럼 `internal` 이고 요청한 상대 경로(앞 200 글자)와 사유만 싣는다. 사유는 한국어·영어 쌍으로 받아
 * 화면 언어의 것을 쓴다 (코어 `RelPathError`·`fs_tree` 의 문구)
 */
function rejected(request: string, ko: string, en: string): IpcClientError {
  const shown = JSON.stringify([...request].slice(0, 200).join(''));
  return new IpcClientError({
    kind: 'internal',
    message: pick(
      `파일 경로를 거부했습니다 (${ko}): ${shown}`,
      `Rejected file path (${en}): ${shown}`,
    ),
  });
}

/** ASCII 대소문자만 무시하고 `.git` 인지 (코어 `is_dot_git`) */
function isDotGit(name: string): boolean {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase()) === '.git';
}

/** 어휘 검증 (코어 `RelPath::parse`): 통과하면 구성요소 목록 */
function parseRel(request: string): string[] {
  if (request === '') {
    throw rejected(request, '빈 경로', 'Empty path');
  }
  if (request.includes('\0')) {
    throw rejected(request, '경로에 NUL 문자가 있습니다', 'Path contains a NUL character');
  }
  if (utf8Length(request) > REL_PATH_MAX_BYTES) {
    throw rejected(request, '경로가 너무 깁니다', 'Path is too long');
  }
  if (request.startsWith('/')) {
    throw rejected(request, '절대 경로는 쓸 수 없습니다', 'Absolute paths are not allowed');
  }
  const parts = request.split('/');
  for (const part of parts) {
    if (part === '') {
      throw rejected(request, '빈 구성요소가 있습니다', 'Path has an empty component');
    }
    if (utf8Length(part) > COMPONENT_MAX_BYTES) {
      throw rejected(request, '구성요소가 너무 깁니다', 'Path component is too long');
    }
    if (part === '.') {
      throw rejected(request, '`.` 구성요소는 쓸 수 없습니다', '`.` components are not allowed');
    }
    if (part === '..') {
      throw rejected(request, '`..` 구성요소는 쓸 수 없습니다', '`..` components are not allowed');
    }
    if (isDotGit(part)) {
      throw rejected(request, '`.git` 안은 다루지 않습니다', 'Paths inside `.git` are not allowed');
    }
  }
  return parts;
}

/** 구성요소를 따라 내려간다. 중간의 링크는 거부, 중간이 디렉터리가 아니면 없음, 권한 없는 디렉터리는 막힘 */
function walk(
  root: MockDir,
  parts: readonly string[],
  request: string,
): MockNode | 'missing' | 'denied' {
  let node: MockNode = root;
  for (const [i, name] of parts.entries()) {
    if (node.kind !== 'dir') {
      return 'missing';
    }
    if (node.denied) {
      return 'denied';
    }
    const child = node.entries().get(name);
    if (!child) {
      return 'missing';
    }
    if (i + 1 < parts.length && child.kind === 'symlink') {
      throw rejected(
        request,
        '경로 중간에 심볼릭 링크가 있습니다',
        'Symbolic link in the middle of the path',
      );
    }
    node = child;
  }
  return node;
}

/** 정렬 (코어 `SortKey`): 디렉터리 먼저 → 소문자 이름 → 원래 이름. JS 는 UTF-16 단위로 비교하므로
 * 보조 평면 문자와 U+E000 이상 문자의 상대 순서만 코어(UTF-8 바이트 순서)와 다를 수 있다 */
function compareEntries(a: [string, MockNode], b: [string, MockNode]): number {
  const dirA = a[1].kind === 'dir' ? 0 : 1;
  const dirB = b[1].kind === 'dir' ? 0 : 1;
  if (dirA !== dirB) {
    return dirA - dirB;
  }
  const la = a[0].toLowerCase();
  const lb = b[0].toLowerCase();
  if (la !== lb) {
    return la < lb ? -1 : 1;
  }
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
}

/** 나열 항목 하나. 이름이 구성요소 상한을 넘는 파일은 다시 요청할 수 없어 열 수 없다 (코어와 같다) */
function entryOf(name: string, node: MockNode): FsEntry {
  const kind: FsEntryKind = node.kind;
  return {
    name,
    kind,
    size: node.kind === 'file' ? node.size : null,
    mtimeMs: node.mtimeMs,
    openable: node.kind === 'file' && utf8Length(name) <= COMPONENT_MAX_BYTES,
  };
}

/** 상한을 1~최댓값으로 맞춘다 (없으면 기본값) */
function clampLimit(limit: number | null | undefined): number {
  const wanted =
    limit === null || limit === undefined || !Number.isFinite(limit)
      ? MOCK_FS_LIST_DEFAULT_LIMIT
      : Math.trunc(limit);
  return Math.min(Math.max(wanted, 1), MOCK_FS_LIST_MAX_LIMIT);
}

// ── 노드·내용 생성 ────────────────────────────────────────────────────────────────

/** 문자열 해시 (FNV-1a). 수정 시각·내용을 경로마다 다르게 하되 결정적으로 */
function hashOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** 경로의 수정 시각: 기준 시각에서 최대 30일 전 */
function mtimeOf(path: string): number {
  return BASE_MS - (hashOf(path) % (30 * 24 * 60)) * 60_000;
}

/** 자식을 처음 볼 때 만드는 디렉터리 */
function lazyDir(path: string, build: () => Map<string, MockNode>, denied = false): MockDir {
  let cache: Map<string, MockNode> | null = null;
  return {
    kind: 'dir',
    mtimeMs: mtimeOf(path),
    denied,
    entries() {
      cache ??= build();
      return cache;
    },
  };
}

/** 텍스트 파일 노드: 내용은 경로에서 만들고 크기는 그 UTF-8 바이트 수다 */
function textFile(path: string, body: (path: string) => string = sourceText): MockFile {
  const text = body(path);
  return {
    kind: 'file',
    mtimeMs: mtimeOf(path),
    size: utf8Length(text),
    read: () => ({ kind: 'text', text, size: utf8Length(text) }),
  };
}

/** 본문 없이 상태만 주는 파일 노드 (바이너리·UTF-8 아님·너무 큼·읽는 순간 사라짐) */
function stateFile(
  path: string,
  size: number,
  state: 'binary' | 'notUtf8' | 'tooLarge' | 'vanished',
): MockFile {
  const read = (): FsFile => {
    switch (state) {
      case 'binary':
        return { kind: 'binary', size };
      case 'notUtf8':
        return { kind: 'notUtf8', size };
      case 'tooLarge':
        return { kind: 'tooLarge', size, limit: MOCK_FS_READ_MAX_BYTES };
      case 'vanished':
        return { kind: 'missing' };
    }
  };
  return { kind: 'file', mtimeMs: mtimeOf(path), size, read };
}

/** 실제 PNG 바이트가 있는 이미지 표본을 만든다. 파일 조회에서는 바이너리다. */
function imageFile(path: string): MockFile {
  const data =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const size = 68;
  return {
    kind: 'file',
    mtimeMs: mtimeOf(path),
    size,
    read: () => ({ kind: 'binary', size }),
    image: { kind: 'image', mime: 'image/png', dataUrl: `data:image/png;base64,${data}`, size },
  };
}

/** 링크·소켓 노드 */
function special(path: string, kind: 'symlink' | 'other'): MockSpecial {
  return { kind, mtimeMs: mtimeOf(path) };
}

/** 확장자 */
function extOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

/** 확장자를 뗀 파일 이름 */
function stemOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** 경로에 맞는 그럴듯한 소스 내용 (짧다) */
function sourceText(path: string): string {
  const stem = stemOf(path);
  const ident =
    stem.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')) ||
    'value';
  switch (extOf(path)) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'mjs':
      return [
        `// ${path}`,
        "import { compute } from '../lib/compute';",
        '',
        `export function ${ident}(input: number): number {`,
        '  const value = compute(input);',
        '  return Math.round(value * 100) / 100;',
        '}',
        '',
      ].join('\n');
    case 'java':
    case 'kt':
      return [
        `// ${path}`,
        'package com.acme;',
        '',
        `public class ${ident.charAt(0).toUpperCase()}${ident.slice(1)} {`,
        '    public int handle(int input) {',
        '        return input * 2;',
        '    }',
        '}',
        '',
      ].join('\n');
    case 'json':
      return `${JSON.stringify({ name: stem, version: '1.4.2', private: true }, null, 2)}\n`;
    case 'yaml':
    case 'yml':
      return `# ${path}\nname: ${stem}\nlimits:\n  requestsPerMinute: 600\n  burst: 50\n`;
    case 'sql':
      return `-- ${path}\nALTER TABLE orders ADD COLUMN exported_at TIMESTAMP NULL;\n`;
    case 'css':
      return `/* ${path} */\n.root {\n  display: flex;\n  gap: var(--space-2);\n}\n`;
    case 'md':
      return `# ${stem}\n\n${path} 문서입니다. 작업 방식과 결정 사항을 정리해 둡니다.\n`;
    default:
      return `${path}\n`;
  }
}

/** 수백 줄짜리 문서 (긴 텍스트 표본) */
function longMarkdown(title: string, sections: number): (path: string) => string {
  return () => {
    const lines = [`# ${title}`, ''];
    for (let s = 1; s <= sections; s += 1) {
      lines.push(`## ${s}. 변경 묶음 ${s}`, '');
      for (let i = 1; i <= 12; i += 1) {
        lines.push(`- 항목 ${s}.${i}: 주문·결제 흐름의 ${i}번째 개선 사항을 정리했습니다.`);
      }
      lines.push('');
    }
    return lines.join('\n');
  };
}

/** 한글 본문 */
function koreanNote(path: string): string {
  return `# ${stemOf(path)}\n\n- 참석: 한도윤, 서하린, 윤채아\n- 결정: 다음 배포는 금요일 오전\n- 할 일: 장바구니 합계 반올림 재검토\n`;
}

/** 경로 → 노드 목록으로 트리를 만든다. 중간 디렉터리는 자동으로 생긴다 (뒤의 같은 경로가 앞을 덮는다) */
function treeFrom(path: string, nodes: Iterable<[string, MockNode]>): MockDir {
  const root = lazyDir(path, () => new Map());
  for (const [rel, node] of nodes) {
    const parts = rel.split('/');
    let map = root.entries();
    let at = path;
    for (const part of parts.slice(0, -1)) {
      at = `${at}/${part}`;
      let next = map.get(part);
      if (next?.kind !== 'dir') {
        next = lazyDir(at, () => new Map());
        map.set(part, next);
      }
      map = next.entries();
    }
    map.set(parts[parts.length - 1] ?? rel, node);
  }
  return root;
}

/** 항목이 `count` 개인 디렉터리 (펼칠 때 이름을 만든다). 하위 디렉터리 두 개가 이름과 무관하게 앞에 온다 */
function bigDir(path: string, count: number, name: (i: number) => string): MockDir {
  return lazyDir(path, () => {
    const map = new Map<string, MockNode>();
    for (const sub of ['archive', 'rotated']) {
      map.set(
        sub,
        lazyDir(
          `${path}/${sub}`,
          () => new Map([['README.md', textFile(`${path}/${sub}/README.md`)]]),
        ),
      );
    }
    for (let i = 0; i < count; i += 1) {
      const file = name(i);
      map.set(
        file,
        textFile(`${path}/${file}`, () => `${file}\n`),
      );
    }
    return map;
  });
}

/** 권한 없는 디렉터리 */
function deniedDir(path: string): MockDir {
  return lazyDir(
    path,
    () => new Map([['credentials.json', textFile(`${path}/credentials.json`)]]),
    true,
  );
}

/** 저장소 작업 트리에 늘 있는 파일 */
function repoBasics(name: string): [string, MockNode][] {
  return [
    ['README.md', textFile('README.md', longMarkdown(name, 26))],
    ['.gitignore', textFile('.gitignore', () => 'node_modules/\ndist/\n.env\n')],
    [
      '.editorconfig',
      textFile('.editorconfig', () => 'root = true\n\n[*]\nindent_style = space\n'),
    ],
    ['.github/workflows/ci.yml', textFile('.github/workflows/ci.yml')],
    ['package.json', textFile('package.json')],
  ];
}

/** 저장소 장면의 상태 표본: 바이너리·너무 큼·UTF-8 아님·링크·읽는 순간 사라짐·소켓·긴 문서·한글 이름 */
function repoShowcase(): [string, MockNode][] {
  return [
    ['public/images/logo.png', imageFile('public/images/logo.png')],
    ['dist/app.js.map', stateFile('dist/app.js.map', 3_482_113, 'tooLarge')],
    ['legacy/주문내역-euc-kr.csv', stateFile('legacy/주문내역-euc-kr.csv', 2_816, 'notUtf8')],
    ['config/current.json', special('config/current.json', 'symlink')],
    ['config/production.json', textFile('config/production.json')],
    ['logs/dev.log', stateFile('logs/dev.log', 40_960, 'vanished')],
    ['.cache/devserver.sock', special('.cache/devserver.sock', 'other')],
    ['CHANGELOG.md', textFile('CHANGELOG.md', longMarkdown('Changelog', 34))],
    [
      'docs/회의록/2026-11-18 주간 회의.md',
      textFile('docs/회의록/2026-11-18 주간 회의.md', koreanNote),
    ],
  ];
}

/** 저장소 작업 트리. `showcase` 면 상태 표본·잘리는 디렉터리(`src/generated/icons`, 2,347개)·권한 없는
 * 디렉터리(`secrets/`)를 함께 깐다. `emptyDirs` 는 빈 디렉터리로 둔다 (그 아래 파일이 없어야 한다 — 같은 경로는 뒤가 덮는다) */
function repoTree(
  path: string,
  name: string,
  files: readonly string[],
  showcase: boolean,
  emptyDirs: readonly string[] = [],
): MockDir {
  const icons = 'src/generated/icons';
  return treeFrom(path, [
    ...repoBasics(name),
    ...files.map((file): [string, MockNode] => [file, textFile(file)]),
    ...emptyDirs.map((dir): [string, MockNode] => [
      dir,
      lazyDir(`${path}/${dir}`, () => new Map()),
    ]),
    ...(showcase
      ? [
          ...repoShowcase(),
          [icons, bigDir(`${path}/${icons}`, 2_345, (i) => `ic-${String(i).padStart(4, '0')}.svg`)],
          ['secrets', deniedDir(`${path}/secrets`)],
        ]
      : []),
  ] as [string, MockNode][]);
}

/** 폴더 장면의 상태 표본 (`samples/` 아래) */
function folderSamples(): [string, MockNode][] {
  return [
    ['samples/logo.png', imageFile('samples/logo.png')],
    ['samples/heap-dump.hprof', stateFile('samples/heap-dump.hprof', 48_234_496, 'tooLarge')],
    ['samples/legacy-euc-kr.csv', stateFile('samples/legacy-euc-kr.csv', 2_816, 'notUtf8')],
    ['samples/current', special('samples/current', 'symlink')],
    ['samples/vanished.log', stateFile('samples/vanished.log', 40_960, 'vanished')],
    ['samples/agent.sock', special('samples/agent.sock', 'other')],
    [
      'samples/release-notes.md',
      textFile('samples/release-notes.md', longMarkdown('Release notes', 30)),
    ],
    ['samples/주간 보고 2026-11-18.md', textFile('samples/주간 보고 2026-11-18.md', koreanNote)],
  ];
}

/** 기본 `logs/` 항목 수 (기본 상한 2,000 을 넘어 "더 보기" 가 나온다) */
const DEFAULT_LOG_ENTRIES = 2_400;

/**
 * 큰 로그 파일 본문: 번호 붙은 짧은 줄을 `kib` KiB (읽기 상한 1 MiB 를 넘지 않게)까지 채운다. 1,024 KiB 면 약 3.3만 줄
 */
function bigLog(kib: number): (path: string) => string {
  return () => {
    const limit = Math.min(kib * 1024, MOCK_FS_READ_MAX_BYTES);
    const lines: string[] = [];
    let size = 0;
    for (let i = 1; ; i += 1) {
      const line = `${String(i).padStart(6, '0')} INFO order ${String(i * 7).padStart(7, '0')} ok\n`;
      if (size + line.length > limit) {
        break;
      }
      lines.push(line);
      size += line.length;
    }
    return lines.join('');
  };
}

/**
 * 폴더 장면의 트리: 점 폴더·문서·상태 표본, 저장소 디렉터리들, 잘리는 `logs/`(항목 `logs` 개), 권한 없는 `private/`.
 * `bigFileKiB` 를 주면 `samples/big-<N>k.log` 를 더한다
 */
function folderTree(
  path: string,
  repos: readonly MockFsRepo[],
  logs = DEFAULT_LOG_ENTRIES,
  bigFileKiB = 0,
): MockDir {
  const big = `samples/big-${bigFileKiB}k.log`;
  const root = treeFrom(path, [
    ...(bigFileKiB > 0 ? [[big, textFile(big, bigLog(bigFileKiB))] as [string, MockNode]] : []),
    ['.github/pull_request_template.md', textFile('.github/pull_request_template.md')],
    ['.github/CODEOWNERS', textFile('.github/CODEOWNERS', () => '* @acme/platform\n')],
    ['.vscode/settings.json', textFile('.vscode/settings.json')],
    ['.editorconfig', textFile('.editorconfig', () => 'root = true\n')],
    ['README.md', textFile('README.md', longMarkdown('acme-platform', 25))],
    [
      'acme-platform.code-workspace',
      textFile('acme-platform.code-workspace', () => '{\n  "folders": []\n}\n'),
    ],
    ['docs/architecture/overview.md', textFile('docs/architecture/overview.md')],
    [
      'docs/onboarding/개발 환경 설정.md',
      textFile('docs/onboarding/개발 환경 설정.md', koreanNote),
    ],
    ...folderSamples(),
  ]);
  const top = root.entries();
  for (const repo of repos) {
    const at = `${path}/${repo.name}`;
    top.set(
      repo.name,
      lazyDir(at, () => repoTree(at, repo.name, repo.files, false).entries()),
    );
  }
  top.set(
    'logs',
    bigDir(`${path}/logs`, logs, (i) => `request-${String(i).padStart(5, '0')}.log`),
  );
  top.set('private', deniedDir(`${path}/private`));
  return root;
}

/** 목 파일 API 를 만든다. 루트별 트리는 처음 쓸 때 만든다 */
export function createMockFs(layout: MockFsLayout): MockFs {
  const roots = new Map<string, MockDir>();
  const folder = layout.folder;

  /** 루트 경로의 트리: 폴더, 폴더 안 저장소(폴더 트리의 그 디렉터리), 저장소 장면, 그 밖은 기본 저장소 */
  const rootOf = (root: string): MockDir => {
    const known = roots.get(root);
    if (known) {
      return known;
    }
    let tree: MockDir | null = null;
    if (folder && root === folder.path) {
      tree = folderTree(folder.path, folder.repos, folder.logs, folder.bigFileKiB);
    } else if (folder && root.startsWith(`${folder.path}/`)) {
      const name = root.slice(folder.path.length + 1);
      const node = rootOf(folder.path).entries().get(name);
      tree = node?.kind === 'dir' ? node : null;
    }
    if (!tree) {
      const repo = layout.repos.find((r) => r.path === root);
      const name = root.slice(root.lastIndexOf('/') + 1);
      tree = repoTree(root, name, repo?.files ?? layout.fallbackFiles, true, repo?.dirs);
    }
    roots.set(root, tree);
    return tree;
  };

  let nextRevision = 0;
  const revisions = new WeakMap<MockNode, string>();
  /** 실제 트리를 공유하는 저장소·폴더는 같은 노드 revision과 경로 키를 사용한다. */
  const editable = (root: string, path: string): FsEditableFile => {
    const node = walk(rootOf(root), parseRel(path), path);
    if (typeof node === 'string') return { kind: node };
    if (node.kind !== 'file') return { kind: 'unsupported', fileKind: node.kind };
    const file = node.read();
    if (file.kind !== 'text') return file;
    if (file.text.includes('\0')) return { kind: 'binary', size: file.size };
    const plain = file.text.replaceAll('\r\n', '');
    if (plain.includes('\r') || (file.text.includes('\r\n') && plain.includes('\n')))
      return { kind: 'mixedLineEndings' };
    let revision = revisions.get(node);
    if (!revision) {
      revision = `mock-${++nextRevision}`;
      revisions.set(node, revision);
    }
    return {
      ...file,
      fileKey: `${root}/${path}`,
      revision,
      lineEnding: file.text.includes('\r\n') ? 'crlf' : 'lf',
      bom: file.text.startsWith('\ufeff'),
    };
  };

  return {
    list(root, dir, limit) {
      const parts = dir === '' ? [] : parseRel(dir);
      const node = walk(rootOf(root), parts, dir);
      if (node === 'missing' || node === 'denied') {
        return { kind: node };
      }
      if (node.kind === 'symlink') {
        throw rejected(dir, '심볼릭 링크는 나열하지 않습니다', 'Symbolic links are not listed');
      }
      if (node.kind !== 'dir') {
        return { kind: 'missing' };
      }
      if (node.denied) {
        return { kind: 'denied' };
      }
      const sorted = [...node.entries()].sort(compareEntries);
      const cap = clampLimit(limit);
      return {
        kind: 'listed',
        entries: sorted.slice(0, cap).map(([name, child]) => entryOf(name, child)),
        total: sorted.length,
        truncated: sorted.length > cap,
        nonUtf8Names: 0,
      };
    },
    read(root, path) {
      const node = walk(rootOf(root), parseRel(path), path);
      if (node === 'missing' || node === 'denied') {
        return { kind: node };
      }
      return node.kind === 'file' ? node.read() : { kind: 'unsupported', fileKind: node.kind };
    },
    readImage(root, path) {
      const node = walk(rootOf(root), parseRel(path), path);
      if (typeof node === 'string') return { kind: node };
      if (node.kind !== 'file') return { kind: 'unsupported' };
      if (node.size > 5 * 1024 * 1024)
        return { kind: 'tooLarge', size: node.size, limit: 5 * 1024 * 1024 };
      const state = node.read();
      if (state.kind === 'missing' || state.kind === 'denied') return state;
      return node.image ?? { kind: 'unsupported' };
    },
    readEditable: editable,
    save(root, path, expectedRevision, text) {
      const current = editable(root, path);
      if (current.kind !== 'text' || current.revision !== expectedRevision)
        return { kind: 'conflict' };
      if (utf8Length(text) > MOCK_FS_READ_MAX_BYTES)
        return { kind: 'failed', message: 'File exceeds 1 MiB' };
      const plain = text.replaceAll('\r\n', '');
      if (
        text.includes('\0') ||
        plain.includes('\r') ||
        (text.includes('\r\n') && plain.includes('\n'))
      )
        return { kind: 'failed', message: 'Unsupported text format' };
      const node = walk(rootOf(root), parseRel(path), path);
      if (typeof node === 'string' || node.kind !== 'file') return { kind: 'conflict' };
      node.size = utf8Length(text);
      node.mtimeMs += 1;
      node.read = () => ({ kind: 'text', text, size: node.size });
      const revision = `mock-${++nextRevision}`;
      revisions.set(node, revision);
      return { kind: 'saved', revision };
    },
    remove(root, path) {
      const parts = parseRel(path);
      const name = parts.pop();
      const parent = walk(rootOf(root), parts, path);
      if (name === undefined || typeof parent === 'string' || parent.kind !== 'dir') {
        return;
      }
      const map = parent.entries();
      if (map.get(name)?.kind !== 'dir') {
        map.delete(name);
      }
    },
  };
}
