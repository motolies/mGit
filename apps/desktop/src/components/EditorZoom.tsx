import { Button, S } from '@mgit/ui';
import { type RefObject, useEffect } from 'react';
import { commandTarget, registerCommand } from '../command-registry';
import { changeEditorZoom, useEditorPreferences } from '../store/editor-preferences';
import { useCommandTitle } from './use-command-shortcut';

/** 활성 본문에만 배율 명령을 연결하고 일반 입력란의 키는 보호한다. */
export function useEditorZoom(ref: RefObject<HTMLElement | null>) {
  const { zoomPercent } = useEditorPreferences();
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const cleanups = (['zoomOut', 'zoomReset', 'zoomIn'] as const).map((name, index) =>
      registerCommand(`editor.${name}`, element, {
        enabled: () => !commandTarget()?.closest('input, textarea, select'),
        run: () => changeEditorZoom((index - 1) as -1 | 0 | 1),
      }),
    );
    return () =>
      cleanups.forEach((cleanup) => {
        cleanup();
      });
  });
  return { zoomPercent, fontSize: (12 * zoomPercent) / 100 };
}

/** 배율 버튼은 현재 본문 포커스를 보존하며 키보드로도 조작할 수 있다. */
export function EditorZoomControls() {
  const { zoomPercent } = useEditorPreferences();
  const out = useCommandTitle('editor.zoomOut', S.fileEditor.zoomOut);
  const into = useCommandTitle('editor.zoomIn', S.fileEditor.zoomIn);
  return (
    <fieldset
      aria-label={S.fileEditor.zoom}
      style={{
        display: 'inline-flex',
        gap: 2,
        alignItems: 'center',
        flexShrink: 0,
        border: 0,
        padding: 0,
        margin: 0,
        minWidth: 0,
      }}
    >
      <Button
        size="compact"
        title={out}
        aria-label={out}
        disabled={zoomPercent <= 50}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => changeEditorZoom(-1)}
      >
        −
      </Button>
      <Button
        size="compact"
        title={S.fileEditor.zoomReset}
        aria-label={`${S.fileEditor.zoomReset} (${zoomPercent}%)`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => changeEditorZoom(0)}
      >
        {zoomPercent}%
      </Button>
      <Button
        size="compact"
        title={into}
        aria-label={into}
        disabled={zoomPercent >= 200}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => changeEditorZoom(1)}
      >
        +
      </Button>
    </fieldset>
  );
}
