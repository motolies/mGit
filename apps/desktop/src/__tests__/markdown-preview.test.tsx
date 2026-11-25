import { createNullClient } from '@mgit/ipc';
import { S } from '@mgit/ui';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkdownPreview } from '../features/workspace/markdown/MarkdownPreview';
import { localImagePath, markdownViewState } from '../features/workspace/markdown/preview-state';

vi.mock('../features/workspace/markdown/MermaidBlock', () => ({
  MermaidBlock: ({ source }: { source: string }) => <div data-testid="mermaid">{source}</div>,
}));
afterEach(cleanup);

/** 실제 세션 경로와 독립된 미리보기 상태를 준비한다. */
function fixture(text: string, path = 'docs/readme.md') {
  const client = {
    ...createNullClient(),
    fsReadImage: vi.fn(async () => ({
      kind: 'image' as const,
      mime: 'image/png',
      dataUrl: 'data:image/png;base64,AA==',
      size: 1,
    })),
    openUrl: vi.fn(async () => {}),
  };
  const props = {
    text,
    source: { client, session: 23, path },
    viewState: { mode: 'preview' as const, ratio: 50, scrollTop: 0 },
    refreshKey: '0',
  };
  return { client, props, ...render(<MarkdownPreview {...props} />) };
}

describe('Markdown paths and view state', () => {
  it('resolves Unicode, spaces and parent paths only inside the selected root', () => {
    expect(localImagePath('docs/guide/readme.md', '../이미지%20폴더/a.png')).toBe(
      'docs/이미지 폴더/a.png',
    );
    expect(localImagePath('docs/readme.md', '../a.svg')).toBe('a.svg');
    for (const path of [
      '../../a.png',
      '/a.png',
      'file:///a.png',
      'C:/a.png',
      '../.git/a.png',
      '%2e%2e/%2e%2e/a.png',
      '\\host\\a.png',
      'data:image/png,a',
      'https://a.test/a',
    ])
      expect(localImagePath('docs/readme.md', path)).toBeNull();
  });
  it('retains per-file view settings for the app lifetime', () => {
    const state = markdownViewState('preview-state-test');
    expect(state.mode).toBe('edit');
    state.mode = 'split';
    state.ratio = 64;
    state.scrollTop = 300;
    expect(markdownViewState('preview-state-test')).toEqual(state);
    expect(markdownViewState('another-preview-state-test').mode).toBe('edit');
  });
});

