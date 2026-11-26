import type {
  ReplacePattern,
  ReplacePreview,
  ReplaceQuery,
  WorkspaceSearchQuery,
  WorkspaceSearchResult,
} from '../types';
import type { MockFs } from './mock-fs';

/**
 * 목 파일 트리의 열 수 있는 파일을 너비 우선으로 하나씩 넘긴다(디렉터리 2,000개까지, `.git`·`node_modules`·`target`
 * 제외). 읽지 못한 디렉터리는 `counts.skipped` 에 센다. 내용 검색과 빠른 열기 목록이 같은 후보를 보도록 둘 다 쓴다
 */
function* mockCandidates(fs: MockFs, root: string, counts: { skipped: number }): Generator<string> {
  const queue = [''];
  for (let n = 0; n < queue.length && n < 2000; n++) {
    const dir = queue[n] ?? '';
    const listing = fs.list(root, dir, 50000);
    if (listing.kind !== 'listed') {
      counts.skipped++;
      continue;
    }
    for (const e of listing.entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'target') continue;
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === 'dir') {
        queue.push(path);
        continue;
      }
      if (e.kind === 'file' && e.openable) yield path;
    }
  }
}

/** 실제 목 파일 트리를 순회해 검색 화면에 같은 파일을 돌려준다. */
export function mockWorkspaceSearch(
  fs: MockFs,
  root: string,
  q: WorkspaceSearchQuery,
): WorkspaceSearchResult {
  const out: WorkspaceSearchResult = { hits: [], skipped: 0, cancelled: false, truncated: false };
  const match = new RegExp(
    q.regex && q.content ? q.text : q.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    q.caseSensitive ? '' : 'i',
  );
  for (const path of mockCandidates(fs, root, out)) {
    if (
      (q.scope && !path.startsWith(`${q.scope}/`)) ||
      !path.toLowerCase().includes(q.pathFilter.toLowerCase())
    )
      continue;
    if (!q.content) {
      if (match.test(path))
        out.hits.push({
          path,
          repo: path.includes('/') ? (path.split('/')[0] ?? '') : '',
          line: 1,
          column: 1,
          text: '',
        });
    } else if (q.text) {
      const f = fs.read(root, path);
      if (f.kind !== 'text') {
        out.skipped++;
        continue;
      }
      const text = q.drafts.find((d) => d.path === path)?.text ?? f.text;
      for (const [i, line] of text.split('\n').entries()) {
        const m = match.exec(line);
        if (m)
          out.hits.push({
            path,
            repo: path.includes('/') ? (path.split('/')[0] ?? '') : '',
            line: i + 1,
            column: m.index + 1,
            text: line,
          });
      }
    }
    if (out.hits.length >= 2000) {
      out.hits = out.hits.slice(0, 2000);
      out.truncated = true;
      return out;
    }
  }
  return out;
}

/** 목 바꾸기의 줄 일치: 바뀔 글자와 UTF-16 위치 */
interface MockHit {
  start: number;
  end: number;
  replacement: string;
}

/**
 * 목 바꾸기 도구: 코어와 같은 줄 단위 규칙(BOM 은 첫 줄 본문에서 빼고, 줄 끝은 그대로)을 JS 정규식으로 흉내 낸다. 묶음
 * 문법은 `$1`·`$$` 가 같고 `$0`·`${name}` 은 다르다 (목 전용)
 */
function mockReplacer(pattern: ReplacePattern) {
  const source = pattern.regex ? pattern.text : pattern.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags = pattern.caseSensitive ? 'gu' : 'giu';
  /** 줄 본문 하나의 일치 */
  const hits = (body: string): MockHit[] =>
    [...body.matchAll(new RegExp(source, flags))].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      replacement: pattern.regex
        ? m[0].replace(new RegExp(source, flags.replace('g', '')), pattern.replacement)
        : pattern.replacement,
    }));
  /** (본문, 줄 끝) 목록. BOM 은 본문에서 뺀다 */
  const lines = (text: string): [string, string][] =>
    (text.replace(/^﻿/, '').match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line) =>
      line.endsWith('\r\n')
        ? [line.slice(0, -2), '\r\n']
        : line.endsWith('\n')
          ? [line.slice(0, -1), '\n']
          : [line, ''],
    );
  return { hits, lines };
}

