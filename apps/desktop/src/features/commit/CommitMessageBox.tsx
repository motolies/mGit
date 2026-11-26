import { Button, formatShortcut, Icon, Popover, S } from '@mgit/ui';
import { useEffect, useRef, useState } from 'react';
import { registerCommand } from '../../command-registry';
import { useAppStore } from '../../store';
import styles from './CommitMessageBox.module.css';
import { skipSummary, type TargetsSummary } from './commit-plan';
import { RepoMessageList, type RepoMessagesProps } from './RepoMessageList';

/** 커밋 단축키 (입력란 안에서만 받는다 — 저장소 탭의 커밋 폼과 같다) */
const COMMIT_SHORTCUT = 'mod+enter';

export interface CommitMessageBoxProps {
  message: string;
  onMessageChange: (message: string) => void;
  /**
   * 누르기 전에 보이는 대상 (`저장소 N개 · 파일 M개`, 자기 메시지로 커밋될 저장소가 있으면 그 수)과 툴팁. 커밋될 것이
   * 없으면 null
   */
  targets: TargetsSummary | null;
  /**
   * 저장소별 메시지. 있으면 대상 줄이 펼침 단추가 되어, 누르면 떠 있는 창에서 커밋될 저장소마다 공통 메시지를
   * 덮어쓰고 그 저장소만 커밋한다. 없으면(커밋될 저장소가 하나뿐 등) 대상 줄은 글자뿐이다
   */
  repoMessages?: RepoMessagesProps | null;
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
 * 꺼지고 툴팁이 사유를 말한다. 저장소별 메시지를 받으면 대상 줄을 눌러 떠 있는 창(`RepoMessageList`)에서 저장소마다
 * 메시지를 덮어쓰고 그 저장소만 커밋한다 — 기본 화면은 그대로이고 펼칠 때만 보인다.
 * ⌘Enter 로 커밋 (한글 조합 중에는 무시 — 단축키는 입력란의 안내 글자와 버튼 툴팁에 보인다).
 * 받은 값과 동작만 그린다
 */
export function CommitMessageBox({
  message,
  onMessageChange,
  targets,
  repoMessages = null,
  skipped,
  blocked,
  committing,
  onCommit,
  onCommitAndPush,
}: CommitMessageBoxProps) {
  const [expanded, setExpanded] = useState(false);
  const [toggle, setToggle] = useState<HTMLButtonElement | null>(null);
  const [messagesOpen, setMessagesOpen] = useState(false);
  const [targetsToggle, setTargetsToggle] = useState<HTMLButtonElement | null>(null);
  const firstRepoMessage = useRef<HTMLTextAreaElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  // 저장소별 메시지를 더 받지 않으면(대상이 하나로 줄었다 등) 펼침을 접는다 — 다시 생겼을 때 저절로 열리지 않게
  const hasRepoMessages = repoMessages !== null && targets !== null;
  useEffect(() => {
    if (!hasRepoMessages) {
      setMessagesOpen(false);
    }
  }, [hasRepoMessages]);
  const override = useAppStore((s) => s.shortcutOverrides['commit.execute']);
  // 입력 영역의 유효 명령만 등록한다. IME·수정키·사용자 재지정은 공통 키맵이 판정한다.
  useEffect(() => {
    if (!ref.current) return;
    return registerCommand('commit.execute', ref.current, {
      enabled: () => blocked === null && !committing,
      reason: () => blocked ?? undefined,
      run: onCommit,
    });
  }, [blocked, committing, onCommit]);
  const t = S.commitTool;
  const shortcut = formatShortcut(override === undefined ? COMMIT_SHORTCUT : (override ?? ''));
  const summary = skipSummary(skipped);
  const open = expanded && summary !== null;
  const messagesShown = messagesOpen && hasRepoMessages;
  return (
    <div ref={ref} className={styles.box} data-command-scope="commit-input">
      <textarea
        data-commit-message
        className={styles.message}
        aria-label={t.message}
        placeholder={t.messageHint(shortcut)}
        value={message}
        readOnly={committing}
        onChange={(e) => onMessageChange(e.target.value)}
      />
      {targets !== null && repoMessages !== null ? (
        <button
          ref={setTargetsToggle}
          type="button"
          className={styles.targetsToggle}
          aria-haspopup="dialog"
          aria-expanded={messagesShown}
          title={`${targets.detail}\n${t.repoMessagesTip}`}
          onClick={() => setMessagesOpen(!messagesOpen)}
        >
          <span className={styles.targetsText}>{targets.text}</span>
          <Icon name={messagesShown ? 'chevronDown' : 'chevronRight'} />
        </button>
      ) : targets !== null ? (
        <div className={styles.targets} title={targets.detail}>
          {targets.text}
        </div>
      ) : null}
      {/* 저장소별 메시지도 떠 있는 창으로 편다 — 낮은 칸에서도 메시지 칸과 단추 줄을 밀어내지 않는다 */}
      <Popover
        open={messagesShown}
        anchor={targetsToggle}
        label={t.repoMessagesLabel}
        initialFocus={firstRepoMessage}
        onClose={(reason) => {
          setMessagesOpen(false);
          if (reason === 'escape') {
            targetsToggle?.focus();
          }
        }}
      >
        {repoMessages !== null ? (
          <RepoMessageList {...repoMessages} committing={committing} firstRef={firstRepoMessage} />
        ) : null}
      </Popover>
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
