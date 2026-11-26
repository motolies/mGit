import type { GroupListItem, GroupMemberState, GroupPathCheck, RepoKind } from '@mgit/ipc';
import { Button, S } from '@mgit/ui';
import { useEffect, useRef, useState } from 'react';
import { useDialogs } from '../../components/use-dialogs';
import { useModal } from '../../components/use-modal';
import { useAppStore } from '../../store';
import type { GroupDialogRequest } from '../../store/app-store';
import { describeError } from '../../store/errors';
import styles from './GroupDialog.module.css';
import { aliasProblem, locateRepo } from './group-edits';

/** 대화상자에서 고치는 멤버 하나 (별칭·위치와 지금 상태) */
export interface DraftMember {
  alias: string;
  path: string;
  state: GroupMemberState;
  kind: RepoKind | null;
}

/** 별칭이 겹치면(대소문자 무시) 뒤에 `-2`, `-3`… 을 붙여 비운다 (편집 중 추가한 저장소가 지금 목록과 겹칠 때) */
export function uniqueAlias(alias: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(alias.toLowerCase())) return alias;
  for (let n = 2; ; n += 1) {
    const candidate = `${alias}-${n}`;
    if (!lower.has(candidate.toLowerCase())) return candidate;
  }
}

/** 경로 확인 한 줄의 거부 문구 (`경로: 이유`) */
export function skippedLine(check: GroupPathCheck): string {
  return check.issue ? `${check.path}: ${S.group.issue[check.issue]}` : check.path;
}

/** 멤버 목록의 첫 별칭 문제 문구 (편집의 별칭 칸). 없으면 null */
export function aliasError(members: readonly Pick<DraftMember, 'alias'>[]): string | null {
  for (const [i, m] of members.entries()) {
    const problem = aliasProblem(
      m.alias,
      members.filter((_, j) => j !== i).map((o) => o.alias),
    );
    if (problem === 'invalid') return S.group.aliasInvalid(m.alias);
    if (problem === 'duplicate') return S.group.aliasDuplicate(m.alias);
  }
  return null;
}

/** 저장된 그룹 → 대화상자의 멤버 목록 */
function draftOf(group: GroupListItem | undefined): DraftMember[] {
  return (group?.members ?? []).map((m) => ({
    alias: m.alias,
    path: m.path,
    state: m.state,
    kind: m.kind ?? null,
  }));
}

/**
 * 그룹 대화상자 (MR-13): 새 그룹 만들기와 그룹 편집. 저장소 추가(저장소 하나)·폴더에서 추가(그 아래 저장소들)·빼기·위치 다시
 * 지정(별칭은 그대로)을 하고, 편집이면 별칭도 바꾼 뒤 저장한다. 판정(저장소인지·중복·중첩)은 코어의 경로 확인이 하고, 새
 * 그룹은 만들 때 코어가 별칭을 다시 정한다. 열린 그룹은 탭을 연 채로 고친다 (`updateGroup`, M4)
 */
export function GroupDialog() {
  const request = useAppStore((s) => s.groupDialog);
  const setGroupDialog = useAppStore((s) => s.setGroupDialog);
  const ref = useModal(request !== null);
  const close = () => setGroupDialog(null);
  return (
    <dialog ref={ref} className={styles.dialog} onClose={close}>
      {request ? (
        <GroupDialogBody
          key={request.mode === 'edit' ? `edit:${request.id}` : 'create'}
          request={request}
          close={close}
        />
      ) : null}
    </dialog>
  );
}

