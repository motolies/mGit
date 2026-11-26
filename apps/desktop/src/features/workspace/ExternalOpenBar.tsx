// mGit 이 내용을 보이지 못하는 파일(너무 큼·UTF-8 아님·바이너리 등)의 안내 위에 "다른 앱에서 열기" 단추를 두는 띠.
// 파일 보기의 안내 띠 자리(`FileView` 의 `banner`)에 그린다. 여는 일은 앱 스토어의 `openExternal`(설정의 외부 편집기,
// 없으면 PATH 의 code → idea → OS 의 텍스트 편집기 / Finder) 그대로다.
import type { FsFile } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { revealLabel } from '../project/file-actions-menu';
import styles from './FileView.module.css';

/** 띠의 단추: 외부 편집기로 열기, Finder(파일 탐색기)에서 보기 */
export type ExternalOpenAction = 'editor' | 'reveal';

/** 텍스트가 아닌 파일 조회 결과의 종류 */
export type UnavailableKind = Exclude<FsFile, { kind: 'text' }>['kind'];

/**
 * 안내 종류마다 붙일 단추. 내용이 있지만 보이지 못하는 파일(1 MiB 초과·UTF-8 아님·바이너리)은 둘 다, 링크·특수 파일·
 * 폴더(`unsupported`)와 권한 없음은 Finder 만 — 링크를 외부 편집기로 열면 대상을 따라가고, 읽지 못하는 파일은 다른
 * 편집기도 열지 못한다. 없는 파일은 단추가 없다
 */
export function externalOpenActions(kind: UnavailableKind): readonly ExternalOpenAction[] {
  switch (kind) {
    case 'tooLarge':
    case 'notUtf8':
    case 'binary':
      return ['editor', 'reveal'];
    case 'unsupported':
    case 'denied':
      return ['reveal'];
    case 'missing':
      return [];
  }
}

/**
 * 고른 단추만 보이는 띠. `message` 를 주면 기본 안내("다른 앱에서 확인하세요") 대신 그 글을 앞에 둔다 (다시 쓸 수 없는
 * 인코딩의 까닭 등, R2). 단추도 글도 없으면 그리지 않는다
 */
export function ExternalOpenBar({
  actions,
  onOpen,
  message,
}: {
  actions: readonly ExternalOpenAction[];
  onOpen: (action: ExternalOpenAction) => void;
  message?: string;
}) {
  if (actions.length === 0 && !message) return null;
  return (
    <div className={styles.notice}>
      <span className={styles.noticeText} role={message ? 'status' : undefined}>
        {message ?? S.fileView.openOutside}
      </span>
      {actions.includes('editor') ? (
        <Button onClick={() => onOpen('editor')}>{S.actions.openEditor}</Button>
      ) : null}
      {actions.includes('reveal') ? (
        <Button onClick={() => onOpen('reveal')}>{revealLabel()}</Button>
      ) : null}
    </div>
  );
}
