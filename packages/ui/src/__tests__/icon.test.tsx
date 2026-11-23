import { cleanup, render } from '@testing-library/react';
import codiconCss from '@vscode/codicons/dist/codicon.css?raw';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon } from '../Icon';
import { ICON_GLYPHS, iconClassName } from '../icon-set';

afterEach(cleanup);

/** 설치된 세트의 CSS 에서 글리프 규칙(`.codicon-이름:before`)이 있는 아이콘 이름을 모은다 */
function installedGlyphs(): Set<string> {
  const names = new Set<string>();
  for (const m of codiconCss.matchAll(/\.codicon-([a-z0-9-]+):before/g)) {
    if (m[1]) {
      names.add(m[1]);
    }
  }
  return names;
}

describe('아이콘 세트 매핑 (LF-02)', () => {
  it('매핑한 아이콘 이름이 모두 설치된 세트에 있다', () => {
    const installed = installedGlyphs();
    const missing = Object.entries(ICON_GLYPHS)
      .filter(([, glyph]) => !installed.has(glyph))
      .map(([name, glyph]) => `${name} → ${glyph}`);
    expect(missing).toEqual([]);
  });
});

describe('Icon', () => {
  it('의미 이름을 세트의 클래스로 바꾸고 보조 기술에서 숨긴다', () => {
    const { container } = render(<Icon name="branch" />);
    const el = container.firstElementChild;
    expect(el?.tagName).toBe('SPAN');
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    for (const cls of iconClassName('branch').split(' ')) {
      expect(el?.classList.contains(cls)).toBe(true);
    }
  });

  it('사용처가 준 className 을 함께 붙인다', () => {
    const { container } = render(<Icon name="close" className="extra" />);
    expect(container.firstElementChild?.classList.contains('extra')).toBe(true);
  });
});
