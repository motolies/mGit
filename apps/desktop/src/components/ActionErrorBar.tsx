import { useAppStore, useHasSession, useSession } from '../store';
import styles from './ActionErrorBar.module.css';

/**
 * 쓰기 동작 오류 표시. 우측 패널이 커밋 상세일 때도 보이도록 앱 상단에 두고, 모달이 앞을 가리는 대화상자는
 * 안쪽에도 둔다. 클릭하면 닫힌다. 범위 세션의 오류다 — 폴더 탭에서는 활성 저장소의 숨은 세션(파일 히스토리·외부 diff
 * 도구가 실패한 사유)이 여기에 보인다 (W13)
 */
export function ActionErrorBar() {
  const hasSession = useHasSession();
  const error = useSession((st) => st.actionError);
  const clear = useSession((st) => st.clearActionError);
  if (!hasSession || !error) {
    return null;
  }
  // 오류는 나타날 때 바로 읽힌다 (W19 ③ — 단추의 뜻은 그대로 두고 감싼 칸이 알린다)
  return (
    <div role="alert">
      <button type="button" className={styles.bar} onClick={clear} title={error}>
        {error}
      </button>
    </div>
  );
}

/** 앱 수준 오류 표시. 툴바의 오류를 가리는 대화상자 안에 둔다. 클릭하면 닫힌다 */
export function LastErrorBar() {
  const error = useAppStore((st) => st.lastError);
  const clear = useAppStore((st) => st.clearError);
  if (!error) {
    return null;
  }
  return (
    <div role="alert">
      <button type="button" className={styles.bar} onClick={clear} title={error}>
        {error}
      </button>
    </div>
  );
}
