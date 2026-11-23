import type { Module, StatusEntry } from '@mgit/ipc';
import { S } from '@mgit/ui';

/** 경로가 속한 모듈 (가장 긴 접두 일치). 없으면 null */
export function moduleOf(path: string, modules: readonly Module[]): Module | null {
  let best: Module | null = null;
  for (const m of modules) {
    if (path === m.path || path.startsWith(`${m.path}/`)) {
      if (!best || m.path.length > best.path.length) {
        best = m;
      }
    }
  }
  return best;
}

/** 모듈별 그룹 (MOD-04). 모듈 경로순, 어느 모듈에도 안 드는 것은 마지막 "(루트·공통)" */
export function groupByModule(
  entries: readonly StatusEntry[],
  modules: readonly Module[],
): { label: string; path: string | null; entries: StatusEntry[] }[] {
  const byPath = new Map<string | null, StatusEntry[]>();
  for (const e of entries) {
    const key = moduleOf(e.path, modules)?.path ?? null;
    const list = byPath.get(key);
    if (list) {
      list.push(e);
    } else {
      byPath.set(key, [e]);
    }
  }
  const out: { label: string; path: string | null; entries: StatusEntry[] }[] = [];
  for (const m of [...modules].sort((a, b) => a.path.localeCompare(b.path))) {
    const list = byPath.get(m.path);
    if (list) {
      out.push({ label: `${m.name} (${m.path})`, path: m.path, entries: list });
    }
  }
  const root = byPath.get(null);
  if (root) {
    out.push({ label: S.modules.root, path: null, entries: root });
  }
  return out;
}

/** 모듈 안에 있는 변경 수 */
export function changesInModule(path: string, entries: readonly StatusEntry[]): number {
  return entries.filter((e) => e.path === path || e.path.startsWith(`${path}/`)).length;
}
