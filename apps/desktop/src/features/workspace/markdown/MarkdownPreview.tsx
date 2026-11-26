import { languagePath, parserFor, type Span, tokenize } from '@mgit/diff-view';
import type { FsImage, IpcClient, SessionId } from '@mgit/ipc';
import { S } from '@mgit/ui';
import {
  Children,
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import ReactMarkdown, { type Components, defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { canHighlight, countLines } from '../FileView';
import styles from './MarkdownPreview.module.css';
import { MermaidBlock } from './MermaidBlock';
import { localImagePath, type MarkdownViewState } from './preview-state';

export interface PreviewSource {
  client: IpcClient;
  session: SessionId;
  path: string;
}
type ImageCache = Map<string, Promise<FsImage>>;

/**
 * 미리보기에 보이는 로컬 그림의 읽기 캐시와 파일 표지·판. 2초 검사 신호에는 표지만 묻고(N6 의 `fsFileStamps`), 표지가
 * 바뀐 그림만 캐시를 비우고 판을 올려 그 그림만 다시 읽는다 — 본문(Markdown·Mermaid)은 다시 그리지 않는다
 */
interface ImageWatch {
  cache: ImageCache;
  /** 지금 보이는 로컬 그림 경로와 그 경로를 쓰는 그림 수 */
  shown: Map<string, number>;
  /** 경로마다 읽기 직전에 본 표지 (일반 파일이 아니거나 모르면 null — 그런 그림은 검사마다 다시 읽는다) */
  stamps: Map<string, string | null>;
  /** 경로마다 다시 읽은 횟수 (그림이 다시 읽을 때를 안다) */
  versions: Map<string, number>;
  listeners: Set<() => void>;
}

/** 빈 그림 감시를 만든다 (원본·새로고침·포커스가 바뀌면 새로 만들어 모든 그림을 다시 읽는다) */
function createImageWatch(): ImageWatch {
  return {
    cache: new Map(),
    shown: new Map(),
    stamps: new Map(),
    versions: new Map(),
    listeners: new Set(),
  };
}

/** 표지를 먼저 적고 그림을 읽는다. 표지 뒤에 바뀐 그림은 다음 검사에서 표지가 달라 한 번 더 읽힌다 */
function readImage(watch: ImageWatch, source: PreviewSource, path: string): Promise<FsImage> {
  return source.client
    .fsFileStamps(source.session, [path])
    .then(
      ([stamp]) => stamp ?? null,
      () => null,
    )
    .then((stamp) => {
      watch.stamps.set(path, stamp);
      return source.client.fsReadImage(source.session, path);
    })
    .catch((): FsImage => ({ kind: 'denied' }));
}

/**
 * 보이는 로컬 그림의 표지를 한 번에 묻고 바뀐 그림만 다시 읽게 한다. 아직 읽는 중인 그림(표지를 적기 전)은 건너뛴다.
 * 표지를 모르면(null·조회 실패) 예전처럼 다시 읽는다
 */
async function checkImages(watch: ImageWatch, source: PreviewSource): Promise<void> {
  const paths = [...watch.shown.keys()].filter((path) => watch.stamps.has(path));
  if (paths.length === 0) {
    return;
  }
  const stamps = await source.client
    .fsFileStamps(source.session, paths)
    .catch(() => paths.map(() => null));
  const changed = paths.filter((path, i) => {
    const before = watch.stamps.get(path);
    const stamp = stamps[i] ?? null;
    return stamp === null || stamp !== before;
  });
  if (changed.length === 0) {
    return;
  }
  for (const path of changed) {
    watch.cache.delete(path);
    watch.stamps.delete(path);
    watch.versions.set(path, (watch.versions.get(path) ?? 0) + 1);
  }
  for (const listener of watch.listeners) {
    listener();
  }
}

/** 코드 블록도 소스 편집기와 동일한 파서·토큰을 사용한다. */
function CodeBlock({ source, language }: { source: string; language: string }) {
  const [result, setResult] = useState<{
    source: string;
    language: string;
    spans: Span[][];
  } | null>(null);
  useEffect(() => {
    let live = true;
    const path = languagePath(language);
    if (path)
      void parserFor(path, [source]).then((parser) => {
        if (live && parser) setResult({ source, language, spans: tokenize(parser, source) });
      });
    return () => {
      live = false;
    };
  }, [source, language]);
  const spans = result?.source === source && result.language === language ? result.spans : null;
  return (
    <pre>
      <code>
        {spans
          ? spans.map((line, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 파싱 결과의 줄과 조각은 위치로 식별한다.
              <span key={index}>
                {index ? '\n' : ''}
                {line.map((span, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 같은 줄의 토큰 위치다.
                  <span key={i} className={span.cls || undefined}>
                    {span.text}
                  </span>
                ))}
              </span>
            ))
          : source}
      </code>
    </pre>
  );
}

/**
 * 로컬 요청을 공유하며 브라우저 이미지 실패에도 대체 텍스트와 이유를 표시한다. 보이는 동안 경로를 그림 감시에 올려 두고,
 * 감시가 그 경로의 판을 올리면(파일 표지가 바뀜) 그 그림만 다시 읽는다
 */
function PreviewImage({
  src,
  alt,
  title,
  source,
  watch,
}: {
  src: string;
  alt: string;
  title?: string;
  source: PreviewSource;
  watch: ImageWatch;
}) {
  const remote = /^https?:\/\//i.test(src);
  const path = remote ? null : localImagePath(source.path, src);
  const [result, setResult] = useState<FsImage | null>(null);
  const [failed, setFailed] = useState(false);
  const subscribe = useCallback(
    (listener: () => void) => {
      watch.listeners.add(listener);
      return () => {
        watch.listeners.delete(listener);
      };
    },
    [watch],
  );
  const version = useSyncExternalStore(subscribe, () =>
    path === null ? 0 : (watch.versions.get(path) ?? 0),
  );
  // 보이는 로컬 그림으로 올려 둔다 (표지 검사 대상)
  useEffect(() => {
    if (path === null) {
      return;
    }
    watch.shown.set(path, (watch.shown.get(path) ?? 0) + 1);
    return () => {
      const left = (watch.shown.get(path) ?? 1) - 1;
      if (left > 0) watch.shown.set(path, left);
      else watch.shown.delete(path);
    };
  }, [watch, path]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: version 은 표지가 바뀌어 다시 읽을 때의 신호다.
  useEffect(() => {
    let live = true;
    setResult(null);
    setFailed(false);
    if (!remote && path) {
      let request = watch.cache.get(path);
      if (!request) {
        request = readImage(watch, source, path);
        watch.cache.set(path, request);
      }
      void request.then((image) => {
        if (live) setResult(image);
      });
    }
    return () => {
      live = false;
    };
  }, [remote, path, source, watch, version]);
  const reason = failed
    ? S.markdown.imageFailed
    : !remote && !path
      ? S.markdown.imagePath
      : result && result.kind !== 'image'
        ? S.markdown.imageErrors[result.kind]
        : null;
  if (reason)
    return (
      <span className={styles.error} role="status">
        {alt || S.markdown.image}: {reason}
      </span>
    );
  const url = remote ? src : result?.kind === 'image' ? result.dataUrl : null;
  return url ? (
    <img
      src={url}
      alt={alt}
      title={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  ) : (
    <span>
      {alt || S.markdown.image} · {S.markdown.loading}
    </span>
  );
}

/** 제목 안의 강조·링크도 앵커 이름의 텍스트에 포함한다. */
function plainText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? plainText(child.props.children)
        : String(child),
    )
    .join('');
}

/** 실제 적용 테마 속성을 관찰하므로 시스템 테마 변경도 반영한다. */
function usePreviewTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );
  useEffect(() => {
    const observer = new MutationObserver(() =>
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
    );
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/**
 * HTML은 실행하지 않고 현재 초안을 GFM으로 표시한다. 그림 캐시는 새로고침(`refreshKey`)·진입·포커스마다 교체해 모두 다시
 * 읽는다. 문서의 다시 확인 신호(`checkKey` — 2초 검사·원문 교체)에는 보이는 그림의 파일 표지만 묻고 바뀐 그림만 다시
 * 읽는다 (본문은 다시 그리지 않는다)
 */
export function MarkdownPreview({
  text,
  source,
  viewState,
  refreshKey,
  checkKey = 0,
  zoomPercent = 100,
}: {
  text: string;
  source: PreviewSource;
  viewState: MarkdownViewState;
  refreshKey: string;
  checkKey?: number;
  zoomPercent?: number;
}) {
  const host = useRef<HTMLElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const restoreTarget = useRef<number | null>(viewState.scrollTop);
  const { client, session, path } = source;
  const stableSource = useMemo(() => ({ client, session, path }), [client, session, path]);
  const theme = usePreviewTheme();
  const [focusEpoch, setFocusEpoch] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 파일 새로고침과 포커스는 로컬 이미지 캐시 교체 신호다.
  const watch = useMemo<ImageWatch>(
    () => createImageWatch(),
    [source.client, source.session, source.path, refreshKey, focusEpoch],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: checkKey 는 그림 표지를 다시 확인할 때의 신호다.
  useEffect(() => {
    void checkImages(watch, stableSource);
  }, [checkKey, watch, stableSource]);
  useEffect(() => {
    const refresh = () => setFocusEpoch((value) => value + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  useLayoutEffect(() => {
    restoreTarget.current = viewState.scrollTop;
    const restore = () => {
      if (!host.current || restoreTarget.current === null) return;
      host.current.scrollTop = restoreTarget.current;
    };
    restore();
    const observer = new ResizeObserver(restore);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [viewState]);
  // 코드·이미지 컴포넌트를 초안 갱신마다 다시 마운트하지 않아 늦은 결과와 스크롤을 보존한다.
  const baseComponents = useMemo<Components>(
    () => ({
      pre({ children }) {
        const child = Children.toArray(children)[0];
        if (!isValidElement<{ className?: string; children?: ReactNode }>(child))
          return <pre>{children}</pre>;
        const language = /language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? '';
        const body = plainText(child.props.children).replace(/\n$/, '');
        return language.toLowerCase() === 'mermaid' ? (
          <MermaidBlock source={body} theme={theme} />
        ) : (
          <CodeBlock source={body} language={language} />
        );
      },
      img({ src, alt, title }) {
        return (
          <PreviewImage
            key={`${src}-${refreshKey}-${focusEpoch}`}
            src={typeof src === 'string' ? src : ''}
            alt={alt ?? ''}
            title={title}
            source={stableSource}
            watch={watch}
          />
        );
      },
      a({ href, children }) {
        const anchor = href?.startsWith('#');
        const external = /^https?:\/\//i.test(href ?? '');
        if (!anchor && !external) return <span title={S.markdown.localLink}>{children}</span>;
        return (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault();
              restoreTarget.current = null;
              if (external && href) void stableSource.client.openUrl(href);
              else if (href) {
                let id = href.slice(1);
                try {
                  id = decodeURIComponent(id);
                } catch {
                  return;
                }
                const target = [...(host.current?.querySelectorAll('[id]') ?? [])].find(
                  (element) => element.id === id,
                );
                target?.scrollIntoView({ block: 'start' });
              }
            }}
          >
            {children}
          </a>
        );
      },
    }),
    [stableSource, watch, theme, refreshKey, focusEpoch],
  );
  // 배율만 바뀔 때 Markdown 파싱과 Mermaid 컴포넌트 구성을 반복하지 않는다.
  const rendered = useMemo(() => {
    const headings = new Map<string, number>();
    const components = { ...baseComponents };
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const) {
      components[tag] = ({ children }) => {
        const slug = plainText(children)
          .toLowerCase()
          .replace(/[^\p{L}\p{N}\s_-]/gu, '')
          .replace(/\s/g, '-');
        const count = headings.get(slug) ?? 0;
        headings.set(slug, count + 1);
        const Tag = tag;
        return <Tag id={`${slug}${count ? `-${count}` : ''}`}>{children}</Tag>;
      };
    }
    return (
      <>
        {canHighlight(countLines(text), text.length) ? (
          <ReactMarkdown
            skipHtml
            remarkPlugins={[remarkGfm]}
            components={components}
            urlTransform={(url, key) => (key === 'src' ? url : defaultUrlTransform(url))}
          >
            {text}
          </ReactMarkdown>
        ) : (
          <p role="status">{S.markdown.tooLarge}</p>
        )}
      </>
    );
  }, [text, baseComponents]);
  const previousZoom = useRef(zoomPercent);
  // 본문 확대 전의 읽던 상대 위치를 보존하며 초기 복원 대상도 함께 조정한다.
  useLayoutEffect(() => {
    const ratio = zoomPercent / previousZoom.current;
    previousZoom.current = zoomPercent;
    if (!host.current || ratio === 1) return;
    const top = host.current.scrollTop * ratio;
    if (restoreTarget.current !== null) restoreTarget.current = top;
    host.current.scrollTop = top;
    viewState.scrollTop = top;
  }, [zoomPercent, viewState]);
  return (
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 미리보기 스크롤과 문서 저장 단축키를 위해 포커스를 받는다.
      tabIndex={0}
      className={styles.preview}
      ref={host}
      aria-label={S.markdown.preview}
      onPointerDown={() => {
        restoreTarget.current = null;
      }}
      onWheel={() => {
        restoreTarget.current = null;
      }}
      onKeyDown={() => {
        restoreTarget.current = null;
      }}
      onScroll={(event) => {
        if (restoreTarget.current === null) viewState.scrollTop = event.currentTarget.scrollTop;
        else if (Math.abs(event.currentTarget.scrollTop - restoreTarget.current) > 1)
          event.currentTarget.scrollTop = restoreTarget.current;
      }}
    >
      <div ref={content} style={{ zoom: zoomPercent / 100 }}>
        {rendered}
      </div>
    </section>
  );
}
