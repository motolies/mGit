import { Button, S } from '@mgit/ui';
import type { Ref } from 'react';
import styles from './RepoMessageList.module.css';

/** 저장소별 메시지 칸 하나 (커밋될 저장소 하나) */
export interface RepoMessageRow {
  path: string;
  name: string;
  /** stage 된 파일 수 */
  files: number;
  /** 저장소별 메시지 초안. 비었거나 공백뿐이면 공통 메시지로 커밋한다 */
  message: string;
  /** "이 저장소만 커밋"을 막는 사유. 누를 수 있으면 null */
  blocked: string | null;
}

/** 커밋 영역에 넘기는 저장소별 메시지 묶음 */
export interface RepoMessagesProps {
  /** 커밋될 저장소 (계획 순서) */
  rows: readonly RepoMessageRow[];
  /** 빈 칸의 안내 글자 (공통 메시지의 첫 줄) */
  placeholder: string;
  onChange: (path: string, message: string) => void;
  /** 그 저장소 하나만 커밋한다 (같은 커밋 흐름, 대상만 좁힌다) */
  onCommitOne: (path: string) => void;
}

export interface RepoMessageListProps extends RepoMessagesProps {
  /** 커밋이 도는 중 (칸·단추를 막는다) */
  committing: boolean;
  /** 첫 메시지 칸 (떠 있는 창을 열 때 포커스를 줄 곳) */
  firstRef?: Ref<HTMLTextAreaElement>;
}

/**
 * 저장소별 커밋 메시지 목록 (커밋 영역의 대상 줄을 눌러 여는 떠 있는 창 안): 커밋될 저장소마다 이름·파일 수·
 * "이 저장소만 커밋" 단추와 메시지 칸. 칸을 비우면 공통 메시지로 커밋하고, 빈 칸의 안내 글자가 공통 메시지의 첫 줄을
 * 보인다. 받은 값과 동작만 그린다
 */
export function RepoMessageList({
  rows,
  placeholder,
  onChange,
  onCommitOne,
  committing,
  firstRef,
}: RepoMessageListProps) {
  const t = S.commitTool;
  return (
    <div className={styles.list}>
      <p className={styles.hint}>{t.repoMessagesHint}</p>
      <ul className={styles.rows} aria-label={t.repoMessagesLabel}>
        {rows.map((row, index) => (
          <li key={row.path} className={styles.row}>
            <div className={styles.head}>
              <span className={styles.name} title={row.path}>
                {row.name}
              </span>
              <span className={styles.files}>{t.files(row.files)}</span>
              <Button
                size="compact"
                className={styles.commit}
                disabled={committing || row.blocked !== null}
                title={row.blocked ?? t.commitOnly}
                onClick={() => onCommitOne(row.path)}
              >
                {t.commitOnly}
              </Button>
            </div>
            <textarea
              ref={index === 0 ? firstRef : undefined}
              className={styles.message}
              aria-label={t.repoMessage(row.name)}
              placeholder={placeholder}
              rows={2}
              value={row.message}
              readOnly={committing}
              onChange={(e) => onChange(row.path, e.target.value)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
