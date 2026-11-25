/** 네이티브 드롭 위치에 대응하는 Project 디렉터리다. */
export interface ProjectDropTarget {
  session: number;
  directory: string;
  element: HTMLElement;
}

/** Retina 물리 좌표를 CSS 좌표로 바꾸고 현재 표시된 Project만 찾는다. */
export function projectDropTarget(
  position: { x: number; y: number },
  scale: number,
): ProjectDropTarget | null {
  const element = document.elementFromPoint(position.x / scale, position.y / scale);
  const host = element?.closest<HTMLElement>('[data-project-session]');
  if (!host || host.closest('[hidden], [inert]')) return null;
  const session = Number(host.dataset.projectSession);
  if (!Number.isFinite(session)) return null;
  const row = element?.closest<HTMLElement>('[data-project-path]');
  const path = row?.dataset.projectPath ?? '';
  const directory =
    row?.dataset.projectDirectory === 'true'
      ? path
      : path.includes('/')
        ? path.slice(0, path.lastIndexOf('/'))
        : '';
  return { session, directory, element: row ?? host };
}

/** 모달 안에서 드롭으로 배경 파일 작업을 시작하지 않는다. */
export function dropBlocked(): boolean {
  return (
    document.querySelector(
      '[role="dialog"][aria-modal="true"], dialog[open], [role="alertdialog"]',
    ) !== null
  );
}

/** 드롭 목적지 표시는 네이티브 enter/over/leave와 완료 시 한 곳에서 관리한다. */
export function highlightProjectDrop(target: ProjectDropTarget | null): void {
  for (const element of document.querySelectorAll('[data-native-drop-target]'))
    element.removeAttribute('data-native-drop-target');
  target?.element.setAttribute('data-native-drop-target', '');
}
