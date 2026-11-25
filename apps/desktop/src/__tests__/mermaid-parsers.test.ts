import mermaid from 'mermaid';
import { afterEach, expect, it, vi } from 'vitest';
import { renderMermaid } from '../features/workspace/markdown/mermaid-renderer';

afterEach(() => vi.restoreAllMocks());

it.each([
  ['flowchart', 'flowchart TD\nA-->B'],
  ['sequence', 'sequenceDiagram\nAlice->>Bob: hello'],
  ['class', 'classDiagram\nAnimal <|-- Duck'],
  ['state', 'stateDiagram-v2\n[*] --> Still\nStill --> Moving'],
  ['ER', 'erDiagram\nCUSTOMER ||--o{ ORDER : places'],
  [
    'gantt',
    'gantt\n dateFormat YYYY-MM-DD\n section Work\n Task :a, 2026-01-01, 1d\n Next :after a, 1d',
  ],
])('accepts the real %s parser before image rendering', async (_name, source) => {
  const draw = vi
    .spyOn(mermaid, 'render')
    .mockResolvedValue({ svg: '<svg/>', diagramType: 'test' });
  await expect(renderMermaid(source, 'light')).resolves.toContain('data:image/svg+xml');
  expect(draw).toHaveBeenCalledOnce();
});

it('rejects real grouped flowchart expansion beyond 500 connections before drawing', async () => {
  const draw = vi
    .spyOn(mermaid, 'render')
    .mockResolvedValue({ svg: '<svg/>', diagramType: 'test' });
  const left = Array.from({ length: 23 }, (_, i) => `a${i}`).join(' & ');
  const right = Array.from({ length: 23 }, (_, i) => `b${i}`).join(' & ');
  await expect(renderMermaid(`flowchart TD\n${left} --> ${right}`, 'light')).rejects.toThrow();
  expect(draw).not.toHaveBeenCalled();
});
