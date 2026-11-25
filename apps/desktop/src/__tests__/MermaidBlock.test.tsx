import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MermaidBlock } from '../features/workspace/markdown/MermaidBlock';
import { renderMermaid } from '../features/workspace/markdown/mermaid-renderer';

vi.mock('../features/workspace/markdown/mermaid-renderer', () => ({ renderMermaid: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('discards stale source and theme renders and displays only an image', async () => {
  const finish: Array<(value: string) => void> = [];
  vi.mocked(renderMermaid).mockImplementation(() => new Promise((resolve) => finish.push(resolve)));
  const view = render(<MermaidBlock source="old" theme="light" />);
  view.rerender(<MermaidBlock source="new" theme="light" />);
  await act(async () => finish[1]?.('data:image/svg+xml,new'));
  expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/svg+xml,new');
  await act(async () => finish[0]?.('data:image/svg+xml,old'));
  expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/svg+xml,new');
  view.rerender(<MermaidBlock source="new" theme="dark" />);
  expect(screen.queryByRole('img')).toBeNull();
  await act(async () => finish[2]?.('data:image/svg+xml,dark'));
  expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/svg+xml,dark');
  expect(view.container.querySelector('svg')).toBeNull();
  expect(view.container.querySelector('code')?.textContent).toBe('new');
});

it('retains source on failure and recovers when source changes', async () => {
  vi.mocked(renderMermaid).mockRejectedValueOnce(new Error('invalid diagram'));
  const view = render(<MermaidBlock source="broken" theme="light" />);
  expect((await screen.findByRole('alert')).textContent).toContain('invalid diagram');
  expect(view.container.querySelector('details')?.open).toBe(true);
  expect(view.container.querySelector('code')?.textContent).toBe('broken');
  vi.mocked(renderMermaid).mockResolvedValueOnce('data:image/svg+xml,fixed');
  view.rerender(<MermaidBlock source="fixed" theme="light" />);
  await screen.findByRole('img');
  expect(screen.queryByRole('alert')).toBeNull();
});