/** 목 바꾸기 적용: 뺀 순번의 일치를 남기고 나머지를 바꾼 원문과 바꾼 수 */
export function mockReplaceText(
  text: string,
  pattern: ReplacePattern,
  excluded: ReadonlySet<number>,
): { text: string; replaced: number } {
  const r = mockReplacer(pattern);
  let out = text.startsWith('﻿') ? '﻿' : '';
  let index = 0;
  let replaced = 0;
  for (const [body, eol] of r.lines(text)) {
    let last = 0;
    for (const hit of r.hits(body)) {
      if (!excluded.has(index)) {
        out += body.slice(last, hit.start) + hit.replacement;
        last = hit.end;
        replaced++;
      }
      index++;
    }
    out += body.slice(last) + eol;
  }
  return { text: out, replaced };
}

/**
 * 목 바꾸기 미리보기: 내용 검색과 같은 후보에서 바뀌는 줄을 모은다(파일마다 10줄, 긴 줄은 자르지 않는다). 초안·줄 끝
 * 혼합·저장소 밖(`repoOf` 가 null) 파일은 사유와 함께 뺀다
 */
export function mockReplacePreview(
  fs: MockFs,
  root: string,
  q: ReplaceQuery,
  repoOf: (path: string) => string | null,
): ReplacePreview {
  const out: ReplacePreview = {
    files: [],
    excluded: [],
    unreadable: 0,
    truncated: false,
    cancelled: false,
  };
  if (!q.pattern.text) throw { kind: 'internal', message: 'Enter the text to find' };
  const r = mockReplacer(q.pattern);
  const counts = { skipped: 0 };
  for (const path of mockCandidates(fs, root, counts)) {
    if (
      (q.scope && !path.startsWith(`${q.scope}/`)) ||
      !path.toLowerCase().includes(q.pathFilter.toLowerCase())
    )
      continue;
    const file = fs.readEditable(root, path);
    if (file.kind !== 'text' && file.kind !== 'mixedLineEndings') {
      out.unreadable++;
      continue;
    }
    const lines = r.lines(file.text).map(([body]) => r.hits(body));
    if (!lines.some((hits) => hits.length > 0)) continue;
    const repo = repoOf(path);
    const reason = q.drafts.includes(path)
      ? 'draft'
      : repo === null
        ? 'outsideRepository'
        : file.kind === 'mixedLineEndings'
          ? 'mixedLineEndings'
          : null;
    if (reason) {
      out.excluded.push({ path, reason });
      continue;
    }
    const bodies = r.lines(file.text).map(([body]) => body);
    let index = 0;
    let hiddenLines = 0;
    const shown: ReplacePreview['files'][number]['lines'] = [];
    for (const [n, hits] of lines.entries()) {
      if (hits.length === 0) continue;
      if (shown.length < 10)
        shown.push({
          line: n + 1,
          text: bodies[n] ?? '',
          cutStart: false,
          cutEnd: false,
          matches: hits.map((hit, i) => ({ index: index + i, ...hit })),
          hidden: 0,
        });
      else hiddenLines++;
      index += hits.length;
    }
    out.files.push({
      path,
      repo,
      revision: file.revision,
      matches: index,
      lines: shown,
      hiddenLines,
    });
  }
  out.unreadable += counts.skipped;
  return out;
}

/** 빠른 열기용 목 파일 목록: 내용 검색과 같은 후보를 코어처럼 정렬해 돌려준다(저장소 목록은 호출자가 채운다). */
export function mockWorkspaceFiles(
  fs: MockFs,
  root: string,
): { files: string[]; skipped: number; truncated: boolean } {
  const counts = { skipped: 0 };
  const files = [...mockCandidates(fs, root, counts)].sort();
  return { files, skipped: counts.skipped, truncated: false };
}
