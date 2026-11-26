import type { GroupInfo } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useState } from 'react';
import { useAppStore } from '../../store';
import { describeError } from '../../store/errors';
import styles from '../folder/Dashboard.module.css';
import { locateRepo, relocated, without } from './group-edits';

/**
 * 그룹 대시보드의 "찾을 수 없는 저장소" 줄 (MR-13): 지금 저장소가 없거나 저장소가 아니게 된 멤버를 보이고 **위치 다시
 * 지정…**·**빼기** 를 단다. 고치면 그룹 탭을 연 채로 반영한다 (`updateGroup` — 그 멤버의 파일 탭은 초안 확인 뒤 닫는다)
 */
export function GroupMissingMembers({ group }: { group: GroupInfo }) {
  const client = useAppStore((s) => s.client);
  const pickDirectory = useAppStore((s) => s.pickDirectory);
  const updateGroup = useAppStore((s) => s.updateGroup);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lost = group.members.filter((m) => m.state !== 'present');
  if (lost.length === 0) return null;
  const refs = group.members.map((m) => ({ alias: m.alias, path: m.path }));

  /** 고친 멤버 목록으로 그룹을 고친다 */
  const apply = async (members: { alias: string; path: string }[]) => {
    setBusy(true);
    await updateGroup(group.id, { members });
    setBusy(false);
  };

  /** 멤버의 새 위치를 골라 고친다 (별칭은 그대로) */
  const relocate = async (alias: string) => {
    const picked = await pickDirectory(S.group.pickRelocate(alias));
    if (!picked) return;
    setError(null);
    try {
      const repo = await locateRepo(client, picked);
      const next = repo ? relocated(refs, alias, repo.path) : null;
      if (!repo) setError(S.group.relocateNotRepo);
      else if (!next) setError(`${repo.path}: ${S.group.issue.duplicate}`);
      else await apply(next);
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <section className={styles.error} aria-label={S.group.missingTitle}>
      <div>
        <strong>{S.group.missingTitle}</strong> — {S.group.missingHint}
      </div>
      <ul>
        {lost.map((m) => (
          <li key={m.alias}>
            <span>
              {m.alias} · {S.group.state[m.state === 'notRepo' ? 'notRepo' : 'missing']} · {m.path}
            </span>{' '}
            <Button
              disabled={busy}
              aria-label={`${S.group.relocate} ${m.alias}`}
              onClick={() => void relocate(m.alias)}
            >
              {S.group.relocate}
            </Button>{' '}
            <Button
              disabled={busy || group.members.length <= 1}
              aria-label={`${S.group.exclude}: ${m.alias}`}
              onClick={() => void apply(without(refs, m.alias))}
            >
              {S.group.exclude}
            </Button>
          </li>
        ))}
      </ul>
      {error ? <div role="alert">{error}</div> : null}
    </section>
  );
}
