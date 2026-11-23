import { S } from '@mgit/ui';
import { useAppStore } from '../store';
import styles from './Toasts.module.css';

/**
 * 우하단 토스트 목록 (UX-09). 클릭하면 닫힌다. 알림 영역(`role="status"`)은 토스트가 없어도 늘 그려 둔다 — 보조 기술은
 * 이미 있는 알림 영역에 들어온 글자만 읽는다 (W19 ③). 오류 토스트는 `role="alert"` 로 바로 읽힌다
 */
export function Toasts() {
  const toasts = useAppStore((s) => s.toasts);
  const dismiss = useAppStore((s) => s.dismissToast);
  return (
    <div className={styles.stack} role="status" aria-live="polite" aria-label={S.notify.region}>
      {toasts.map((t) => (
        // 오류는 감싼 칸이 바로 알린다 (단추의 뜻 — 눌러 닫기 — 는 그대로 둔다)
        <div key={t.id} className={styles.item} role={t.kind === 'error' ? 'alert' : undefined}>
          <button
            type="button"
            className={styles.toast}
            data-kind={t.kind}
            onClick={() => dismiss(t.id)}
          >
            <span className={styles.title}>{t.title}</span>
            {t.message ? <span className={styles.message}>{t.message}</span> : null}
          </button>
        </div>
      ))}
    </div>
  );
}
