import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
  getDiagramFromText: vi.fn(),
}));
vi.mock('mermaid', () => ({
  default: {
    initialize: api.initialize,
    render: api.render,
    mermaidAPI: { getDiagramFromText: api.getDiagramFromText },
  },
}));

/** 테스트별로 렌더 큐와 캐시를 비운다. */
async function renderer() {
  vi.resetModules();
  return import('../features/workspace/markdown/mermaid-renderer');
}

beforeEach(() => {
  vi.clearAllMocks();
  api.render.mockResolvedValue({
    svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>한글</text></svg>',
  });
  api.getDiagramFromText.mockResolvedValue({ db: { getEdges: () => [] } });
});

describe('Mermaid renderer boundary', () => {
  it('rejects directives, frontmatter and oversized sources before loading Mermaid', async () => {
    const { renderMermaid, MERMAID_MAX_TEXT } = await renderer();
    for (const source of [
      '%%{init: {securityLevel:"loose"}}%%\ngraph TD;A-->B',
      '\n---\nconfig: {}\n---\ngraph TD;A-->B',
      'a'.repeat(MERMAID_MAX_TEXT + 1),
    ]) {
      await expect(renderMermaid(source, 'light')).rejects.toThrow();
    }
    expect(api.initialize).not.toHaveBeenCalled();
  });

  it('deduplicates work, serializes different diagrams and keys cache by theme/colors', async () => {
    const { renderMermaid } = await renderer();
    let resolve!: (value: { svg: string }) => void;
    api.render.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = renderMermaid('flowchart TD;A-->B', 'light');
    expect(renderMermaid('flowchart TD;A-->B', 'light')).toBe(first);
    const next = renderMermaid('flowchart TD;C-->D', 'light');
    await vi.waitFor(() => expect(api.render).toHaveBeenCalledTimes(1));
    resolve({ svg: '<svg/>' });
    expect(await first).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E');
    await next;
    await renderMermaid('flowchart TD;A-->B', 'light');
    expect(api.render).toHaveBeenCalledTimes(2);
    await renderMermaid('flowchart TD;A-->B', 'dark');
    expect(api.render).toHaveBeenCalledTimes(3);
    expect(api.initialize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        securityLevel: 'strict',
        startOnLoad: false,
        htmlLabels: false,
        maxEdges: 500,
        themeVariables: expect.objectContaining({ darkMode: true, primaryTextColor: '#dfe1e5' }),
      }),
    );
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it('bounds parsed connections, including expanded grouped flowchart edges', async () => {
    const { renderMermaid } = await renderer();
    api.getDiagramFromText.mockResolvedValueOnce({ db: { getEdges: () => Array(501) } });
    await expect(renderMermaid('flowchart TD;A & B-->C & D', 'light')).rejects.toThrow('500');
    expect(api.render).not.toHaveBeenCalled();
  });

  it('recovers queue after errors and removes measurement nodes', async () => {
    const { renderMermaid } = await renderer();
    api.render.mockRejectedValueOnce(new Error('bad diagram'));
    await expect(renderMermaid('bad', 'light')).rejects.toThrow('bad diagram');
    await expect(renderMermaid('flowchart TD;A-->B', 'light')).resolves.toContain(
      'data:image/svg+xml',
    );
    expect(document.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
