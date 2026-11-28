import { useRovingToolbar } from '../../components/roving';
// 저장소 탭 에디터 공간의 태그 문서 (C3a·C3b·C4, TG-10~14). 원격 하나와 견준 tag 목록을 찾고·거르고·정렬하고, 여러 줄을
// 골라 한 번에 push·가져오기·삭제하고, 결과 칸에 실패만 남긴다. 데이터는 세션의 ref 라벨·로컬 tag 목록과 원격 tag
// 보고서(B5)이고, 화면 상태(원격·필터·검색·정렬·선택·여는 쪽의 요청)는 탭의 워크스페이스(`tagsView`)에 둔다. 목록은 가상
// listbox 라 tag 수천 개도 보이는 줄만 그린다. 문서 안 작업은 토스트를 띄우지 않는다 (TG-12 ③).

import type { TagSyncReport } from '@mgit/ipc';
import {
  Button,
  formatDateTime,
  formatTime,
  Icon,
  isPrimaryModifier,
  S,
  shortHash,
} from '@mgit/ui';
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ContextMenuArea, type MenuItem } from '../../components/ContextMenu';
import { openContextMenuAt } from '../../components/tree-keys';
import { useDialogs } from '../../components/use-dialogs';
import { useVirtualTree } from '../../components/use-virtual-tree';
import { type SessionState, useSession, useWorkspace } from '../../store';
import type { TagDeleteScope, TagDeleteSummary } from '../../store/tag-ops';
import {
  INITIAL_TAGS_VIEW,
  type TagFilter,
  type TagSortKey,
  type TagsViewState,
} from '../../store/workspace-store';
import styles from './TagsDoc.module.css';
import {
  confirmAlignToLocal,
  confirmAlignToRemote,
  confirmDiverged,
  deleteTagsFlow,
  isSlowTagBatch,
  type TagFlowDeps,
} from './tag-flows';
import {
  buildTagRows,
  canDeleteTag,
  canFetchTag,
  canPushTag,
  defaultTagRemote,
  TAG_FILTERS,
  type TagRow,
  tagFilterCounts,
  tagListClick,
  tagListKey,
  tagRowTitle,
  visibleTagRows,
} from './tag-list-model';
import { batchResultView, deleteResultView, type TagResultView } from './tag-results';
import { isChecked, tagStateText } from './tag-sync';

/** 글자를 클립보드에 넣는다 (실패는 조용히) */
function copyText(text: string): void {
  void navigator.clipboard.writeText(text).catch(() => {});
}

/** 원격 확인 상태 한 줄 (머리): 확인 중 / 실패 종류(+ 이전 확인 시각) / 확인 시각(+ 오래됨) / 확인 전 */
function checkStatus(
  report: TagSyncReport | undefined,
  checking: boolean,
): { text: string; failed: boolean } {
  if (checking) {
    return { text: S.tag.doc.checking, failed: false };
  }
  const at = report?.checkedAt;
  const when = at !== null && at !== undefined ? S.tag.doc.checkedAt(formatTime(at)) : null;
  if (report?.lastError) {
    const reason = S.tag.check.failed[report.lastError.kind];
    return { text: when ? `${reason} · ${when}` : reason, failed: true };
  }
  if (when) {
    return { text: report?.stale ? `${when} · ${S.tag.tree.stale}` : when, failed: false };
  }
  return { text: S.tag.doc.notChecked, failed: false };
}

