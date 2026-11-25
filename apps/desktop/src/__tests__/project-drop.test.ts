import { afterEach, describe, expect, it, vi } from 'vitest';
import { dropBlocked, highlightProjectDrop, projectDropTarget } from '../project-drop';

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('외부 Project 드롭', () => {
  it('Retina 좌표를 바꾸고 파일의 부모 폴더를 목적지로 고른다', () => {
    document.body.innerHTML =
      '<div data-project-session="12"><span data-project-path="src/a.ts" data-project-directory="false">a</span></div>';
    const row = document.querySelector('span');
    const hit = vi.fn(() => row);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
    const target = projectDropTarget({ x: 200, y: 100 }, 2);
    expect(hit).toHaveBeenCalledWith(100, 50);
    expect(target).toMatchObject({ session: 12, directory: 'src' });
    highlightProjectDrop(target);
    expect(row?.hasAttribute('data-native-drop-target')).toBe(true);
    highlightProjectDrop(null);
    expect(row?.hasAttribute('data-native-drop-target')).toBe(false);
  });

  it('폴더 자체와 빈 공간 루트를 구분하고 숨은 Project를 제외한다', () => {
    document.body.innerHTML =
      '<div data-project-session="12"><span data-project-path="src" data-project-directory="true">src</span></div>';
    const host = document.querySelector('div');
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => document.querySelector('span'),
    });
    expect(projectDropTarget({ x: 0, y: 0 }, 1)?.directory).toBe('src');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => host });
    expect(projectDropTarget({ x: 0, y: 0 }, 1)?.directory).toBe('');
    host?.setAttribute('hidden', '');
    expect(projectDropTarget({ x: 0, y: 0 }, 1)).toBeNull();
  });

  it('모달이 열려 있으면 배경 드롭을 막는다', () => {
    expect(dropBlocked()).toBe(false);
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    expect(dropBlocked()).toBe(true);
  });
});
