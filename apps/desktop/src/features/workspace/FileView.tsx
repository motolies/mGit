import { parserFor, type Span, tokenize } from '@mgit/diff-view';
import type { FsFile } from '@mgit/ipc';
import { Button, formatBytes, Icon, type IconName, S } from '@mgit/ui';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import styles from './FileView.module.css';

/** 파일 읽기 상태: 읽는 중 / 받은 결과 / 요청 실패 */
export type FileLoad =
  | { state: 'loading' }
  | { state: 'loaded'; file: FsFile }
  | { state: 'error'; error: string };

/** 줄 높이 (px). 고정 높이라 줄을 재지 않는다 (1 MiB·수만 줄에서도 가상 스크롤이 가볍다) */
const LINE_H = 20;
/** 탭 폭 (칸) */
const TAB_WIDTH = 4;
/** 구문 강조 상한: 줄 수와 글자 수. lezer 파싱은 한 번에 전체를 돌아 큰 파일에서 화면을 멈추게 한다 */
const MAX_HIGHLIGHT_LINES = 5_000;
const MAX_HIGHLIGHT_CHARS = 128 * 1024;

/** 맨 앞의 UTF-8 BOM(U+FEFF)을 뗀다. 뗐는지도 알려 준다 */
export function stripBom(text: string): { text: string; bom: boolean } {
  return text.charCodeAt(0) === 0xfeff ? { text: text.slice(1), bom: true } : { text, bom: false };
}

/** 줄로 나눈다. CRLF·CR·LF 를 모두 줄 끝으로 본다 (줄 끝 글자는 화면에 남지 않는다) */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** 화면에서 두 칸을 차지하는 글자인지 (한글·한자·가나·전각 기호 — 가로 스크롤 폭의 어림) */
function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    code >= 0x1f300
  );
}

/** 가장 긴 줄의 화면 칸 수 (탭은 다음 탭 자리까지, 넓은 글자는 두 칸). 가로 스크롤 폭을 정한다 */
export function maxColumns(lines: readonly string[], tabWidth = TAB_WIDTH): number {
  let max = 0;
  for (const line of lines) {
    // 칸 수가 글자 수를 넘을 수 있는 줄(탭·ASCII 밖 글자)만 한 글자씩 센다
    if (line.length <= max && !/[\t\u0080-￿]/.test(line)) {
      continue;
    }
    let cols = 0;
    for (const ch of line) {
      const code = ch.codePointAt(0) ?? 0;
      cols = code === 9 ? cols + tabWidth - (cols % tabWidth) : cols + (isWide(code) ? 2 : 1);
    }
    max = Math.max(max, cols);
  }
  return max;
}

/** 줄 수 (줄 끝 글자 수 + 1). `splitLines` 의 길이와 같다 */
export function countLines(text: string): number {
  let n = 1;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      n += 1;
    } else if (c === 13) {
      n += 1;
      if (text.charCodeAt(i + 1) === 10) {
        i += 1;
      }
    }
  }
  return n;
}

/** 구문 강조를 할 만큼 작은지 (줄 수와 글자 수) */
export function canHighlight(lineCount: number, chars: number): boolean {
  return lineCount <= MAX_HIGHLIGHT_LINES && chars <= MAX_HIGHLIGHT_CHARS;
}

/** 줄별 구문 조각을 비동기로 만든다 (언어 파서를 늦게 불러온다). 모르는 언어거나 너무 크면 null */
function useLineHighlight(
  lines: readonly string[],
  path: string,
  enabled: boolean,
): Span[][] | null {
  const [spans, setSpans] = useState<Span[][] | null>(null);
  useEffect(() => {
    let live = true;
    setSpans(null);
    if (!enabled) {
      return;
    }
    void parserFor(path, [lines.join('\n')]).then((parser) => {
      if (live && parser) {
        setSpans(tokenize(parser, lines.join('\n')));
      }
    });
    return () => {
      live = false;
    };
  }, [lines, path, enabled]);
  return spans;
}

export interface FileTextViewProps {
  /** 보일 텍스트 (BOM 은 뗀 것) */
  text: string;
  /** 구문 강조 언어를 고를 경로 */
  path: string;
  /** 처음 그릴 때의 스크롤 위치 (탭을 다시 활성화했을 때) */
  initialScrollTop?: number;
  onScrollTopChange?: (top: number) => void;
}

