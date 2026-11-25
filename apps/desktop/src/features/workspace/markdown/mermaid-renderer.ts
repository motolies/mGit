export const MERMAID_MAX_TEXT = 50 * 1024;
export const MERMAID_MAX_EDGES = 500;
const CACHE_SIZE = 32;
const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();
let queue: Promise<unknown> = Promise.resolve();
let serial = 0;

export type MermaidTheme = 'light' | 'dark';
export interface MermaidColors {
  background: string;
  foreground: string;
  panel: string;
  accent: string;
  border: string;
}

/** SVG 이미지에는 앱의 CSS 변수가 전달되지 않으므로 계산된 색상을 넘긴다. */
export function mermaidColors(theme: MermaidTheme): MermaidColors {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: token('--bg', theme === 'dark' ? '#1e1f22' : '#ffffff'),
    foreground: token('--fg', theme === 'dark' ? '#dfe1e5' : '#1c1f26'),
    panel: token('--bg-panel', theme === 'dark' ? '#2b2d30' : '#f7f8fa'),
    accent: token('--accent', theme === 'dark' ? '#3574f0' : '#2f6feb'),
    border: token('--border', theme === 'dark' ? '#43454a' : '#d1d5db'),
  };
}

/** 문서가 렌더러 설정을 바꾸지 못하게 하고 파싱 전에 입력 크기를 제한한다. */
export function validateMermaidSource(source: string): void {
  if (source.length > MERMAID_MAX_TEXT) throw new Error('Mermaid: maximum 50 Ki characters.');
  if (/%%\s*\{/.test(source) || /^\s*---(?:\r?\n|$)/.test(source)) {
    throw new Error(
      'Mermaid: document directives and configuration frontmatter are not supported.',
    );
  }
}

/** 파서가 확장한 실제 연결 수를 검사하므로 A & B 같은 축약 표현도 제한한다. */
function checkEdges(db: Record<string, unknown>, source: string): void {
  const counts: number[] = [];
  for (const name of ['getEdges', 'getRelations', 'getRelationships', 'getMessages']) {
    const getter = db[name];
    if (typeof getter === 'function') {
      const values: unknown = getter.call(db);
      if (Array.isArray(values)) counts.push(values.length);
    }
  }
  // 중첩 state와 gantt의 의존 관계는 원문 연결 표현도 함께 센다.
  counts.push(
    (source.match(/(?:<[-.=]+>|[-.=]+>|[-.=]+[ox]|[|o}][|o}][- .]+[|o{][|o{])/g) ?? []).length,
  );
  if (/^\s*gantt\b/.test(source)) {
    let dependencies = 0;
    for (const match of source.matchAll(/\b(?:after|until)\s+([\w -]+)/g)) {
      dependencies += (match[1] ?? '').trim().split(/\s+/).length;
    }
    counts.push(dependencies);
  }
  if (Math.max(0, ...counts) > MERMAID_MAX_EDGES) {
    throw new Error('Mermaid: maximum 500 connections.');
  }
}

/** 전역 Mermaid 설정과 측정 DOM을 한 번에 하나만 사용하고 결과는 이미지 URL로 반환한다. */
export function renderMermaid(
  source: string,
  theme: MermaidTheme,
  colors: MermaidColors = mermaidColors(theme),
): Promise<string> {
  try {
    validateMermaidSource(source);
  } catch (error) {
    return Promise.reject(error);
  }
  const key = JSON.stringify([source, theme, colors]);
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const existing = pending.get(key);
  if (existing) return existing;
  const work = queue.then(async () => {
    const { default: mermaid } = await import('mermaid');
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      maxTextSize: MERMAID_MAX_TEXT,
      maxEdges: MERMAID_MAX_EDGES,
      suppressErrorRendering: true,
      theme: 'base',
      themeVariables: {
        darkMode: theme === 'dark',
        background: colors.background,
        primaryColor: colors.panel,
        primaryTextColor: colors.foreground,
        primaryBorderColor: colors.accent,
        secondaryColor: colors.background,
        secondaryTextColor: colors.foreground,
        tertiaryColor: colors.panel,
        tertiaryTextColor: colors.foreground,
        lineColor: colors.foreground,
        textColor: colors.foreground,
        mainBkg: colors.panel,
        nodeBorder: colors.accent,
        clusterBkg: colors.background,
        clusterBorder: colors.border,
        edgeLabelBackground: colors.background,
        actorBkg: colors.panel,
        actorTextColor: colors.foreground,
        actorBorder: colors.accent,
        signalColor: colors.foreground,
        signalTextColor: colors.foreground,
        noteBkgColor: colors.panel,
        noteTextColor: colors.foreground,
        noteBorderColor: colors.border,
      },
    });
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(source);
    checkEdges(diagram.db as Record<string, unknown>, source);
    const container = document.createElement('div');
    container.setAttribute('aria-hidden', 'true');
    container.style.cssText =
      'position:fixed;left:-100000px;top:0;visibility:hidden;pointer-events:none';
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`mgit-mermaid-${++serial}`, source, container);
      const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      cache.set(key, url);
      while (cache.size > CACHE_SIZE) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return url;
    } finally {
      container.remove();
    }
  });
  queue = work.catch(() => {});
  pending.set(key, work);
  void work.then(
    () => pending.delete(key),
    () => pending.delete(key),
  );
  return work;
}
