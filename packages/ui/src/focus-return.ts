/** 출발 요소가 사라지면 같은 묶음의 다음 항목·이전 항목·영역 순서로 복귀한다 */
export function captureFocusReturn(): () => void {
  const origin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area =
    origin?.closest<HTMLElement>(
      '[role="tree"], [role="tablist"], [data-panel], [role="toolbar"]',
    ) ?? null;
  const items = area
    ? [...area.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex], input, textarea')]
    : [];
  const index = origin ? items.indexOf(origin) : -1;
  const fallback =
    index >= 0 ? items.slice(index + 1).concat(items.slice(0, index).reverse()) : items;
  return () => {
    const available = (el: HTMLElement) =>
      el.isConnected && !el.closest('[inert], [hidden]') && !el.matches(':disabled');
    const target =
      origin && available(origin)
        ? origin
        : (fallback.find(available) ?? (area && available(area) ? area : null));
    if (target) {
      if (!target.matches('button, input, textarea, select, a[href], [tabindex]'))
        target.tabIndex = -1;
      target.focus({ preventScroll: true });
    }
  };
}
