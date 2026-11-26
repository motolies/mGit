import { beforeEach, describe, expect, it } from 'vitest';
import { writePref } from '../store/prefs';
import {
  RECENT_FILES_LIMIT,
  readRecentFiles,
  recentFilesKey,
  recordRecentFile,
  watchRecentFiles,
} from '../store/recent-files';
import { createWorkspaceStore, fileViewDoc, OVERVIEW_DOC } from '../store/workspace-store';

const file = (path: string) => fileViewDoc({ path, name: path, repoPath: null, repoName: null });

beforeEach(() => {
  writePref(recentFilesKey('/r'), []);
  writePref(recentFilesKey('/other'), []);
});

describe('최근 파일', () => {
  it('루트별로 가장 최근을 앞에 두고 겹치지 않게 상한까지 기억한다', () => {
    recordRecentFile('/r', 'a.ts');
    recordRecentFile('/r', 'b.ts');
    recordRecentFile('/r', 'a.ts');
    expect(readRecentFiles('/r')).toEqual(['a.ts', 'b.ts']);
    expect(readRecentFiles('/other')).toEqual([]);
    for (let i = 0; i < RECENT_FILES_LIMIT + 3; i++) recordRecentFile('/r', `f${i}.ts`);
    expect(readRecentFiles('/r')).toHaveLength(RECENT_FILES_LIMIT);
    expect(readRecentFiles('/r')[0]).toBe(`f${RECENT_FILES_LIMIT + 2}.ts`);
    writePref(recentFilesKey('/r'), ['ok.ts', 3, '']);
    expect(readRecentFiles('/r')).toEqual(['ok.ts']);
  });

  it('어느 길로 열었든 파일 탭이 보이게 되면 기록하고, 파일이 아닌 문서는 기록하지 않는다', () => {
    const ws = createWorkspaceStore('folder');
    const stop = watchRecentFiles('/r', ws);
    ws.getState().openDoc(file('a.ts'), 'preview');
    ws.getState().openDoc(file('b.ts'), 'pinned');
    expect(readRecentFiles('/r')).toEqual(['b.ts', 'a.ts']);
    ws.getState().activateDoc(OVERVIEW_DOC.id);
    expect(readRecentFiles('/r')).toEqual(['b.ts', 'a.ts']);
    ws.getState().activateDoc('file:a.ts');
    ws.getState().openDoc(file('c.ts'), 'pinned');
    ws.getState().activateDoc('file:b.ts');
    expect(readRecentFiles('/r')).toEqual(['b.ts', 'c.ts', 'a.ts']);
    stop();
    ws.getState().activateDoc('file:c.ts');
    expect(readRecentFiles('/r')).toEqual(['b.ts', 'c.ts', 'a.ts']);
  });
});
