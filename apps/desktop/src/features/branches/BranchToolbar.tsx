import { S } from '@mgit/ui';
import { useRovingToolbar } from '../../components/roving';
import { ToolButton } from '../../layout/ToolButton';
import styles from './BranchToolbar.module.css';

export interface BranchToolbarProps {
  /** 브랜치 패널이 펼쳐져 있는지. 접혀 있으면 트리를 다루는 버튼(즐겨찾기·펼치기·접기)을 끈다 */
  panelOpen: boolean;
  /** 패널을 펼 수 없는 까닭 (도구 창이 좁음). 있으면 접기/펴기 버튼을 끄고 이 문구를 툴팁으로 쓴다 */
  panelLocked?: string;
  onTogglePanel: () => void;
  /** 새 branch·fetch 를 지금 실행할 수 없는지 (다른 작업 실행 중) */
  busy: boolean;
  /**
   * fetch 만 따로 끌 때 (저장소 탭: 진행 중 작업이 있거나 원격이 없으면 — 툴바의 Fetch 와 같은 조건, W22).
   * 주지 않으면 `busy` 를 따른다
   */
  fetchDisabled?: boolean;
  /** 새 branch·fetch 의 툴팁 (대상 저장소 수를 함께 쓴다). 주지 않으면 버튼 이름 */
  newBranchTitle?: string;
  fetchTitle?: string;
  onNewBranch: () => void;
  onFetch: () => void;
  /**
   * 선택한 branch 업데이트 (BR-09, IntelliJ 의 Update Selected). 주면 fetch 옆에 단추를 둔다 (기본은 단추 없음).
   * `updateDisabled` 는 선택이 업스트림 있는 로컬 branch 가 아니거나 실행할 수 없을 때, `updateTitle` 은 툴팁
   */
  onUpdate?: () => void;
  updateDisabled?: boolean;
  updateTitle?: string;
  /** 선택한 브랜치가 즐겨찾기인지. 선택이 없거나 즐겨찾기할 수 없는 행이면 null (버튼을 끈다) */
  favorite: boolean | null;
  onToggleFavorite: () => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

/**
 * 브랜치 트리 왼쪽의 세로 툴바 (BT-05). 접히는 브랜치 패널의 밖에 두어 패널이 접혀 있어도 보인다.
 * 버튼이 하는 일은 모두 props 로 받는다. 도구 막대 하나가 Tab 정지 하나다 — ↑↓·Home·End 로 단추를 옮긴다 (W19 ③)
 */
export function BranchToolbar({
  panelOpen,
  panelLocked,
  onTogglePanel,
  busy,
  fetchDisabled,
  newBranchTitle,
  fetchTitle,
  onNewBranch,
  onFetch,
  onUpdate,
  updateDisabled,
  updateTitle,
  favorite,
  onToggleFavorite,
  onExpandAll,
  onCollapseAll,
}: BranchToolbarProps) {
  const t = S.branches.toolbar;
  const roving = useRovingToolbar<HTMLDivElement>('vertical');
  return (
    <div
      ref={roving.ref}
      className={styles.toolbar}
      role="toolbar"
      aria-label={t.label}
      aria-orientation="vertical"
      onKeyDown={roving.onKeyDown}
      onFocus={roving.onFocus}
    >
      <ToolButton
        icon="sidebar"
        label={t.togglePanel}
        title={panelLocked}
        pressed={panelOpen}
        disabled={panelLocked !== undefined}
        onClick={onTogglePanel}
      />
      <ToolButton
        icon="add"
        label={t.newBranch}
        title={newBranchTitle}
        disabled={busy}
        onClick={onNewBranch}
      />
      <ToolButton
        icon="fetch"
        label={t.fetch}
        title={fetchTitle}
        disabled={fetchDisabled ?? busy}
        onClick={onFetch}
      />
      {onUpdate ? (
        <ToolButton
          icon="update"
          label={t.update}
          title={updateTitle}
          disabled={updateDisabled ?? busy}
          onClick={onUpdate}
        />
      ) : null}
      <ToolButton
        icon={favorite ? 'star' : 'starEmpty'}
        label={t.favorite}
        pressed={favorite === true}
        disabled={!panelOpen || favorite === null}
        onClick={onToggleFavorite}
      />
      <ToolButton
        icon="expandAll"
        label={t.expandAll}
        disabled={!panelOpen}
        onClick={onExpandAll}
      />
      <ToolButton
        icon="collapseAll"
        label={t.collapseAll}
        disabled={!panelOpen}
        onClick={onCollapseAll}
      />
    </div>
  );
}
