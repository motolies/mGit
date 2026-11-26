import type { WorkspaceSearchQuery, WorkspaceSearchResult } from '../types';
import type { MockFs } from './mock-fs';

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
  const queue = [''];
  for (let n = 0; n < queue.length && n < 2000; n++) {
    const dir = queue[n] ?? '';
    const listing = fs.list(root, dir, 50000);
    if (listing.kind !== 'listed') {
      out.skipped++;
      continue;
    }
    for (const e of listing.entries) {
      if (e.name === '.git' || e.name === 'node_modules' || e.name === 'target') continue;
      const path = dir ? `${dir}/${e.name}` : e.name;
      if (e.kind === 'dir') {
        queue.push(path);
        continue;
      }
      if (
        e.kind !== 'file' ||
        !e.openable ||
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
  }
  return out;
}
