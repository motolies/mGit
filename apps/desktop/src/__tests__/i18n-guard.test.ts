// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 한글 리터럴 가드 (다국어 L2): 화면 문구는 언어별 사전(`S`)에만 두므로, 비테스트 TS/TSX 소스에서 주석을 걷어 낸 뒤
// 한글이 남아 있으면 사전 밖에 하드코딩한 문구다. 문자열 리터럴뿐 아니라 JSX 글자도 잡히도록 "주석 밖 한글 전부"를 본다.

/** 저장소 루트 (이 파일은 `apps/desktop/src/__tests__/`) */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** 한글 자모·음절 */
const HANGUL = /[ㄱ-ㆎ가-힣]/;

/** 한글이 있어도 되는 파일 (저장소 루트 기준 경로 → 사유) */
const EXEMPT_FILES: ReadonlyMap<string, string> = new Map([
  ['packages/ui/src/i18n/ko.ts', '한국어 사전'],
  ['packages/ui/src/i18n/language-names.ts', '원어로 쓰는 언어 이름 (모든 사전이 같은 값을 쓴다)'],
  ['packages/ipc/src/bindings.ts', 'Rust 에서 생성한 파일'],
  ['packages/ui/src/contrast.ts', '테스트만 쓰는 대비 계산'],
]);

/** 한글이 있어도 되는 디렉터리 (저장소 루트 기준 접두) */
const EXEMPT_DIRS: readonly string[] = ['packages/ipc/src/mock/'];

/** 정규식 리터럴이 올 수 있는 앞 글자. 그 밖의 글자 뒤 `/` 는 나눗셈이나 JSX 닫는 태그다 (`}` 뒤는 `<A b={c} />`) */
const REGEX_AFTER_CHARS = new Set('(,=:[!&|?{;+-*%~^>'.split(''));

/** 정규식 리터럴이 올 수 있는 앞 낱말 */
const REGEX_AFTER_WORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
  'else',
  'do',
]);

/**
 * TS/TSX 소스의 주석을 공백으로 바꾼 사본을 만든다 (줄바꿈은 남겨 줄 번호를 지킨다). 문자열·템플릿 리터럴(`${…}` 중첩
 * 포함)·정규식 리터럴 안의 `//`·`/*` 는 주석으로 보지 않는다. 완전한 파서가 아닌 작은 스캐너라, 따옴표 문자열과 정규식은
 * 줄을 넘지 않는다고 보고 줄 끝까지 닫히지 않으면 코드로 돌아간다 (JSX 글자 속 `'` 가 뒤 줄을 삼키지 않게)
 */
function stripComments(src: string): string {
  const out: string[] = [];
  // 코드 안의 열린 중괄호: 일반 블록이거나 템플릿 리터럴의 `${`
  const braces: ('block' | 'template')[] = [];
  let i = 0;
  // 정규식/나눗셈 판단용: 코드에서 마지막으로 본 공백 아닌 글자, 그 글자로 끝나는 식별자, 이어 쓰는 중인 식별자
  let prevChar = '';
  let prevWord = '';
  let word = '';

  /** 코드가 아닌 토큰(문자열·정규식·템플릿)을 지난 뒤의 판단 상태 */
  const afterToken = (last: string): void => {
    prevChar = last;
    prevWord = '';
    word = '';
  };

  /** 따옴표 문자열을 닫는 따옴표까지 옮긴다. 줄 끝까지 닫히지 않으면 줄바꿈 앞에서 멈춘다 */
  const copyQuoted = (quote: string): void => {
    out.push(quote);
    i++;
    while (i < src.length) {
      const c = src.charAt(i);
      if (c === '\\') {
        out.push(src.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (c === '\n') {
        break;
      }
      out.push(c);
      i++;
      if (c === quote) {
        break;
      }
    }
    afterToken(quote);
  };

  /** 템플릿 리터럴 본문을 닫는 백틱이나 `${` 까지 옮긴다. `${` 에서 멈추면 그 식은 코드로 읽는다 */
  const copyTemplate = (): void => {
    while (i < src.length) {
      const c = src.charAt(i);
      if (c === '\\') {
        out.push(src.slice(i, i + 2));
        i += 2;
        continue;
      }
      if (c === '`') {
        out.push(c);
        i++;
        afterToken('`');
        return;
      }
      if (c === '$' && src.charAt(i + 1) === '{') {
        out.push('${');
        i += 2;
        braces.push('template');
        afterToken('{');
        return;
      }
      out.push(c);
      i++;
    }
  };

  /** 정규식 리터럴을 닫는 `/` 까지 옮긴다. 같은 줄에서 닫히지 않으면 정규식이 아니었으므로 `/` 하나만 옮긴다 */
  const copyRegex = (): void => {
    let j = i + 1;
    let inClass = false;
    while (j < src.length) {
      const c = src.charAt(j);
      if (c === '\n') {
        break;
      }
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (inClass) {
        inClass = c !== ']';
      } else if (c === '[') {
        inClass = true;
      } else if (c === '/') {
        out.push(src.slice(i, j + 1));
        i = j + 1;
        afterToken('/');
        return;
      }
      j++;
    }
    out.push('/');
    i++;
    afterToken('/');
  };

  while (i < src.length) {
    const c = src.charAt(i);
    const next = src.charAt(i + 1);
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out.push(' '.repeat(stop - i));
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out.push(src.slice(i, stop).replace(/[^\n]/g, ' '));
      i = stop;
      continue;
    }
    if (c === "'" || c === '"') {
      copyQuoted(c);
      continue;
    }
    if (c === '`') {
      out.push(c);
      i++;
      copyTemplate();
      continue;
    }
    if (
      c === '/' &&
      (prevChar === '' || REGEX_AFTER_CHARS.has(prevChar) || REGEX_AFTER_WORDS.has(prevWord))
    ) {
      copyRegex();
      continue;
    }
    if (c === '{') {
      braces.push('block');
    } else if (c === '}' && braces.pop() === 'template') {
      // `${…}` 가 닫혔다: 템플릿 본문으로 돌아간다
      out.push(c);
      i++;
      copyTemplate();
      continue;
    }
    out.push(c);
    i++;
    if (/\s/.test(c)) {
      word = '';
    } else if (/[\w$]/.test(c)) {
      word += c;
      prevChar = c;
      prevWord = word;
    } else {
      afterToken(c);
    }
  }
  return out.join('');
}

/** 저장소 루트 기준 `/` 구분 경로 */
function repoPath(file: string): string {
  return relative(ROOT, file).split(sep).join('/');
}

/** 검사에서 빼는 파일인지: 테스트·목 데이터·생성 파일·한국어 사전 */
function isExempt(path: string): boolean {
  return (
    path.split('/').includes('__tests__') ||
    /\.test\.[cm]?[jt]sx?$/.test(path) ||
    EXEMPT_FILES.has(path) ||
    EXEMPT_DIRS.some((dir) => path.startsWith(dir))
  );
}

/** 디렉터리 아래의 TS/TSX 파일을 모두 모은다 */
function collectSources(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') {
        collectSources(full, out);
      }
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
}

