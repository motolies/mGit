import { Button, isImeKey, isPrimaryModifier, S, shortHash } from '@mgit/ui';
import { useSession } from '../../store';
import styles from './CommitForm.module.css';

/** 메시지를 요약·본문으로 나눈다 (첫 빈 줄 기준) */
export function splitMessage(message: string): { summary: string; body: string } {
  const idx = message.indexOf('\n');
  if (idx < 0) {
    return { summary: message, body: '' };
  }
  return { summary: message.slice(0, idx), body: message.slice(idx + 1).replace(/^\n/, '') };
}

/** 요약·본문을 메시지로 합친다. 입력 중에도 불리므로 끝 공백을 지우지 않는다 (지우면 띄어쓰기가 먹힌다) */
export function joinMessage(summary: string, body: string): string {
  return body ? `${summary}\n\n${body}` : summary;
}

/** selector 가 매번 새 배열을 만들면 useShallow 가 같다고 보지 않아 무한 렌더가 난다 */
const NO_OUTPUT: string[] = [];

/** 커밋 입력란 (CHG-05·06). 요약·본문 분리, 50·72자 가이드, amend, --no-verify, hook 출력 */
export function CommitForm() {
  const s = useSession((st) => ({
    message: st.commitMessage,
    amend: st.commitAmend,
    templates: st.commitTemplates,
    noVerify: st.commitNoVerify,
    committing: st.committing,
    error: st.commitError,
    lastHash: st.lastCommitHash,
    staged: st.status.summary.staged,
    conflicted: st.status.summary.conflicted,
    hookOutput:
      st.lastCommitOpId === null
        ? NO_OUTPUT
        : (st.operations[st.lastCommitOpId]?.output ?? NO_OUTPUT),
    setMessage: st.setCommitMessage,
    setAmend: st.setCommitAmend,
    setNoVerify: st.setCommitNoVerify,
    commit: st.commit,
    sign: st.commitSign,
    signingInfo: st.signingInfo,
    setSign: st.setCommitSign,
    secretHits: st.secretHits,
    dismissSecrets: st.dismissSecrets,
    addSecretIgnore: st.addSecretIgnore,
  }));
  const { summary, body } = splitMessage(s.message);
  const canCommit =
    !s.committing && summary.trim() !== '' && s.conflicted === 0 && (s.staged > 0 || s.amend);
  const longBodyLine = body.split('\n').some((l) => l.length > 72);

  /** ⌘Enter 로 커밋. 한글 조합 중에는 무시 */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isImeKey(e) || !isPrimaryModifier(e) || e.key !== 'Enter') {
      return;
    }
    e.preventDefault();
    if (canCommit) {
      void s.commit();
    }
  };

  return (
    <div className={styles.form}>
      {s.templates.length > 0 ? (
        <select
          className={styles.template}
          value=""
          aria-label={S.safety.template}
          onChange={(e) => {
            const t = s.templates[Number(e.target.value)];
            if (t) {
              s.setMessage(t.body);
            }
          }}
        >
          <option value="">{S.safety.templateNone}</option>
          {s.templates.map((t, i) => (
            <option key={t.name} value={i}>
              {t.name}
            </option>
          ))}
        </select>
      ) : null}
      <input
        className={styles.summary}
        value={summary}
        placeholder={S.commit.summary}
        onChange={(e) => s.setMessage(joinMessage(e.target.value, body))}
        onKeyDown={onKeyDown}
        data-too-long={summary.length > 50 ? 'true' : 'false'}
      />
      <div className={styles.guide} data-too-long={summary.length > 50 ? 'true' : 'false'}>
        {S.commit.summaryGuide(summary.length)}
        {longBodyLine ? ` · ${S.commit.bodyLineTooLong}` : ''}
      </div>
      <textarea
        className={styles.body}
        value={body}
        placeholder={S.commit.body}
        rows={4}
        onChange={(e) => s.setMessage(joinMessage(summary, e.target.value))}
        onKeyDown={onKeyDown}
      />
      <div className={styles.options}>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={s.amend}
            onChange={(e) => void s.setAmend(e.target.checked)}
          />
          {S.commit.amend}
        </label>
        <label className={styles.option}>
          <input
            type="checkbox"
            checked={s.noVerify}
            onChange={(e) => s.setNoVerify(e.target.checked)}
          />
          {S.commit.noVerify}
        </label>
        <label
          className={styles.option}
          title={S.commit.signDefault(s.signingInfo?.commitSign ?? false)}
        >
          <input
            type="checkbox"
            checked={s.sign ?? s.signingInfo?.commitSign ?? false}
            onChange={(e) => s.setSign(e.target.checked)}
          />
          {S.commit.sign}
        </label>
        <Button
          variant="primary"
          disabled={!canCommit}
          onClick={() => void s.commit()}
          title="⌘Enter"
          className={styles.commitButton}
        >
          {s.committing ? S.commit.committing : S.commit.button}
        </Button>
      </div>
      {s.secretHits ? (
        <div className={styles.secrets}>
          <div className={styles.secretsTitle}>{S.commit.secretsTitle(s.secretHits.length)}</div>
          <div className={styles.hint}>{S.commit.secretsHint}</div>
          <ul className={styles.secretsList}>
            {s.secretHits.map((h) => (
              <li key={`${h.path}:${h.line}:${h.rule}`} className={styles.secretsItem}>
                <span className={styles.secretsPath}>
                  {h.path}:{h.line}
                </span>
                <span className={styles.secretsRule}>{h.rule}</span>
                <span className={styles.secretsSnippet}>{h.snippet}</span>
                <button
                  type="button"
                  className={styles.link}
                  onClick={() => void s.addSecretIgnore({ rule: h.rule, path: null })}
                >
                  {S.commit.secretsIgnoreRule}
                </button>
              </li>
            ))}
          </ul>
          <div className={styles.secretsActions}>
            <Button onClick={() => void s.commit({ ignoreSecrets: true })}>
              {S.commit.secretsCommitAnyway}
            </Button>
            <Button onClick={s.dismissSecrets}>{S.commit.secretsClose}</Button>
          </div>
        </div>
      ) : null}
      {s.staged === 0 && !s.amend ? (
        <div className={styles.hint}>{S.commit.nothingStaged}</div>
      ) : null}
      {s.error ? <div className={styles.error}>{s.error}</div> : null}
      {s.lastHash && !s.error ? (
        <div className={styles.hint}>{S.commit.done(shortHash(s.lastHash))}</div>
      ) : null}
      {s.hookOutput.length > 0 ? (
        <pre className={styles.hookOutput} title={S.commit.hookOutput}>
          {s.hookOutput.map((l) => (l.startsWith('!') ? l.slice(1) : l)).join('\n')}
        </pre>
      ) : null}
    </div>
  );
}
