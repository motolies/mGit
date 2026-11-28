import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToolGroup } from '../ToolGroup';
import styles from '../ToolGroup.module.css';

afterEach(cleanup);

describe('ToolGroup', () => {
  it('label 을 주면 이름 있는 group 으로 알리고, 없으면 역할 없이 배치만 한다', () => {
    render(
      <>
        <ToolGroup label="Zoom">
          <button type="button">+</button>
        </ToolGroup>
        <ToolGroup data-testid="plain">
          <button type="button">Save</button>
        </ToolGroup>
      </>,
    );
    expect(screen.getByRole('group', { name: 'Zoom' })).toBeTruthy();
    expect(screen.getAllByRole('group')).toHaveLength(1);
    expect(screen.getByTestId('plain').getAttribute('role')).toBeNull();
  });

  it('segmented 일 때만 세그먼트 클래스가 붙고, 넘긴 className 도 유지한다', () => {
    render(
      <>
        <ToolGroup segmented data-testid="seg" className="extra" />
        <ToolGroup data-testid="loose" />
      </>,
    );
    const seg = screen.getByTestId('seg');
    const loose = screen.getByTestId('loose');
    expect(seg.classList.contains(styles.group as string)).toBe(true);
    expect(seg.classList.contains(styles.segmented as string)).toBe(true);
    expect(seg.classList.contains('extra')).toBe(true);
    expect(loose.classList.contains(styles.group as string)).toBe(true);
    expect(loose.classList.contains(styles.segmented as string)).toBe(false);
  });
});