/** 대화상자 본문. 요청이 바뀌면 새로 만들어 상태를 처음부터 채운다 */
function GroupDialogBody({ request, close }: { request: GroupDialogRequest; close: () => void }) {
  const client = useAppStore((s) => s.client);
  const pickDirectory = useAppStore((s) => s.pickDirectory);
  const createGroup = useAppStore((s) => s.createGroup);
  const updateGroup = useAppStore((s) => s.updateGroup);
  const deleteGroup = useAppStore((s) => s.deleteGroup);
  const editing = useAppStore((s) =>
    request.mode === 'edit' ? s.groups.find((g) => g.id === request.id) : undefined,
  );
  const isOpen = useAppStore((s) =>
    request.mode === 'edit'
      ? Object.values(s.sessions).some((m) => m.path === `mgit-group:${request.id}`)
      : false,
  );
  const dialogs = useDialogs();
  const [name, setName] = useState(
    request.mode === 'edit' ? (editing?.name ?? '') : (request.name ?? ''),
  );
  const [members, setMembers] = useState<DraftMember[]>(() => draftOf(editing));
  const [skipped, setSkipped] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const membersRef = useRef(members);
  membersRef.current = members;
  // 편집의 별칭 칸 검사 (문제가 있으면 저장을 막는다)
  const aliasMessage = request.mode === 'edit' ? aliasError(members) : null;

  /** 고른 경로들을 지금 목록에 더한다. 새 그룹은 지금 목록과 함께 다시 판정해 별칭을 코어와 같게 맞추고, 편집은 저장된
   * 그룹에 견준 판정에 지금 목록과의 중복·별칭 겹침을 더 거른다 */
  const addPaths = async (paths: readonly string[]) => {
    if (paths.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const current = membersRef.current;
      if (request.mode === 'create') {
        const rows = await client.groupCheckPaths(null, [...current.map((m) => m.path), ...paths]);
        setMembers(
          rows.flatMap((r) =>
            r.issue || !r.alias
              ? []
              : [{ alias: r.alias, path: r.path, state: 'present' as const, kind: r.kind ?? null }],
          ),
        );
        setSkipped(rows.filter((r) => r.issue && paths.includes(r.input)).map(skippedLine));
      } else {
        const rows = await client.groupCheckPaths(request.id, paths);
        const next = [...current];
        const missed: string[] = [];
        for (const r of rows) {
          if (r.issue || !r.alias) {
            missed.push(skippedLine(r));
          } else if (next.some((m) => m.path === r.path)) {
            missed.push(`${r.path}: ${S.group.issue.duplicate}`);
          } else {
            next.push({
              alias: uniqueAlias(
                r.alias,
                next.map((m) => m.alias),
              ),
              path: r.path,
              state: 'present',
              kind: r.kind ?? null,
            });
          }
        }
        setMembers(next);
        setSkipped(missed);
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  // "이 폴더로 그룹 만들기": 미리 준 경로를 처음 한 번 펼친다
  // biome-ignore lint/correctness/useExhaustiveDependencies: 대화상자를 열 때 한 번만 채운다
  useEffect(() => {
    if (request.mode === 'create' && request.paths && request.paths.length > 0) {
      void addPaths(request.paths);
    }
  }, []);

  /** 폴더 선택 창으로 저장소 하나(또는 그 폴더 아래 저장소들)를 더한다 */
  const pickAndAdd = async (title: string) => {
    const path = await pickDirectory(title);
    if (path) await addPaths([path]);
  };

  /** 멤버 하나의 위치를 다시 고른다 (별칭은 그대로). 고른 곳이 저장소 하나로 판정돼야 한다 */
  const relocate = async (index: number) => {
    const member = membersRef.current[index];
    if (!member) return;
    const path = await pickDirectory(S.group.pickRelocate(member.alias));
    if (!path) return;
    setBusy(true);
    setError(null);
    try {
      const found = await locateRepo(client, path);
      if (!found) {
        setError(S.group.relocateNotRepo);
      } else if (membersRef.current.some((m, i) => i !== index && m.path === found.path)) {
        setError(`${found.path}: ${S.group.issue.duplicate}`);
      } else {
        setMembers(
          membersRef.current.map((m, i) =>
            i === index ? { ...m, path: found.path, state: 'present', kind: found.kind } : m,
          ),
        );
      }
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  /** 저장: 새 그룹이면 만들고 열고, 편집이면 고친다 (열린 그룹은 연 채로 반영한다) */
  const save = async () => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(S.group.nameRequired);
      return;
    }
    if (members.length === 0) {
      setError(S.group.noMembers);
      return;
    }
    if (aliasMessage !== null) return;
    setBusy(true);
    setError(null);
    const ok =
      request.mode === 'create'
        ? await createGroup(
            trimmed,
            members.map((m) => m.path),
          )
        : await updateGroup(request.id, {
            name: trimmed,
            members: members.map((m) => ({ alias: m.alias, path: m.path })),
          });
    setBusy(false);
    if (ok) close();
    else if (request.mode === 'create') setError(useAppStore.getState().lastError);
  };

  /** 그룹 지우기 (확인 뒤) */
  const remove = async () => {
    if (request.mode !== 'edit') return;
    const sure = await dialogs.confirm({
      title: S.group.remove,
      message: S.group.removeConfirm(name),
      confirmLabel: S.group.remove,
      danger: true,
    });
    if (!sure) return;
    if (await deleteGroup(request.id)) close();
  };

  /** 멤버 `index` 의 별칭을 바꾼다 (편집만 — 새 그룹은 만들 때 코어가 정한다) */
  const renameAlias = (index: number, alias: string) => {
    setMembers(membersRef.current.map((m, i) => (i === index ? { ...m, alias } : m)));
  };

  const title =
    request.mode === 'edit' ? S.group.editTitle(editing?.name ?? '') : S.group.createTitle;
  return (
    <div className={styles.box}>
      <header className={styles.header}>
        <span className={styles.title}>{title}</span>
        <span className={styles.spacer} />
      </header>
      <label className={styles.field}>
        <span>{S.group.name}</span>
        <input
          aria-label={S.group.name}
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className={styles.tools}>
        <Button disabled={busy} onClick={() => void pickAndAdd(S.group.pickRepo)}>
          {S.group.addRepo}
        </Button>
        <Button disabled={busy} onClick={() => void pickAndAdd(S.group.pickFolder)}>
          {S.group.addFromFolder}
        </Button>
      </div>
      <ul className={styles.list} aria-label={S.group.members}>
        {members.length === 0 ? <li className={styles.empty}>{S.group.noMembers}</li> : null}
        {members.map((m, i) => (
          <li key={m.path} className={styles.member}>
            {request.mode === 'edit' ? (
              <input
                className={styles.aliasInput}
                aria-label={`${S.group.alias}: ${m.path}`}
                title={`${S.group.alias}: ${m.alias}`}
                aria-invalid={
                  aliasProblem(
                    m.alias,
                    members.filter((_, j) => j !== i).map((o) => o.alias),
                  ) !== null
                }
                value={m.alias}
                disabled={busy}
                onChange={(e) => renameAlias(i, e.target.value)}
              />
            ) : (
              <span className={styles.alias} title={`${S.group.alias}: ${m.alias}`}>
                {m.alias}
              </span>
            )}
            <span className={styles.path} title={m.path}>
              {m.path}
              {m.state !== 'present' ? (
                <span className={styles.state}> · {S.group.state[m.state]}</span>
              ) : null}
            </span>
            {request.mode === 'edit' ? (
              <Button
                disabled={busy}
                aria-label={`${S.group.relocate} ${m.alias}`}
                onClick={() => void relocate(i)}
              >
                {S.group.relocate}
              </Button>
            ) : (
              <span />
            )}
            <Button
              disabled={busy}
              aria-label={`${S.group.exclude}: ${m.alias}`}
              onClick={() => setMembers(members.filter((_, j) => j !== i))}
            >
              {S.group.exclude}
            </Button>
          </li>
        ))}
      </ul>
      {skipped.length > 0 ? (
        <div role="status">
          <div className={styles.note}>{S.group.skipped(skipped.length)}</div>
          <ul className={styles.skipped}>
            {skipped.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {isOpen ? <div className={styles.note}>{S.group.openNote}</div> : null}
      {(error ?? aliasMessage) ? (
        <div role="alert" className={styles.error}>
          {error ?? aliasMessage}
        </div>
      ) : null}
      <footer className={styles.footer}>
        {request.mode === 'edit' ? (
          <Button disabled={busy} onClick={() => void remove()}>
            {S.group.remove}
          </Button>
        ) : null}
        <span className={styles.spacer} />
        <Button onClick={close}>{S.group.cancel}</Button>
        <Button
          variant="primary"
          disabled={busy || aliasMessage !== null}
          onClick={() => void save()}
        >
          {request.mode === 'edit' ? S.group.save : S.group.createButton}
        </Button>
      </footer>
      {dialogs.element}
    </div>
  );
}