/** 검사할 소스 파일 (저장소 루트 기준 경로): `apps/desktop/src/**`, `packages/<이름>/src/**` 에서 제외 대상을 뺀 것 */
function guardedSources(): string[] {
  const roots = [join(ROOT, 'apps/desktop/src')];
  for (const pkg of readdirSync(join(ROOT, 'packages'), { withFileTypes: true })) {
    const src = join(ROOT, 'packages', pkg.name, 'src');
    if (pkg.isDirectory() && existsSync(src)) {
      roots.push(src);
    }
  }
  const files: string[] = [];
  for (const root of roots) {
    collectSources(root, files);
  }
  return files.map(repoPath).filter((path) => !isExempt(path));
}

describe('stripComments', () => {
  /** 한 줄짜리 소스에서 주석을 걷어 낸 뒤 끝 공백을 지운 결과 */
  const strip = (src: string) => stripComments(src).trimEnd();

  it('줄·블록·JSX 주석을 지우고 줄 수는 지킨다', () => {
    expect(strip('const a = 1; // 주석')).toBe('const a = 1;');
    expect(strip('const a = /* 주석 */ 1;')).toBe('const a =          1;');
    expect(strip('<div>{/* 주석 */}</div>')).toBe('<div>{        }</div>');
    expect(stripComments('a/*\n주석\n*/b').split('\n')).toEqual(['a  ', '  ', '  b']);
  });

  // biome-ignore-start lint/suspicious/noTemplateCurlyInString: 스캐너에 넣을 TS 소스 글자라 `${` 가 그대로 있어야 한다
  it('문자열·템플릿 안의 // 와 /* 는 주석이 아니다', () => {
    expect(strip("const u = 'http://x'; // 주석")).toBe("const u = 'http://x';");
    expect(strip('const u = "a /* b */ c";')).toBe('const u = "a /* b */ c";');
    expect(strip('const t = `x // y ${a /* 주석 */} z // w`;')).toBe(
      'const t = `x // y ${a         } z // w`;',
    );
    // `${…}` 안의 중괄호와 중첩 템플릿
    expect(strip('const t = `a${ {k: `b${c}`}.k }d // e`; // 주석')).toBe(
      'const t = `a${ {k: `b${c}`}.k }d // e`;',
    );
  });
  // biome-ignore-end lint/suspicious/noTemplateCurlyInString: 위 테스트의 끝

  it('정규식 리터럴과 나눗셈, JSX 닫는 태그를 가른다', () => {
    expect(strip('const r = /\\/\\/[/*]/g; // 주석')).toBe('const r = /\\/\\/[/*]/g;');
    expect(strip("return /'/.test(s); // 주석")).toBe("return /'/.test(s);");
    expect(strip('const d = a / b / c; // 주석')).toBe('const d = a / b / c;');
    expect(strip('<A b={c} /> // 주석')).toBe('<A b={c} />');
    expect(strip('<p>x</p> // 주석')).toBe('<p>x</p>');
  });

  it('닫히지 않은 따옴표(JSX 글자 속 아포스트로피)는 다음 줄을 삼키지 않는다', () => {
    expect(stripComments("<p>Don't</p>\n// 주석").split('\n')[1]?.trim()).toBe('');
  });
});

describe('한글 리터럴 가드', () => {
  it('제외 목록의 파일이 실제로 있다 (목록이 낡지 않게)', () => {
    for (const path of [...EXEMPT_FILES.keys(), ...EXEMPT_DIRS]) {
      expect(existsSync(join(ROOT, path)), path).toBe(true);
    }
  });

  it('검사 대상에 앱·패키지 소스와 영어 사전이 들어 있다', () => {
    const files = guardedSources();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('apps/desktop/src/main.tsx');
    expect(files).toContain('packages/ui/src/strings.ts');
    expect(files).toContain('packages/ui/src/i18n/en/tools.ts');
    expect(files).not.toContain('packages/ui/src/i18n/ko.ts');
  });

  it('비테스트 소스의 주석 밖에 한글이 없다 (화면 문구는 사전으로, 개발자용은 영어로)', () => {
    const hits: string[] = [];
    for (const path of guardedSources()) {
      const lines = stripComments(readFileSync(join(ROOT, path), 'utf8')).split('\n');
      for (const [index, line] of lines.entries()) {
        if (HANGUL.test(line)) {
          hits.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
