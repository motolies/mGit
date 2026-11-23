import { Button, S } from '@mgit/ui';
import { useId } from 'react';
import { useModal } from '../../components/use-modal';
import { useFolder } from '../../store';
import styles from './FolderSettingsDialog.module.css';
import { FolderSettingsPanel } from './FolderSettingsPanel';

/**
 * "폴더 설정" 대화상자 (W12, MR-11): 개요 탭의 설정 보기를 옮겼다. 여는 곳은 개요 탭 머리, 프로젝트 트리 루트
 * 메뉴, Project 머리줄. 내용·저장 동작은 `FolderSettingsPanel` 그대로이고, 저장 실패 사유는 패널이 저장 버튼 위에
 * 보인다 (모달 뒤의 개요 오류 줄은 보이지 않으므로). 네이티브 `<dialog>` 라 바깥이 inert 가 되고 Esc 로 닫힌다
 */
export function FolderSettingsDialog() {
  const f = useFolder((st) => ({
    open: st.settingsOpen,
    setOpen: st.setSettingsOpen,
  }));
  const titleId = useId();
  const ref = useModal(f?.open === true);
  if (!f?.open) {
    return null;
  }
  const t = S.folder.settings;
  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      onClose={() => f.setOpen(false)}
    >
      <div className={styles.box}>
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {t.title}
          </h2>
          <span className={styles.spacer} />
          <Button onClick={() => f.setOpen(false)}>{t.close}</Button>
        </header>
        <FolderSettingsPanel />
      </div>
    </dialog>
  );
}
