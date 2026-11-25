import type { FsOperationDecision, FsOperationPlan } from '@mgit/ipc';
import { Button, formatBytes, formatDateTime, useNativeDialog } from '@mgit/ui';
import { useState } from 'react';
import { baseName, isWithin } from '../../store/fs-path';
import styles from './ProjectEditing.module.css';
import { projectEditStrings } from './project-edit-strings';

/** 복사본 이름은 확장자를 유지하며 입력 가능한 제안으로 표시한다. */
export function suggestedCopyName(path: string, directory: boolean): string {
  const name = baseName(path);
  const dot = directory ? -1 : name.lastIndexOf('.');
  return dot > 0
    ? `${name.slice(0, dot)}${projectEditStrings().copySuffix}${name.slice(dot)}`
    : `${name}${projectEditStrings().copySuffix}`;
}

/** 충돌 항목별 결정을 받아 전체 작업에 적용한다. 폴더끼리만 병합을 제공한다. */
export function FileConflictDialog({
  plan,
  onResolve,
}: {
  plan: FsOperationPlan;
  onResolve: (decisions: FsOperationDecision[] | null) => void;
}) {
  const t = projectEditStrings();
  const { ref, dialogProps } = useNativeDialog(true, () => onResolve(null));
  const conflicts = plan.items.filter((item) => item.conflict !== 'none' && !item.error);
  const [decisions, setDecisions] = useState<Record<string, FsOperationDecision>>({});
  const decision = (id: string): FsOperationDecision =>
    decisions[id] ?? { itemId: id, action: 'skip', name: null };
  return (
    <dialog ref={ref} {...dialogProps} className={styles.dialog} aria-label={t.conflicts}>
      <h2>{t.conflicts}</h2>
      <div className={styles.conflicts}>
        {conflicts.map((item) => {
          const value = decision(item.id);
          const inherited = conflicts.some(
            (parent) =>
              parent.id !== item.id &&
              parent.directory &&
              parent.destination &&
              item.destination &&
              isWithin(item.destination, parent.destination) &&
              ['skip', 'rename'].includes(decision(parent.id).action),
          );
          return (
            <section key={item.id} className={styles.conflict}>
              <div>
                {item.source} → {item.destination}
              </div>
              <div>
                {t.source}: {formatBytes(item.sourceSize)} ·{' '}
                {item.sourceMtimeMs == null ? '—' : formatDateTime(item.sourceMtimeMs / 1000)}
              </div>
              <div>
                {t.destination}: {formatBytes(item.destinationSize)} ·{' '}
                {item.destinationMtimeMs == null
                  ? '—'
                  : formatDateTime(item.destinationMtimeMs / 1000)}
              </div>
              {item.conflict === 'type' ? <p>{t.replaceType}</p> : null}
              {inherited ? <p>{t.parentDecision}</p> : null}
              <select
                disabled={inherited}
                aria-label={item.destination ?? item.id}
                value={value.action}
                onChange={(e) =>
                  setDecisions({
                    ...decisions,
                    [item.id]: {
                      ...value,
                      action: e.target.value as FsOperationDecision['action'],
                      name: suggestedCopyName(item.destination ?? '', item.directory),
                    },
                  })
                }
              >
                <option value="skip">{t.skip}</option>
                <option value={item.conflict === 'directory' ? 'merge' : 'overwrite'}>
                  {item.conflict === 'directory' ? t.merge : t.overwrite}
                </option>
                <option value="rename">{t.newName}</option>
              </select>
              {value.action === 'rename' ? (
                <input
                  aria-label={t.newName}
                  disabled={inherited}
                  value={value.name ?? ''}
                  onChange={(e) =>
                    setDecisions({ ...decisions, [item.id]: { ...value, name: e.target.value } })
                  }
                />
              ) : null}
              <Button
                disabled={inherited}
                onClick={() =>
                  setDecisions(
                    Object.fromEntries(
                      conflicts
                        .filter((other) => other.conflict === item.conflict)
                        .map<[string, FsOperationDecision]>((other) => [
                          other.id,
                          {
                            ...value,
                            itemId: other.id,
                            name:
                              value.action === 'rename'
                                ? suggestedCopyName(other.destination ?? '', other.directory)
                                : value.name,
                          },
                        ])
                        .concat(
                          Object.entries(decisions).filter(
                            ([id]) =>
                              !conflicts.some(
                                (other) => other.id === id && other.conflict === item.conflict,
                              ),
                          ),
                        ),
                    ),
                  )
                }
              >
                {t.all}
              </Button>
            </section>
          );
        })}
      </div>
      <footer>
        <Button onClick={() => onResolve(null)}>{t.cancel}</Button>
        <Button
          variant="primary"
          disabled={Object.values(decisions).some(
            (item) =>
              item.action === 'rename' &&
              (!item.name?.trim() ||
                ['.', '..', '.git'].includes(item.name.toLowerCase()) ||
                /[\\/]/.test(item.name)),
          )}
          onClick={() => onResolve(conflicts.map((item) => decision(item.id)))}
        >
          {t.apply}
        </Button>
      </footer>
    </dialog>
  );
}
