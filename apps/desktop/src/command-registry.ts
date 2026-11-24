/** 화면이 소유하는 명령 핸들러. 실행 직전에 상태를 다시 확인한다. */
export interface CommandHandler {
  enabled: () => boolean;
  run: () => void;
  reason?: () => string | undefined;
}

const handlers = new Map<string, Map<HTMLElement, CommandHandler>>();
let paletteTarget: HTMLElement | null = null;

/** 팔레트를 열기 직전의 영역을 보존한다. 메뉴는 우클릭 대상으로 만든 핸들러를 직접 실행한다. */
export function captureCommandTarget(): void {
  paletteTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/** 팔레트 내부에서는 열기 전의 요소를 실행 대상으로 사용한다. */
export function commandTarget(): HTMLElement | null {
  const active = typeof document === 'undefined' ? null : document.activeElement;
  if (active instanceof HTMLElement && active.closest('[cmdk-dialog], [data-command-palette]')) {
    return paletteTarget?.isConnected ? paletteTarget : null;
  }
  return active instanceof HTMLElement ? active : null;
}

/** 화면 수명에 맞춰 등록하고 가장 안쪽 영역을 우선한다. */
export function registerCommand(
  id: string,
  element: HTMLElement,
  handler: CommandHandler,
): () => void {
  const entries = handlers.get(id) ?? new Map<HTMLElement, CommandHandler>();
  entries.set(element, handler);
  handlers.set(id, entries);
  return () => {
    if (entries.get(element) === handler) entries.delete(element);
    if (entries.size === 0) handlers.delete(id);
  };
}

/** 현재 대상의 조상에서만 찾으므로 숨은 탭·다른 저장소의 핸들러를 실행하지 않는다. */
export function resolveCommand(id: string, target = commandTarget()): CommandHandler | undefined {
  for (let el = target; el; el = el.parentElement) {
    if (el.closest('[inert], [hidden]')) continue;
    const handler = handlers.get(id)?.get(el);
    if (handler) return handler;
  }
  return undefined;
}

/** 선택한 명령이 비활성이면 다른 명령으로 넘기지 않는다. */
export function executeCommand(id: string, target = commandTarget()): boolean {
  const handler = resolveCommand(id, target);
  if (!handler) return false;
  if (handler.enabled()) handler.run();
  return true;
}