/**
 * 읽기 전용 텍스트 (ED-04): 줄 번호, 고정폭, 가로·세로 스크롤. 줄을 가상 스크롤로 그려 1 MiB(수만 줄)에서도
 * 보이는 줄만 DOM 에 있다. 내용은 React 텍스트 노드로만 그린다 (FS-14 — HTML 해석·링크 변환 없음). 작은 파일은
 * 구문 강조(`tok-*` 클래스)를 입힌다
 */
export function FileTextView({
  text,
  path,
  initialScrollTop,
  onScrollTopChange,
}: FileTextViewProps) {
  const scrollRef = useRef<HTMLElement>(null);
  const lines = useMemo(() => splitLines(text), [text]);
  const columns = useMemo(() => maxColumns(lines), [lines]);
  const highlight = useLineHighlight(lines, path, canHighlight(lines.length, text.length));
  const digits = Math.max(2, String(lines.length).length);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: lines.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LINE_H,
    overscan: 20,
  });

  // 처음 그릴 때 기억해 둔 스크롤 위치로 돌아간다 (내용이 이미 있어 높이가 정해져 있다)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 마운트 때 한 번만 돌린다
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && initialScrollTop) {
      el.scrollTop = initialScrollTop;
    }
  }, []);

  return (
    // 이름이 있는 section 은 region 이다 (스크린 리더가 "파일 내용" 영역으로 찾는다)
    <section
      ref={scrollRef}
      className={styles.scroller}
      aria-label={S.fileView.content}
      // 키보드로도 스크롤할 수 있게 포커스를 받는다
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 스크롤 영역은 키보드 스크롤을 위해 포커스를 받는다
      tabIndex={0}
      data-testid="file-text"
      style={{ tabSize: TAB_WIDTH }}
      onScroll={(e) => onScrollTopChange?.(e.currentTarget.scrollTop)}
    >
      <div
        className={styles.inner}
        style={{
          height: virtualizer.getTotalSize(),
          width: `calc(${digits + columns}ch + var(--file-gutter-pad))`,
        }}
      >
        {virtualizer.getVirtualItems().map((item) => {
          const line = lines[item.index] ?? '';
          const spans = highlight?.[item.index];
          return (
            <div
              key={item.key}
              className={styles.line}
              style={{ height: LINE_H, transform: `translateY(${item.start}px)` }}
            >
              <span className={styles.no} style={{ width: `${digits}ch` }}>
                {item.index + 1}
              </span>
              <span className={styles.code}>
                {spans
                  ? spans.map((span, i) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: 조각은 순서로만 식별된다
                      <span key={i} className={span.cls || undefined}>
                        {span.text}
                      </span>
                    ))
                  : line}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** 텍스트가 아닌 결과의 문구와 아이콘 */
function stateMessage(file: Exclude<FsFile, { kind: 'text' }>): { text: string; icon: IconName } {
  switch (file.kind) {
    case 'binary':
      return { text: S.fileView.binary(formatBytes(file.size)), icon: 'file' };
    case 'notUtf8':
      return { text: S.fileView.notUtf8(formatBytes(file.size)), icon: 'warning' };
    case 'tooLarge':
      return {
        text: S.fileView.tooLarge(formatBytes(file.size), formatBytes(file.limit)),
        icon: 'warning',
      };
    case 'unsupported':
      return {
        text: S.fileView.unsupported[file.fileKind],
        icon: file.fileKind === 'symlink' ? 'symlink' : 'special',
      };
    case 'missing':
      return { text: S.fileView.missing, icon: 'warning' };
    case 'denied':
      return { text: S.fileView.denied, icon: 'lock' };
  }
}

/** 결과의 크기 (바이트). 크기를 모르는 결과는 null */
function sizeOf(file: FsFile): number | null {
  return 'size' in file ? file.size : null;
}

/** 저장소 안 파일의 히스토리·Blame 진입 (W13). 무엇을 여는지는 컨테이너가 정한다 */
export interface FileViewRepoTools {
  /** 대상 저장소 이름 (버튼 툴팁) */
  repoName: string;
  /** 저장소 기준 상대 경로 (버튼 툴팁) */
  path: string;
  onHistory: () => void;
  onBlame: () => void;
}

export interface FileViewProps {
  /** 루트 기준 상대 경로 (머리줄의 경로 부스러기, 구문 강조 언어) */
  path: string;
  load: FileLoad;
  /** 요청 실패 뒤 "다시 시도" */
  onRetry: () => void;
  initialScrollTop?: number;
  onScrollTopChange?: (top: number) => void;
  /** 저장소 안 파일이면 머리줄의 히스토리·Blame 버튼 (ED-04). 없으면 버튼이 없다 */
  repoTools?: FileViewRepoTools | null;
  /** 머리줄 아래·본문 위의 안내 띠 (예: 줄 끝이 섞여 편집할 수 없다는 안내와 통일 단추). 없으면 그리지 않는다 */
  banner?: ReactNode;
  /** 머리줄 경로 뒤의 인코딩 단추 (R2 — 편집기로 열지 못한 텍스트 파일). 없으면 그리지 않는다 */
  encoding?: ReactNode;
}

/**
 * 파일 보기 탭의 화면 (ED-04): 머리줄(경로 부스러기·크기, 저장소 안 파일이면 히스토리·Blame)과 본문. 본문은 상태를
 * 구분해 보인다 — 읽는 중 / 텍스트 / 바이너리 / UTF-8 아님 / 너무 큼(실제 크기와 상한) / 지원 안 함(링크·특수 파일) /
 * 없음 / 권한 없음 / 오류(다시 시도). 받은 값만 그린다 — 언제 다시 읽는지는 컨테이너가 정한다
 */
export function FileView({
  path,
  load,
  onRetry,
  initialScrollTop,
  onScrollTopChange,
  repoTools = null,
  banner = null,
  encoding = null,
}: FileViewProps) {
  const file = load.state === 'loaded' ? load.file : null;
  const text = useMemo(() => (file?.kind === 'text' ? stripBom(file.text) : null), [file]);
  const size = file ? sizeOf(file) : null;
  const parts = path.split('/');
  const largeText = useMemo(
    () => text !== null && !canHighlight(countLines(text.text), text.text.length),
    [text],
  );

  let body: ReactNode;
  if (load.state === 'loading') {
    body = <div className={styles.message}>{S.fileView.loading}</div>;
  } else if (load.state === 'error') {
    body = (
      <div className={styles.message} data-tone="error">
        <Icon name="error" />
        <span>{S.fileView.failed(load.error)}</span>
        <Button onClick={onRetry}>{S.fileView.retry}</Button>
      </div>
    );
  } else if (text !== null) {
    body =
      text.text === '' ? (
        <div className={styles.message}>{S.fileView.emptyFile}</div>
      ) : (
        <FileTextView
          text={text.text}
          path={path}
          initialScrollTop={initialScrollTop}
          onScrollTopChange={onScrollTopChange}
        />
      );
  } else if (file && file.kind !== 'text') {
    const message = stateMessage(file);
    body = (
      <div className={styles.message} data-state={file.kind}>
        <Icon name={message.icon} />
        <span>{message.text}</span>
      </div>
    );
  }

  return (
    <div className={styles.pane}>
      <header className={styles.header}>
        <nav className={styles.crumbs} aria-label={path} title={path}>
          {parts.map((part, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 경로 구성요소는 순서로 식별된다 (같은 이름이 거듭될 수 있다)
            <span key={i} className={i === parts.length - 1 ? styles.crumbLast : styles.crumb}>
              {part}
            </span>
          ))}
        </nav>
        {encoding ? <span className={styles.size}>{encoding}</span> : null}
        {text?.bom ? <span className={styles.tag}>{S.fileView.bom}</span> : null}
        {largeText ? <span className={styles.tag}>{S.fileView.noHighlight}</span> : null}
        {size !== null ? <span className={styles.size}>{formatBytes(size)}</span> : null}
        {repoTools ? (
          <span className={styles.tools}>
            <Button
              onClick={repoTools.onHistory}
              title={S.fileView.historyTip(repoTools.repoName, repoTools.path)}
            >
              {S.fileView.history}
            </Button>
            <Button
              onClick={repoTools.onBlame}
              title={S.fileView.blameTip(repoTools.repoName, repoTools.path)}
            >
              {S.fileView.blame}
            </Button>
          </span>
        ) : null}
      </header>
      {banner}
      <div className={styles.body}>{body}</div>
    </div>
  );
}