describe('Markdown preview', () => {
  it('renders GFM, SQL on first load, Mermaid and safe text without executing HTML', async () => {
    const { container } = fixture(
      '# Heading\n\n~~gone~~ **strong**\n\n- [x] done\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```sql\nSELECT \'value\'; -- comment\n```\n\n```mermaid\nflowchart LR\nA --> B\n```\n\n<script>alert(1)</script>\n<div onclick="boom()">unsafe</div>',
    );
    expect(screen.getByRole('heading', { name: 'Heading' }).id).toBe('heading');
    expect(screen.getByRole('table')).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('mermaid').textContent).toContain('A --> B');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    await waitFor(() =>
      expect(container.querySelector('.tok-keyword')?.textContent).toContain('SELECT'),
    );
    expect(container.querySelector('.tok-string')?.textContent).toContain('value');
    expect(container.querySelector('.tok-comment')?.textContent).toContain('comment');
  });
  it('deduplicates local images, uses displayed session/path, and invalidates on refresh/focus/reentry', async () => {
    const { client, props, rerender, unmount } = fixture('![first](../a.png) ![second](../a.png)');
    await screen.findByAltText('first');
    expect(client.fsReadImage).toHaveBeenCalledTimes(1);
    expect(client.fsReadImage).toHaveBeenCalledWith(23, 'a.png');
    rerender(<MarkdownPreview {...props} refreshKey="1" />);
    await waitFor(() => expect(client.fsReadImage).toHaveBeenCalledTimes(2));
    fireEvent(window, new Event('focus'));
    await waitFor(() => expect(client.fsReadImage).toHaveBeenCalledTimes(3));
    unmount();
    render(<MarkdownPreview {...props} />);
    await waitFor(() => expect(client.fsReadImage).toHaveBeenCalledTimes(4));
  });
  it('reports forbidden paths and remote failures without invoking local reads', async () => {
    const { client } = fixture('![bad](../../secret.png)\n\n![remote](https://example.test/a.png)');
    expect(screen.getByText(`bad: ${S.markdown.imagePath}`)).toBeTruthy();
    const remote = screen.getByAltText('remote');
    expect(remote.getAttribute('loading')).toBe('lazy');
    expect(remote.getAttribute('referrerpolicy')).toBe('no-referrer');
    fireEvent.error(remote);
    expect(screen.getByText(`remote: ${S.markdown.imageFailed}`)).toBeTruthy();
    expect(client.fsReadImage).not.toHaveBeenCalled();
  });
  it('opens HTTP links via IPC, keeps anchors local and disables other local document links', () => {
    const { client, container } = fixture(
      '# 한국어 Title\n\n[web](https://example.test) [local](other.md) [here](#한국어-title) [bad](javascript:alert(1))',
    );
    fireEvent.click(screen.getByRole('link', { name: 'web' }));
    expect(client.openUrl).toHaveBeenCalledWith('https://example.test');
    expect(screen.queryByRole('link', { name: 'local' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull();
    const heading = container.querySelector('h1');
    if (!heading) throw new Error('missing heading');
    const scroll = vi.fn();
    heading.scrollIntoView = scroll;
    fireEvent.click(screen.getByRole('link', { name: 'here' }));
    expect(scroll).toHaveBeenCalled();
    expect(client.openUrl).toHaveBeenCalledTimes(1);
  });
  it('keeps the saved scroll position through asynchronous layout until the user scrolls', () => {
    const { props, rerender } = fixture('# Position');
    const viewState = { ...props.viewState, scrollTop: 300 };
    rerender(<MarkdownPreview {...props} viewState={viewState} />);
    const region = screen.getByRole('region', { name: S.markdown.preview });
    expect(region.scrollTop).toBe(300);
    region.scrollTop = 20;
    fireEvent.scroll(region);
    expect(region.scrollTop).toBe(300);
    expect(viewState.scrollTop).toBe(300);
    fireEvent.wheel(region);
    region.scrollTop = 80;
    fireEvent.scroll(region);
    expect(viewState.scrollTop).toBe(80);
  });
  it('does not render truncated oversized documents', () => {
    const { rerender, props } = fixture(`# hidden\n${'x'.repeat(128 * 1024)}`);
    expect(screen.getByText(S.markdown.tooLarge)).toBeTruthy();
    expect(screen.queryByRole('heading')).toBeNull();
    rerender(<MarkdownPreview {...props} text={`# hidden\n${'\n'.repeat(5000)}`} />);
    expect(screen.queryByRole('heading')).toBeNull();
  });
  it('discards a late image response after switching context', async () => {
    let resolve!: (value: { kind: 'image'; mime: string; dataUrl: string; size: number }) => void;
    const client = {
      ...createNullClient(),
      fsReadImage: vi.fn(
        () =>
          new Promise<Parameters<typeof resolve>[0]>((done) => {
            resolve = done;
          }),
      ),
    };
    const props = {
      text: '![old](a.png)',
      source: { client, session: 1, path: 'one/readme.md' },
      viewState: { mode: 'preview' as const, ratio: 50, scrollTop: 0 },
      refreshKey: '0',
    };
    const { rerender } = render(<MarkdownPreview {...props} />);
    const old = resolve;
    rerender(
      <MarkdownPreview {...props} source={{ ...props.source, session: 2 }} text="![new](b.png)" />,
    );
    await act(async () =>
      old({ kind: 'image', mime: 'image/png', dataUrl: 'data:image/png;base64,OLD', size: 3 }),
    );
    expect(screen.queryByAltText('old')).toBeNull();
    expect(document.querySelector('img[src$="OLD"]')).toBeNull();
  });
});
