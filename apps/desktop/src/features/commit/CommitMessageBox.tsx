import { Button, formatShortcut, Icon, isImeKey, isPrimaryModifier, Popover, S } from '@mgit/ui';
import { type KeyboardEvent, useState } from 'react';
import styles from './CommitMessageBox.module.css';
import { skipSummary } from './commit-plan';

/** 커밋 단축키 (입력란 안에서만 받는다 — 저장소 탭의 커밋 폼과 같다) */
const COMMIT_SHORTCUT = 'mod+enter';

export interface CommitMessageBoxProps {
  message: string;
  onMessageChange: (message: string) => void;
  /** 누르기 전에 보이는 대상 (`저장소 N개 · 파일 M개`). 커밋될 것이 없으면 null */
  targets: string | null;
  /** stage 는 됐지만 커밋되지 않을 저장소와 사유 (한 줄씩) */
  skipped: readonly string[];
  /** 커밋을 막는 사유 (버튼 툴팁). null 이면 누를 수 있다 */
  blocked: string | null;
  /** 커밋이 도는 중 (입력란·버튼을 막는다) */
  committing: boolean;
  onCommit: () => void;
  /** 있으면 "Commit and Push…" 버튼 (커밋 뒤 커밋된 저장소로 push 체크 목록을 연다) */
  onCommitAndPush?: () => void;
}

/**
 * Commit 도구 창의 커밋 영역 (W14, W19 낮은 모양): 여러 줄 메시지 + 커밋 버튼 한 줄. 받은 높이를 메시지 입력란이 채우고
 * (분할선으로 정한다), 대상(저장소·파일 수)과 커밋되지 않을 저장소는 한 줄씩이다 — 커밋되지 않을 저장소는 접힌 한 줄
 * (`skipSummary`)이고 누르면 저장소별 사유가 떠 있는 창(`Popover`)으로 펼쳐진다(툴팁에도 있다). 막혀 있으면 버튼이
 * 꺼지고 툴팁이 사유를 말한다.
 * ⌘Enter 로 커밋 (한글 조합 중에는 무시 — 단축키는 입력란의 안내 글자와 버튼 툴팁에 보인다).
 * 받은 값과 동작만 그린다
 */
export function CommitMessageBox({
  message,
  onMessageChange,
  targets,
  skipped,
  blocked,
  committing,
  onCommit,
  onCommitAndPush,
}: CommitMessageBoxProps) {
  const [expanded, setExpanded] = useState(false);
  const [toggle, setToggle] = useState<HTMLButtonElement | null>(null);
  /** ⌘Enter 로 커밋한다. 막혀 있으면 아무것도 하지 않는다 */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKey(e) || !isPrimaryModifier(e) || e.key !== 'Enter') {
      return;
    }
    e.preventDefault();
    if (blocked === null) {
      onCommit();
    }
  };
  const t = S.commitTool;
  const shortcut = formatShortcut(COMMIT_SHORTCUT);
  const summary = skipSummary(skipped);
  const open = expanded && summary !== null;
  return (
    <div className={styles.box}>
      <textarea
        className={styles.message}
        aria-label={t.message}
        placeholder={t.messageHint(shortcut)}
        value={message}
        readOnly={committing}
        onChange={(e) => onMessageChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      {targets !== null ? (
        <div className={styles.targets} title={targets}>
          {targets}
        </div>
      ) : null}
      {summary !== null ? (
        <button
          ref={setToggle}
          type="button"
          className={styles.skipToggle}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={summary.detail}
          onClick={() => setExpanded(!expanded)}
        >
          <span className={styles.skipIcon}>
            <Icon name="warning" />
          </span>
          <span className={styles.skipText}>{summary.text}</span>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} />
        </button>
      ) : null}
      {/* 저장소별 사유는 떠 있는 창으로 편다 — 낮은 칸에서도 단추 줄을 밀어내지 않는다 */}
      <Popover
        open={open}
        anchor={toggle}
        label={t.skippedLabel}
        onClose={(reason) => {
          setExpanded(false);
          if (reason === 'escape') {
            toggle?.focus();
          }
        }}
      >
        <ul className={styles.skipList} aria-label={t.skippedLabel}>
          {skipped.map((line) => (
            <li key={line} className={styles.skip}>
              <span className={styles.skipIcon}>
                <Icon name="warning" />
              </span>
              {line}
            </li>
          ))}
        </ul>
      </Popover>
      <div className={styles.actions}>
        <Button
          variant="primary"
          className={styles.action}
          disabled={blocked !== null}
          title={blocked ?? shortcut}
          onClick={onCommit}
        >
          <span className={styles.actionLabel}>{committing ? t.committing : t.commit}</span>
        </Button>
        {onCommitAndPush ? (
          <Button
            className={styles.action}
            disabled={blocked !== null}
            title={blocked ?? t.commitAndPush}
            onClick={onCommitAndPush}
          >
            <span className={styles.actionLabel}>{t.commitAndPush}</span>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
