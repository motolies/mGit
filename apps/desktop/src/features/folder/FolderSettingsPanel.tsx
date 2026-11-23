import type { BatchPullMode, FolderSettings } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useEffect, useState } from 'react';
import { useAppStore, useFolder } from '../../store';
import styles from './FolderExtra.module.css';

/** 기본 설정 */
const DEFAULTS: FolderSettings = {
  exclude: [],
  pullMode: 'ffOnly',
  concurrency: 4,
  autoRefreshSecs: 60,
  worktreeRoot: null,
};

/** 쉼표로 나눈 제외 목록 입력을 값으로 */
export function parseExclude(text: string): string[] {
  return text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 폴더별 설정 (MR-11): 제외 저장소·pull 방식·동시 실행·자동 갱신·워크트리 폴더 */
export function FolderSettingsPanel() {
  const f = useFolder((st) => ({
    settings: st.settings,
    error: st.error,
    load: st.loadSettings,
    save: st.saveSettings,
  }));
  const pickDirectory = useAppStore((s) => s.pickDirectory);
  const [draft, setDraft] = useState<FolderSettings>(DEFAULTS);
  // 제외 목록은 입력 그대로 둔다. 값으로 바꿔 되돌려 넣으면 쉼표·공백이 입력 중에 사라진다
  const [excludeText, setExcludeText] = useState('');
  const [saved, setSaved] = useState(false);
  // 마지막 저장이 실패했는지. 사유는 폴더 스토어의 `error` 다 (다른 작업의 오류는 여기에 보이지 않는다)
  const [failed, setFailed] = useState(false);
  const settings = f?.settings;
  useEffect(() => {
    if (settings) {
      setDraft(settings);
      setExcludeText(settings.exclude.join(', '));
    }
  }, [settings]);
  if (!f) {
    return null;
  }
  const t = S.folder.settings;

  /** 저장에 성공하면 잠깐 표시하고, 실패하면 사유를 저장 버튼 위에 보인다 */
  const save = async () => {
    setSaved(false);
    setFailed(false);
    if (await f.save({ ...draft, exclude: parseExclude(excludeText) })) {
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } else {
      setFailed(true);
    }
  };

  return (
    <div className={styles.panel}>
      <div className={styles.form}>
        <label className={styles.field}>
          {t.exclude}
          <input
            className={styles.input}
            value={excludeText}
            onChange={(e) => setExcludeText(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          {t.pullMode}
          <select
            className={styles.input}
            value={draft.pullMode}
            onChange={(e) => setDraft({ ...draft, pullMode: e.target.value as BatchPullMode })}
          >
            <option value="ffOnly">{t.ffOnly}</option>
            <option value="rebase">{t.rebase}</option>
            <option value="merge">{t.merge}</option>
          </select>
        </label>
        <label className={styles.field}>
          {t.concurrency}
          <input
            className={styles.input}
            type="number"
            min={1}
            max={16}
            value={draft.concurrency}
            onChange={(e) =>
              setDraft({
                ...draft,
                concurrency: Math.min(16, Math.max(1, Number.parseInt(e.target.value, 10) || 1)),
              })
            }
          />
        </label>
        <label className={styles.field}>
          {t.autoRefresh}
          <input
            className={styles.input}
            type="number"
            min={0}
            max={3600}
            value={draft.autoRefreshSecs}
            onChange={(e) =>
              setDraft({
                ...draft,
                autoRefreshSecs: Math.max(0, Number.parseInt(e.target.value, 10) || 0),
              })
            }
          />
        </label>
        <label className={styles.field}>
          {t.worktreeRoot}
          <span className={styles.batchRow}>
            <input
              className={styles.input}
              value={draft.worktreeRoot ?? ''}
              onChange={(e) => setDraft({ ...draft, worktreeRoot: e.target.value || null })}
            />
            <Button
              onClick={() =>
                void pickDirectory(t.worktreeRoot).then((p) => {
                  if (p) {
                    setDraft({ ...draft, worktreeRoot: p });
                  }
                })
              }
            >
              …
            </Button>
          </span>
        </label>
        {failed && f.error ? (
          <div className={styles.saveError} role="alert">
            {f.error}
          </div>
        ) : null}
        <div className={styles.batchRow}>
          <Button variant="primary" onClick={() => void save()}>
            {t.save}
          </Button>
          {saved ? <span className={styles.muted}>{t.saved}</span> : null}
        </div>
      </div>
    </div>
  );
}