/** 문서가 읽는 세션 상태와 동작 */
function pickTags(st: SessionState) {
  return {
    labels: st.refs.labels,
    remotes: st.refs.remotes,
    upstream: st.refs.labels.find((l) => l.isCurrent)?.upstream ?? null,
    tagReports: st.tagReports,
    tagChecking: st.tagChecking,
    busy: st.busy,
    inOp: st.op !== null,
    checkRemoteTags: st.checkRemoteTags,
    autoCheckRemoteTags: st.autoCheckRemoteTags,
    reloadRemoteTags: st.reloadRemoteTags,
    jumpToCommit: st.jumpToCommit,
    checkout: st.checkout,
    pushTags: st.pushTags,
    deleteTagsScoped: st.deleteTagsScoped,
    fetchTags: st.fetchTags,
    runTagBatch: st.runTagBatch,
    tagList: st.tagList,
    loadTagList: st.loadTagList,
  };
}
/**
 * 태그 문서 (TG-10): 머리(비교할 원격·확인 상태·원격 확인), 찾기와 상태 필터(개수, 확인 전에는 전체만), 열 머리(이름·
 * 상태 정렬), 가상 listbox(다중 선택 — ↑↓ Space ⇧↑↓ ⌘A Esc, Enter 로그에서 보기, ⇧F10 행 메뉴), 빈 상태
 */
