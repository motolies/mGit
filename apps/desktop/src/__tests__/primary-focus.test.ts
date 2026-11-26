import { afterEach, expect, it } from 'vitest';
import { focusTargetIn } from '../actions';

afterEach(() => {
  document.body.replaceChildren();
});

it('영역 진입은 툴바보다 본문을 우선하고 숨은 본문과 비활성 폴백을 건너뛴다', () => {
  const panel = document.createElement('section');
  panel.innerHTML =
    '<div role="tabpanel"><button tabindex="0">tools</button><div data-primary-focus tabindex="0">body</div><div hidden><div class="cm-content" tabindex="0">hidden editor</div></div></div>';
  document.body.append(panel);
  const body = panel.querySelector<HTMLElement>('[data-primary-focus]');
  if (!body) throw new Error('Missing test body');
  expect(focusTargetIn(panel)).toBe(body);
  body.hidden = true;
  const button = panel.querySelector('button');
  if (!button) throw new Error('Missing test button');
  expect(focusTargetIn(panel)).toBe(button);
  button.disabled = true;
  expect(focusTargetIn(panel)).toBe(panel);
});
