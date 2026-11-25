import { S } from '@mgit/ui';
import { useEffect, useState } from 'react';
import styles from './MermaidBlock.module.css';
import { type MermaidTheme, renderMermaid } from './mermaid-renderer';

/** 이전 원문·테마의 늦은 결과는 버리고 SVG는 실행 기능이 없는 이미지로만 표시한다. */
export function MermaidBlock({ source, theme }: { source: string; theme: MermaidTheme }) {
  const [result, setResult] = useState<{
    source: string;
    theme: MermaidTheme;
    url?: string;
    error?: string;
  }>();
  const current = result?.source === source && result.theme === theme ? result : undefined;
  useEffect(() => {
    let live = true;
    void renderMermaid(source, theme).then(
      (url) => {
        if (live) setResult({ source, theme, url });
      },
      (error: unknown) => {
        if (live)
          setResult({
            source,
            theme,
            error: error instanceof Error ? error.message : String(error),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [source, theme]);
  return (
    <div className={styles.block}>
      {current?.url ? <img src={current.url} alt={S.markdown.diagram} /> : null}
      {current?.error ? <div role="alert">{current.error}</div> : null}
      {!current ? <div role="status">{S.markdown.renderingDiagram}</div> : null}
      <details key={`${source}:${theme}`} open={current?.error ? true : undefined}>
        <summary>{S.markdown.diagramSource}</summary>
        <pre>
          <code>{source}</code>
        </pre>
      </details>
    </div>
  );
}
