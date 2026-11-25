import { isMarkdownPath } from '@mgit/diff-view';
export type MarkdownMode = 'edit' | 'preview' | 'split';
export interface MarkdownViewState {
  mode: MarkdownMode;
  ratio: number;
  scrollTop: number;
}
const views = new Map<string, MarkdownViewState>();

/** 탭이 닫혀도 실행 중 파일별 보기 설정과 스크롤을 보관한다. */
export function markdownViewState(fileKey: string): MarkdownViewState {
  let state = views.get(fileKey);
  if (!state) {
    state = { mode: 'edit', ratio: 50, scrollTop: 0 };
    views.set(fileKey, state);
  }
  return state;
}

/** Markdown 확장자에만 현재 초안 미리보기를 제공한다. */
export function isMarkdown(path: string): boolean {
  return isMarkdownPath(path);
}

/** 문서 디렉터리를 기준으로 정규화하되 루트 탈출·절대 경로·Git 내부 경로는 거부한다. */
export function localImagePath(documentPath: string, source: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(source.split(/[?#]/, 1)[0] ?? '');
  } catch {
    return null;
  }
  if (!decoded || /^(?:\/|\\|[a-z][a-z\d+.-]*:)/i.test(decoded) || /[\\\0]/.test(decoded))
    return null;
  const parts = documentPath.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else {
      if (part.toLowerCase() === '.git') return null;
      parts.push(part);
    }
  }
  return parts.length ? parts.join('/') : null;
}