export function TagsDoc() {
  const filterTools = useRovingToolbar<HTMLSpanElement>('horizontal');
  const batchTools = useRovingToolbar<HTMLDivElement>('horizontal');
  const s = useSession(pickTags);
  const view = useWorkspace((w) => w.tagsView) ?? INITIAL_TAGS_VIEW;
  const setTagsView = useWorkspace((w) => w.setTagsView);
  const dialogs = useDialogs();
  const baseId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  /** 화면 상태 일부를 바꾼다 */
  const setView = useCallback(
    (patch: Partial<TagsViewState>) => setTagsView?.(patch),
    [setTagsView],
  );

  const remoteNames = useMemo(() => s.remotes.map((r) => r.name), [s.remotes]);
  const remote =
    view.remote !== null && remoteNames.includes(view.remote)
      ? view.remote
      : defaultTagRemote(s.remotes, s.upstream);
  const report = remote === null ? undefined : s.tagReports[remote];
  const checked = isChecked(report);
  const checking = remote !== null && s.tagChecking.includes(remote);
  const status = checkStatus(report, checking);

  // 문서가 보이면 이미 확인한 보고서를 네트워크 없이 읽는다 (다른 탭이 확인한 같은 저장소의 캐시 포함)
  const reloadRemoteTags = s.reloadRemoteTags;
  useEffect(() => {
    if (remoteNames.length > 0) {
      void reloadRemoteTags({ all: true });
    }
  }, [reloadRemoteTags, remoteNames]);

  // 태그 창을 처음 열 때 보이는 원격(업스트림의 원격, 없으면 origin)을 한 번 확인한다. 그 뒤는 "원격 확인" 단추로 한다
  const autoCheckRemoteTags = s.autoCheckRemoteTags;
  useEffect(() => {
    if (remote !== null) {
      void autoCheckRemoteTags(remote);
    }
  }, [autoCheckRemoteTags, remote]);

  // 로컬 tag 목록(종류·날짜·제목)을 읽는다: 문서가 보일 때와 ref 가 바뀔 때 (C3b)
  const loadTagList = s.loadTagList;
  const labels = s.labels;
  useEffect(() => {
    void labels;
    void loadTagList();
  }, [loadTagList, labels]);

  const rows = useMemo(
    () => buildTagRows(s.labels, report, s.tagList),
    [s.labels, report, s.tagList],
  );
  const counts = useMemo(() => tagFilterCounts(rows), [rows]);
  // 확인 전에는 상태 필터가 뜻이 없다 — 전체로 본다 (단추도 꺼진다)
  const filter: TagFilter = checked ? view.filter : 'all';
  const visible = useMemo(
    () => visibleTagRows(rows, { filter, search: view.search, sort: view.sort }),
    [rows, filter, view.search, view.sort],
  );
  const names = useMemo(() => visible.map((r) => r.name), [visible]);
  const selected = useMemo(() => new Set(view.selected), [view.selected]);
  // 일괄 단추의 해당 개수 (TG-12 ①): 고른 줄 가운데 (필터로 숨은 줄 포함) 그 동작이 뜻이 있는 것
  const picked = useMemo(() => rows.filter((r) => selected.has(r.name)), [rows, selected]);
  const pushable = picked.filter(canPushTag).map((r) => r.name);
  const fetchable = picked.filter(canFetchTag).map((r) => r.name);
  const deletable = picked.filter(canDeleteTag).map((r) => r.name);
  const localNames = useMemo(() => new Set(rows.filter((r) => r.local).map((r) => r.name)), [rows]);

  const { virtualizer, rowHeight, scrollToRow } = useVirtualTree({
    scrollRef: listRef,
    count: visible.length,
    keyOf: (index) => visible[index]?.name ?? index,
  });
  const items = virtualizer.getVirtualItems();
  const cursorIndex = view.cursor === null ? -1 : names.indexOf(view.cursor);
  const cursorRendered = items.some((item) => item.index === cursorIndex);
  const rowDomId = (index: number) => `${baseId}-row-${index}`;

  /** 흐름(삭제)이 쓰는 것: 지울 곳 칸에는 모든 원격, 원격에만 있는 줄은 로컬 칸에서 뺀다 */
  const flowDeps: TagFlowDeps = {
    session: s,
    dialogs,
    remotes: remoteNames,
    busy: s.busy,
    reports: s.tagReports,
    isLocal: (name) => localNames.has(name),
  };

  // 결과 칸 (TG-12 ②): 마지막 작업의 요약·실패와 다시 시도 (문서가 내려가면 사라진다)
  const [result, setResult] = useState<{ view: TagResultView; retry: (() => void) | null } | null>(
    null,
  );
  /** 결과를 보이고 실패한 것을 선택으로 남긴다. 다시 시도할 것이 없으면 다시 시도를 끈다 */
  const showResult = (resultView: TagResultView, retry: () => void) => {
    setResult({ view: resultView, retry: resultView.retryNames.length > 0 ? retry : null });
    const [first] = resultView.failedNames;
    setView({
      selected: resultView.failedNames,
      cursor: first ?? view.cursor,
      anchor: first ?? null,
    });
  };

  /** 일괄 push (TG-12): 결과 칸에 보인다 */
  const runPush = async (target: string, list: string[]) => {
    const outcome = await s.runTagBatch({ kind: 'push', remote: target, names: list });
    const shown = batchResultView(S.tag.result.push(target), outcome, list);
    showResult(shown, () => void runPush(target, shown.retryNames));
  };
  /** 원격 것으로 맞추기 (C5, TG-15): 일반 확인 뒤 덮어쓰는 가져오기 (Undo 가능). 결과 칸에 보인다 */
  const alignToRemote = async (target: string, row: TagRow) => {
    const ok = await confirmAlignToRemote(dialogs, target, row.name, {
      remoteCommit: row.remoteCommit,
      localCommit: row.localCommit,
    });
    if (!ok) {
      return;
    }
    const list = [row.name];
    const outcome = await s.runTagBatch({
      kind: 'fetch',
      remote: target,
      names: list,
      overwrite: true,
    });
    showResult(batchResultView(S.tag.result.toRemote(target), outcome, list), () => {
      void alignToRemote(target, row);
    });
  };
  /** 로컬 것으로 맞추기 (C5, TG-15): 위험 확인 뒤 확인한 원격 객체로 lease 를 건 덮어쓰기. 결과 칸에 보인다 */
  const alignToLocal = async (target: string, row: TagRow) => {
    if (row.remoteObject === null) {
      return;
    }
    const item = {
      name: row.name,
      expectedRemote: row.remoteObject,
      remoteCommit: row.remoteCommit,
      localCommit: row.localCommit,
    };
    if (!(await confirmAlignToLocal(dialogs, target, [item]))) {
      return;
    }
    const outcome = await s.runTagBatch({
      kind: 'replace',
      remote: target,
      items: [{ name: item.name, expectedRemote: item.expectedRemote }],
    });
    showResult(batchResultView(S.tag.result.toLocal(target), outcome, [row.name]), () => {
      void alignToLocal(target, row);
    });
  };
  /** 일괄 가져오기 (TG-11·12): 결과 칸에 보인다 */
  const runFetch = async (target: string, list: string[]) => {
    const outcome = await s.runTagBatch({
      kind: 'fetch',
      remote: target,
      names: list,
      overwrite: false,
    });
    const shown = batchResultView(S.tag.result.fetch(target), outcome, list);
    showResult(shown, () => void runFetch(target, shown.retryNames));
  };
  /** 삭제 결과를 보인다. 다시 시도는 같은 지울 곳으로 대화상자 없이 (원격 것이 다르면 다시 묻는다) */
  const showDelete = (summary: TagDeleteSummary, scope: TagDeleteScope) => {
    const shown = deleteResultView(S.tag.result.del, summary);
    showResult(shown, () => {
      void s
        .deleteTagsScoped(shown.retryNames, scope, {
          onDiverged: (items, others) => confirmDiverged(dialogs, items, others),
          silent: true,
        })
        .then((again) => {
          if (again) {
            showDelete(again, scope);
          }
        });
    });
  };
  /** 일괄 삭제 (TG-12·14): 지울 곳 대화상자를 거쳐 결과 칸에 보인다 */
  const runDelete = async (list: string[]) => {
    const done = await deleteTagsFlow(list, flowDeps, { silent: true });
    if (done) {
      showDelete(done.summary, done.scope);
    }
  };

  // 여는 쪽의 요청 (C4): 모든 tag push(TG-13)는 원격을 확인한 뒤 "로컬에만" 을 모두 고르고 push 단추에 포커스한다
  const pushRef = useRef<HTMLButtonElement>(null);
  const [selectLocalOnlyFor, setSelectLocalOnlyFor] = useState<string | null>(null);
  const request = view.request;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 요청(seq)마다 한 번만 처리한다
  useEffect(() => {
    if (!request) {
      return;
    }
    const target = request.remote ?? defaultTagRemote(s.remotes, s.upstream);
    setView({
      request: null,
      remote: target,
      search: '',
      filter: request.kind === 'pushAll' ? 'localOnly' : 'remoteOnly',
    });
    if (request.kind === 'pushAll' && target !== null) {
      void s.checkRemoteTags([target]).then(() => setSelectLocalOnlyFor(target));
    }
  }, [request?.seq]);
  // 확인이 끝나 새 보고서로 줄이 바뀐 뒤 "로컬에만" 을 모두 고른다 (보내기는 사용자가 검토한 뒤 단추로)
  useEffect(() => {
    if (selectLocalOnlyFor === null || selectLocalOnlyFor !== remote || checking) {
      return;
    }
    const list = rows.filter((r) => r.state?.kind === 'localOnly').map((r) => r.name);
    setView({ selected: list, cursor: list[0] ?? null, anchor: list[0] ?? null });
    setSelectLocalOnlyFor(null);
    setTimeout(() => {
      const button = pushRef.current;
      (button && !button.disabled ? button : listRef.current)?.focus();
    }, 0);
  }, [selectLocalOnlyFor, remote, checking, rows, setView]);

  /**
   * 줄 메뉴: 로그에서 보기 · ── 이 원격으로 push · 삭제… · (다르면 ── 원격 것으로 맞추기… · 로컬 것으로 맞추기…) · ── 이
   * commit 으로 checkout · ── 이름 복사. 원격에만 있는 줄은 가져오기·삭제…·이름 복사. 문서 안 작업이라 결과는 결과 칸에
   * 보인다 (TG-12 ③)
   */
  const rowMenu = (row: TagRow): MenuItem[] => {
    const items: MenuItem[] = [];
    const del: MenuItem = {
      label: S.menu.delete,
      danger: true,
      disabled: s.busy,
      onSelect: () => void runDelete([row.name]),
    };
    if (row.local && row.localCommit !== null) {
      const commit = row.localCommit;
      items.push({ label: S.tag.doc.showInLog, onSelect: () => void s.jumpToCommit(commit) });
      if (remote !== null) {
        const target = remote;
        items.push({
          label: S.remote.pushTo(target),
          separator: true,
          disabled: s.busy,
          onSelect: () => void runPush(target, [row.name]),
        });
      }
      items.push(del);
      if (remote !== null && row.state?.kind === 'diverged') {
        // 다름 해소 (C5, TG-15): --force 단독 메뉴는 없다
        const target = remote;
        items.push(
          {
            label: S.tag.align.toRemote,
            separator: true,
            disabled: s.busy,
            onSelect: () => void alignToRemote(target, row),
          },
          {
            label: S.tag.align.toLocal,
            danger: true,
            disabled: s.busy || row.remoteObject === null,
            onSelect: () => void alignToLocal(target, row),
          },
        );
      }
      items.push({
        label: S.menu.checkoutDetached,
        separator: true,
        disabled: s.busy || s.inOp,
        onSelect: () => void s.checkout({ kind: 'commit', oid: commit }),
      });
    }
    if (!row.local && remote !== null) {
      // 원격에만 있는 줄: 이 원격에서 가져오기 (TG-11, 단건)
      const target = remote;
      items.push(
        {
          label: S.tag.doc.fetch,
          disabled: s.busy,
          onSelect: () => void runFetch(target, [row.name]),
        },
        del,
      );
    }
    items.push({ label: S.menu.copyName, separator: true, onSelect: () => copyText(row.name) });
    return items;
  };

  /** 커서 줄을 로그에서 보인다 (포커스는 목록에 남는다) */
  const showInLog = (row: TagRow | undefined) => {
    if (row?.local && row.localCommit !== null) {
      void s.jumpToCommit(row.localCommit);
    }
  };

  /** 목록의 키보드 (`tagListKey`) */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const command = tagListKey(
      { key: e.key, shiftKey: e.shiftKey, mod: isPrimaryModifier(e) },
      names,
      view,
    );
    if (!command) {
      return;
    }
    e.preventDefault();
    switch (command.kind) {
      case 'select': {
        setView(command.next);
        const at = command.next.cursor === null ? -1 : names.indexOf(command.next.cursor);
        if (at >= 0) {
          scrollToRow(at);
        }
        return;
      }
      case 'enter':
        showInLog(visible[cursorIndex]);
        return;
      case 'menu':
        openContextMenuAt(listRef.current?.querySelector(`[data-row-index="${cursorIndex}"]`));
        return;
    }
  };

  /** 줄 클릭 (`tagListClick`). 더블클릭은 로그에서 보기 */
  const onRowClick = (row: TagRow, e: MouseEvent) => {
    // 주 수정키는 키 이벤트 모양으로 판정한다 (macOS ⌘, 그 밖 Ctrl)
    const mod = isPrimaryModifier({
      key: '',
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    });
    setView(tagListClick(row.name, { shiftKey: e.shiftKey, mod }, names, view));
    if (e.detail === 2) {
      showInLog(row);
    }
  };

  /** 정렬 열 머리: 같은 열이면 방향을 뒤집고, 다른 열이면 그 열의 처음 방향(이름·날짜는 최신이 위, 상태는 바로) */
  const sortBy = (key: TagSortKey) =>
    setView({
      sort: view.sort.key === key ? { key, desc: !view.sort.desc } : { key, desc: key !== 'state' },
    });
  /** 열 머리 글자: 정렬 중인 열이면 방향 화살표를 붙인다 */
  const sortLabel = (key: TagSortKey, label: string) =>
    view.sort.key === key ? `${label} ${view.sort.desc ? '↓' : '↑'}` : label;

  const empty =
    rows.length === 0
      ? S.tag.doc.empty.noTags
      : visible.length === 0
        ? S.tag.doc.empty.noMatch
        : null;

  return (
    <div className={styles.doc}>
      <div className={styles.header}>
        <span className={styles.title}>{S.tag.doc.title}</span>
        <span className={styles.muted}>{counts.all}</span>
        {remote === null ? (
          <span className={styles.muted}>{S.tag.doc.noRemote}</span>
        ) : (
          <>
            <select
              className={styles.select}
              aria-label={S.tag.doc.remote}
              value={remote}
              onChange={(e) => setView({ remote: e.target.value })}
            >
              {remoteNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <span className={status.failed ? styles.failed : styles.muted} role="status">
              {status.text}
            </span>
          </>
        )}
        <span className={styles.spacer} />
        {view.selected.length > 0 ? (
          <span className={styles.muted}>{S.tag.doc.selected(view.selected.length)}</span>
        ) : null}
        {/* 원격 확인은 이 문서의 주 동작이라 필터 칩이 아닌 테두리 있는 단추로 보인다 */}
        <Button
          disabled={remote === null || checking}
          onClick={() => remote !== null && void s.checkRemoteTags([remote])}
        >
          {S.tag.doc.check}
        </Button>
      </div>
      <div className={styles.tools}>
        <input
          type="search"
          className={styles.search}
          placeholder={S.tag.doc.search}
          aria-label={S.tag.doc.search}
          value={view.search}
          onChange={(e) => setView({ search: e.target.value })}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: 키보드로 이동하는 필터 단추 묶음이다. */}
        <span
          {...filterTools}
          className={styles.filters}
          role="group"
          aria-label={S.tag.doc.filters}
        >
          {TAG_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              className={styles.filter}
              data-active={filter === key ? 'true' : 'false'}
              aria-pressed={filter === key}
              disabled={key !== 'all' && !checked}
              onClick={() => setView({ filter: key })}
            >
              {key === 'all' || checked
                ? S.tag.doc.filterCount(S.tag.doc.filter[key], counts[key])
                : S.tag.doc.filter[key]}
            </button>
          ))}
        </span>
      </div>
      {/* 일괄 단추 (TG-12 ①): 고른 것 가운데 해당하는 개수. 0 이면 꺼진다 */}
      <div {...batchTools} className={styles.tools} role="toolbar" aria-label={S.tag.batch.label}>
        {remote !== null ? (
          <button
            ref={pushRef}
            type="button"
            className={styles.action}
            disabled={s.busy || pushable.length === 0}
            onClick={() => void runPush(remote, pushable)}
          >
            {S.tag.batch.push(remote, pushable.length)}
          </button>
        ) : null}
        {remote !== null ? (
          <button
            type="button"
            className={styles.action}
            disabled={s.busy || fetchable.length === 0}
            onClick={() => void runFetch(remote, fetchable)}
          >
            {S.tag.batch.fetch(fetchable.length)}
          </button>
        ) : null}
        <button
          type="button"
          className={styles.action}
          data-danger="true"
          disabled={s.busy || deletable.length === 0}
          onClick={() => void runDelete(deletable)}
        >
          {S.tag.batch.del(deletable.length)}
        </button>
        {remote !== null && isSlowTagBatch(pushable.length) ? (
          // 일괄 push·모든 tag push 는 확인창이 없다 (검토가 확인이다) — 보내기 단추 옆에 시간 안내를 둔다
          <span className={styles.slow}>{S.tag.batch.slow}</span>
        ) : null}
      </div>
      {result ? (
        <div className={styles.result}>
          <div className={styles.resultHead}>
            <span role="status">{result.view.summary}</span>
            {result.view.error ? <span className={styles.failed}>{result.view.error}</span> : null}
            <span className={styles.spacer} />
            <button
              type="button"
              className={styles.action}
              disabled={s.busy || result.retry === null}
              onClick={() => result.retry?.()}
            >
              {S.tag.result.retry}
            </button>
            <button type="button" className={styles.action} onClick={() => setResult(null)}>
              {S.tag.result.close}
            </button>
          </div>
          {result.view.failures.length > 0 ? (
            <ul className={styles.failures} aria-label={S.tag.result.list}>
              {result.view.failures.map((f) => (
                // 같은 tag 가 원격마다 다른 사유로 남을 수 있어 이름과 사유로 키를 만든다
                <li key={`${f.name}\u0000${f.text}`}>
                  <span className={styles.failureName}>{f.name}</span> {f.text}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {/* 열 머리: 이름·상태 열은 정렬 단추 (누르면 그 열로, 다시 누르면 방향을 뒤집는다) */}
      <div className={styles.columns}>
        <span />
        <button
          type="button"
          className={styles.th}
          aria-pressed={view.sort.key === 'name'}
          onClick={() => sortBy('name')}
        >
          {sortLabel('name', S.tag.doc.columns.name)}
        </button>
        <span>{S.tag.doc.columns.kind}</span>
        <span>{S.tag.doc.columns.localCommit}</span>
        <span>{S.tag.doc.columns.remoteCommit}</span>
        <button
          type="button"
          className={styles.th}
          aria-pressed={view.sort.key === 'state'}
          onClick={() => sortBy('state')}
        >
          {sortLabel('state', S.tag.doc.columns.state)}
        </button>
        <button
          type="button"
          className={styles.th}
          aria-pressed={view.sort.key === 'date'}
          onClick={() => sortBy('date')}
        >
          {sortLabel('date', S.tag.doc.columns.date)}
        </button>
      </div>
      {empty !== null ? (
        <div className={styles.empty}>{empty}</div>
      ) : (
        <ContextMenuArea<TagRow>
          className={styles.menuArea}
          resolveTarget={(e) => {
            const el = (e.target as HTMLElement | null)?.closest('[data-row-index]');
            return el ? (visible[Number(el.getAttribute('data-row-index'))] ?? null) : null;
          }}
          items={rowMenu}
        >
          <div
            ref={listRef}
            data-primary-focus
            className={styles.list}
            role="listbox"
            aria-label={S.tag.doc.list}
            aria-multiselectable="true"
            aria-activedescendant={cursorRendered ? rowDomId(cursorIndex) : undefined}
            tabIndex={0}
            onKeyDown={onKeyDown}
          >
            <div
              className={styles.inner}
              role="presentation"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {items.map((item) => {
                const row = visible[item.index];
                if (!row) {
                  return null;
                }
                const isSelected = selected.has(row.name);
                return (
                  // 포커스는 목록이 받으므로 줄은 포커스 대상이 아니다 (aria-activedescendant)
                  // biome-ignore lint/a11y/useFocusableInteractive: 목록이 포커스를 받고 줄은 activedescendant 로 알린다
                  // biome-ignore lint/a11y/useKeyWithClickEvents: 키보드 조작은 목록의 onKeyDown 이 맡는다
                  <div
                    key={item.key}
                    id={rowDomId(item.index)}
                    className={styles.row}
                    role="option"
                    aria-selected={isSelected}
                    aria-setsize={visible.length}
                    aria-posinset={item.index + 1}
                    data-row-index={item.index}
                    data-cursor={item.index === cursorIndex ? 'true' : undefined}
                    data-local={row.local ? 'true' : 'false'}
                    title={tagRowTitle(row)}
                    style={
                      {
                        height: rowHeight,
                        transform: `translateY(${item.start}px)`,
                      } as CSSProperties
                    }
                    onClick={(e) => onRowClick(row, e)}
                    onContextMenu={() =>
                      setView({
                        cursor: row.name,
                        anchor: row.name,
                        // 고른 줄 밖을 우클릭하면 그 줄만 고른다
                        selected: isSelected ? view.selected : [row.name],
                      })
                    }
                  >
                    <span className={styles.check}>
                      {isSelected ? <Icon name="checkMark" /> : null}
                    </span>
                    <span className={styles.name}>{row.name}</span>
                    <span className={styles.muted}>
                      {row.annotated === null
                        ? ''
                        : row.annotated
                          ? S.tag.doc.kind.annotated
                          : S.tag.doc.kind.lightweight}
                    </span>
                    <span className={styles.mono}>
                      {row.localCommit ? shortHash(row.localCommit) : ''}
                    </span>
                    <span className={styles.mono}>
                      {row.remoteCommit ? shortHash(row.remoteCommit) : ''}
                    </span>
                    <span className={styles.state} data-state={row.state?.kind}>
                      {row.state === null ? S.tag.doc.stateNotChecked : tagStateText(row.state)}
                    </span>
                    <span className={styles.muted}>
                      {row.date === null ? '' : formatDateTime(row.date)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </ContextMenuArea>
      )}
      {dialogs.element}
    </div>
  );
}
