import { type AuthorList, type GraphQuery, hashPrefixOf, isListModeQuery } from '@mgit/ipc';
import { Icon, type IconName, isImeKey, S, useElementWidth } from '@mgit/ui';
import { type ReactNode, useId, useRef, useState } from 'react';
import { type DropdownItem, DropdownMenu } from '../../components/DropdownMenu';
import styles from './FilterBar.module.css';
import { ChecklistDropdown, type CheckOption, DateDropdown, PathDropdown } from './FilterDropdown';
import {
  buttonSummary,
  clearedQuery,
  type DateRange,
  describeRange,
  filterBarMode,
  filterOf,
  HEAD_OPTION_ID,
  hasConditions,
  revsOfSelection,
  revsSelection,
  revsValues,
  sameQuery,
  type TextDraft,
  textPending,
  toggledQuery,
  withAuthors,
  withDates,
  withPaths,
  withRevs,
  withText,
} from './filter-model';

/**
 * 필터 바의 능력 플래그: 탭 종류마다 낼 수 있는 것이 다르다 (폴더 = 저장소 범위 있음, 저장소 탭 = 없음). 보기
 * 옵션은 플래그가 아니라 슬롯(`viewOptions`)으로 받는다 — 무엇을 지키는지는 데이터 쪽이 안다
 */
export interface FilterBarCapabilities {
  /** 저장소 범위 드롭다운을 낸다 (폴더) */
  repoScope: boolean;
  /**
   * 경로 범위 드롭다운을 낸다 (저장소 탭, W26 — 질의의 `pathScope`). 폴더 로그는 경로 범위를 지키지 않아 내지 않는다
   * (없으면 끔)
   */
  pathScope?: boolean;
}

/** 상태 글자 곁의 도구 단추 (저장소 탭의 찾기 줄 여닫기, W26). 켜고 끄는 단추면 `pressed` 를 준다 */
export interface FilterBarTool {
  key: string;
  icon: IconName;
  /** 접근성 이름 */
  label: string;
  title?: string;
  pressed?: boolean;
  onClick: () => void;
}

/** 저장소 범위 드롭다운의 항목 */
export interface RepoOption {
  path: string;
  name: string;
  /** 저장소 색 번호 (`--graph-lane-N`). 모르면 null */
  color: number | null;
  /** 요약·로그를 읽지 못한 사유. 읽지 못한 저장소도 목록에 있다 */
  error?: string | null;
}

/** branch 드롭다운의 항목 (브랜치 트리와 같은 목록) */
export interface BranchOption {
  name: string;
  remote: boolean;
  /** 현재 branch 인지 (폴더: 일부 저장소에서만 현재면 'partial') */
  current: boolean | 'partial';
  /** 툴팁 (어느 저장소에 있는지 등) */
  title?: string;
}

/** 작성자 후보 (드롭다운을 열 때 읽는다) */
export interface AuthorSource {
  state: 'idle' | 'loading' | 'ready' | 'error';
  /** 마지막으로 받은 후보. 다시 읽는 동안에도 남아 단추의 이름 표시에 쓴다 */
  list: AuthorList | null;
  error: string | null;
  /** 후보를 읽게 한다. `force` 가 아니면 이미 읽은 후보를 그대로 쓴다 (다시 시도는 `force`) */
  load: (force: boolean) => void;
}

export interface FilterBarProps {
  /** 지금 적용된 질의 */
  query: GraphQuery;
  /** 새 질의를 적용한다 (바뀐 것이 있을 때만 부른다) */
  onQueryChange: (next: GraphQuery) => void;
  capabilities: FilterBarCapabilities;
  /** 저장소 범위 (능력 플래그 `repoScope` 일 때). `scope` 가 비면 전부다 */
  repos?: {
    options: readonly RepoOption[];
    scope: readonly string[];
    onScopeChange: (paths: string[]) => void;
  };
  branches: {
    options: readonly BranchOption[];
    /** HEAD(현재 branch) 항목을 낼지 (HEAD 에 커밋이 있는 저장소가 있을 때) */
    headAvailable: boolean;
    /** HEAD 항목·단추의 툴팁 (저장소마다의 HEAD 등) */
    headTitle?: string;
    /** 걸려 있는데 목록에 없는 이름의 묶음 이름 (없으면 "branch") */
    missingSection?: string;
    /**
     * 목록 아래의 "직접 입력" 단추 (저장소 탭, W26): 누르면 팝오버를 닫고(초안은 적용하지 않는다) 그때의 초안을 넘긴다.
     * 임의의 ref 이름(태그·목록에 없는 이름)을 적는 길이다
     */
    custom?: { label: string; onEdit: (draft: string[]) => void };
    /** 드롭다운을 열 때 (목록을 새로 읽게 한다) */
    onOpen?: () => void;
  };
  /**
   * 경로 범위 단추에 보일 이름과 툴팁 (능력 플래그 `pathScope`). 모듈 범위로 건 경로면 모듈 이름 등. 없으면 경로 그대로
   */
  describePath?: (path: string) => { label: string; title: string };
  authors: AuthorSource;
  /** 텍스트 필터를 적용하지 못한 사유 (잘못된 정규식). 있으면 입력란 옆에 보이고 이전 결과가 그대로다 */
  textError: string | null;
  /** 입력을 고치거나 지웠다 (오류 표시를 지운다) */
  onTextEdit: () => void;
  /** 텍스트 칸의 Esc 에서 입력 중인 값이 적용된 값과 같을 때 (포커스를 로그로 돌린다) */
  onEscape?: () => void;
  /** 오른쪽의 상태 글자 (행 수·잘림·읽는 중) */
  status?: ReactNode;
  /** 상태 글자의 툴팁 (잘린 저장소 등) */
  statusTitle?: string;
  /**
   * 보기 옵션 슬롯: 오른쪽 보기 옵션 단추가 여는 메뉴의 항목. 그 탭이 실제로 지키는 옵션만 담는다 (비면 단추가 없다)
   */
  viewOptions?: readonly DropdownItem[];
  /**
   * 기본값이 아닌 보기 옵션의 이름 (저장소 탭, W26 — 행 수를 줄이는 옵션을 알린다). 있으면 보기 옵션 단추에 점이 찍히고
   * 이름·툴팁에 실린다
   */
  viewOptionsChanged?: readonly string[];
  /** 상태 글자와 보기 옵션 사이의 도구 단추 (저장소 탭의 찾기 줄 여닫기) */
  tools?: readonly FilterBarTool[];
  onRefresh?: () => void;
  refreshing?: boolean;
  /**
   * 잠금 (저장소 탭의 쓰기 진행 중, W26): 질의를 바꾸는 조작(텍스트 Enter·토글·드롭다운·×·모두 지우기)을 `aria-disabled`
   * 로 끈다 — 포커스는 남는다. 텍스트 칸에는 계속 적을 수 있다. 보기 옵션 항목의 꺼짐은 슬롯을 주는 쪽이 정한다
   */
  locked?: boolean;
  /** 지금 시각 (빠른 날짜 선택의 기준. 테스트가 바꾼다) */
  now?: () => Date;
}

/** 지금 시각 */
const realNow = () => new Date();

/** 텍스트 필터의 비교 키 (적용된 값이 바뀌었는지 보는 데 쓴다) */
function textKey(text: TextDraft): string {
  return JSON.stringify([text.pattern, text.regex, text.matchCase]);
}

/**
 * 로그 필터 바 (LG-06, W17). props 전용 — 폴더·저장소 스토어를 모른다. 텍스트·해시 입력(Enter 로 적용, 정규식·대소문자
 * 토글), 저장소(능력 플래그)·branch·작성자·날짜 드롭다운, 모두 지우기, 상태·보기 옵션·새로고침. 질의를 받고 바뀐
 * 질의를 돌려준다. 폭이 좁으면 두 줄(윗줄 = 입력·상태, 아랫줄 = 드롭다운)로 나눈다
 */
export function FilterBar({
  query,
  onQueryChange,
  capabilities,
  repos,
  branches,
  authors,
  textError,
  onTextEdit,
  onEscape,
  status,
  statusTitle,
  viewOptions,
  viewOptionsChanged,
  tools,
  onRefresh,
  refreshing,
  describePath,
  locked = false,
  now = realNow,
}: FilterBarProps) {
  const f = filterOf(query);
  const applied = f.text;
  const [draft, setDraft] = useState<TextDraft>(() => ({ ...applied }));
  // 적용된 텍스트가 밖에서 바뀌면(모두 지우기, 다른 질의) 입력을 맞춘다. 적용하지 못해 되돌아간 경우(오류)는 입력을
  // 그대로 둔다 — 사용자가 고칠 수 있게
  const [syncedKey, setSyncedKey] = useState(() => textKey(applied));
  const appliedKey = textKey(applied);
  if (appliedKey !== syncedKey) {
    setSyncedKey(appliedKey);
    if (textError === null) {
      setDraft({ ...applied });
    }
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const [measure, width] = useElementWidth();

  /** 질의가 실제로 바뀔 때만 적용한다 */
  const change = (next: GraphQuery) => {
    if (!sameQuery(next, query)) {
      onQueryChange(next);
    }
  };
  /** 입력을 고쳤다: 오류가 떠 있으면 지운다 */
  const edited = () => {
    if (textError !== null) {
      onTextEdit();
    }
  };
  /** 입력 중인 검색어를 적용한다 (Enter). 잠겨 있으면 적용하지 않는다 — "적용 전" 표시가 남는다 */
  const applyText = () => {
    if (!locked) {
      change(withText(query, draft));
    }
  };
  /** 토글을 바꾼다. 적용된 검색어가 있으면 바로 다시 적용한다 */
  const toggle = (key: 'regex' | 'matchCase') => {
    if (locked) {
      return;
    }
    const next = { ...draft, [key]: !draft[key] };
    setDraft(next);
    edited();
    const q = toggledQuery(query, next);
    if (q) {
      change(q);
    }
  };
  /** 검색어를 지운다. 적용된 검색어가 있으면 조건도 푼다 */
  const clearText = () => {
    if (locked) {
      return;
    }
    setDraft({ ...draft, pattern: '' });
    edited();
    change(withText(query, { ...draft, pattern: '' }));
    inputRef.current?.focus();
  };
  /** 모두 지우기: 텍스트·branch·작성자·날짜(저장소 탭은 경로도)와 저장소 범위 */
  const clearAll = () => {
    if (locked) {
      return;
    }
    setDraft({ ...draft, pattern: '' });
    edited();
    change(clearedQuery(query));
    if (repos && repos.scope.length > 0) {
      repos.onScopeChange([]);
    }
  };

  const pending = textPending(draft, applied);
  const hash = hashPrefixOf(draft.pattern);
  const scoped = (repos?.scope.length ?? 0) > 0;
  const anyCondition = hasConditions(query) || scoped;

  // 저장소 (능력 플래그)
  const repoOptions: CheckOption[] = (repos?.options ?? []).map((r) => ({
    id: r.path,
    label: r.name,
    color: r.color,
    title: r.error ? `${r.path}\n${S.filterBar.repoFailed(r.error)}` : r.path,
    ...(r.error ? { aside: '⚠' } : {}),
  }));
  const repoName = (path: string) => repos?.options.find((r) => r.path === path)?.name ?? path;

  // branch: 브랜치 트리와 같은 상태(질의의 ref 범위)
  const branchOptions: CheckOption[] = [
    ...(branches.headAvailable
      ? [{ id: HEAD_OPTION_ID, label: S.branches.head, title: branches.headTitle }]
      : []),
    ...branches.options.map((b) => ({
      id: b.name,
      label: b.name,
      section: b.remote ? S.filterBar.remote : S.filterBar.local,
      ...(b.current !== false ? { aside: S.filterBar.current } : {}),
      ...(b.title ? { title: b.title } : {}),
    })),
  ];
  const branchSummary = buttonSummary(S.filterBar.branch, revsValues(query.revs));
  if (query.revs.kind === 'head' && branches.headTitle) {
    branchSummary.title = `${branchSummary.label}\n${branches.headTitle}`;
  }

  // 작성자: 후보는 드롭다운을 열 때 읽는다. 질의의 값은 이메일이고 단추에는 아는 이름을 보인다
  const candidates = authors.list?.authors ?? [];
  const authorName = (email: string) =>
    candidates.find((a) => a.email.toLowerCase() === email.toLowerCase())?.name ?? email;
  const authorsReady = authors.state === 'ready';
  const authorOptions: CheckOption[] = authorsReady
    ? candidates.map((a) => ({
        id: a.email,
        label: a.name,
        detail: a.email,
        aside: String(a.commits),
        title: `${a.name} <${a.email}> · ${S.filterBar.commits(a.commits)}`,
      }))
    : [];
  const authorStatus = authorStatusOf(authors);

  const first = capabilities.repoScope && repos ? 'repo' : 'branch';
  const repoSummary = buttonSummary(S.filterBar.repo, (repos?.scope ?? []).map(repoName));
  const authorSummary = buttonSummary(S.filterBar.author, f.authors.map(authorName));
  const dateSummary = buttonSummary(S.filterBar.date, dateValues(f, now));
  // 경로 범위 (능력 플래그): 단추에는 보일 이름(모듈 이름 등), 툴팁에는 경로
  const pathShown = capabilities.pathScope ? query.pathScope.map(pathDescriber(describePath)) : [];
  const pathSummary = buttonSummary(
    S.filterBar.path,
    pathShown.map((p) => p.label),
  );
  if (pathSummary.active) {
    pathSummary.title = S.filterBar.summary(
      S.filterBar.path,
      pathShown.map((p) => p.title).join(', '),
    );
  }
  // 폭에 맞는 모양 (W19): 걸린 조건(×)·모두 지우기·목록 모드 표시·도구 단추만큼 좁은 한 줄에 더 필요하다
  const listMode = isListModeQuery(query);
  const active = [
    capabilities.repoScope && repos ? repoSummary : null,
    branchSummary,
    authorSummary,
    dateSummary,
    capabilities.pathScope ? pathSummary : null,
  ].filter((s) => s?.active).length;
  const mode = filterBarMode(width, {
    active,
    clearAll: anyCondition,
    listMode,
    tools: tools?.length ?? 0,
  });
  // 좁은 한 줄에서는 상태 글자가 줄어드므로 툴팁에 전부 싣는다
  const statusTip =
    mode === 'compact'
      ? [typeof status === 'string' ? status : null, statusTitle ?? null]
          .filter((s) => s !== null)
          .join('\n')
      : statusTitle;
  const stacked = mode === 'stacked';
  // 기본값이 아닌 보기 옵션이 있으면 단추에 점을 찍고 이름에 싣는다 (점은 소리로 읽히지 않으므로)
  const viewOptionsMarked = (viewOptionsChanged?.length ?? 0) > 0;
  const viewOptionsName = viewOptionsMarked
    ? S.filterBar.viewOptionsChanged((viewOptionsChanged ?? []).join(' · '))
    : S.filterBar.viewOptions;

  // 오른쪽 상태·보기 옵션·새로고침. 두 줄(stacked)에서는 윗줄 오른쪽에 놓이므로 DOM 에서도 드롭다운보다 앞에 둔다 —
  // Tab 순서가 화면 순서(입력 → 상태·단추 → 아랫줄 드롭다운)와 맞게 (W19 ③). 드롭다운 쪽은 자리를 옮기지 않아 열린
  // 팝오버가 모양이 바뀌어도 닫히지 않는다
  const tail = (
    <div className={styles.tail}>
      {listMode ? (
        <span className={styles.listMode} title={S.filterBar.listModeTitle}>
          <Icon name="listMode" />
          <span className={styles.listModeText}>{S.filterBar.listMode}</span>
        </span>
      ) : null}
      {status ? (
        // 결과 수·읽는 중이 바뀌면 보조 기술에 알린다 (필터를 바꾼 뒤의 결과). 로그 위의 안내(role=status)와 겹치지 않게
        // 역할 없이 알림 영역으로만 둔다
        <span
          className={styles.status}
          title={statusTip || undefined}
          aria-live="polite"
          aria-atomic="true"
        >
          {status}
        </span>
      ) : null}
      {(tools ?? []).map((tool) => (
        <button
          key={tool.key}
          type="button"
          className={styles.iconButton}
          aria-label={tool.label}
          aria-pressed={tool.pressed}
          title={tool.title ?? tool.label}
          onClick={tool.onClick}
        >
          <Icon name={tool.icon} />
        </button>
      ))}
      {viewOptions && viewOptions.length > 0 ? (
        <DropdownMenu
          trigger={
            <button
              type="button"
              className={styles.iconButton}
              aria-label={viewOptionsName}
              title={viewOptionsName}
              data-changed={viewOptionsMarked ? 'true' : undefined}
            >
              <Icon name="viewOptions" />
            </button>
          }
          items={[...viewOptions]}
        />
      ) : null}
      {onRefresh ? (
        <button
          type="button"
          className={styles.iconButton}
          aria-label={S.filterBar.refresh}
          title={S.filterBar.refresh}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <Icon name="refresh" />
        </button>
      ) : null}
    </div>
  );

  return (
    <search
      ref={measure}
      className={styles.bar}
      data-mode={mode}
      data-rows={mode === 'stacked' ? 2 : 1}
      data-filter-bar=""
      aria-label={S.filterBar.label}
    >
      <div className={styles.text}>
        <div
          className={styles.textBox}
          data-error={textError !== null ? 'true' : 'false'}
          data-pending={pending ? 'true' : 'false'}
        >
          <Icon name="search" />
          <input
            ref={inputRef}
            className={styles.input}
            data-filter-text=""
            aria-label={S.filterBar.textLabel}
            aria-invalid={textError !== null}
            aria-describedby={textError !== null ? errorId : undefined}
            placeholder={S.filterBar.textPlaceholder}
            value={draft.pattern}
            spellCheck={false}
            onChange={(e) => {
              setDraft({ ...draft, pattern: e.target.value });
              edited();
            }}
            onKeyDown={(e) => {
              // 한글 조합 중의 Enter·Esc 는 입력기 몫이다 (조합을 끝내는 Enter 로 적용하지 않는다)
              if (isImeKey(e)) {
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                applyText();
              } else if (e.key === 'Escape') {
                // 이 칸의 Esc 는 여기서 끝낸다 (미리보기 탭 닫기 등 전역 Esc 로 가지 않는다)
                e.preventDefault();
                e.stopPropagation();
                if (pending || textError !== null) {
                  setDraft({ ...applied });
                  edited();
                } else {
                  onEscape?.();
                }
              }
            }}
          />
          {hash !== null ? (
            <span className={styles.hash} title={S.filterBar.hashTitle(hash)}>
              #
            </span>
          ) : null}
          {pending ? (
            <span
              className={styles.pending}
              title={S.filterBar.pendingTitle(applied.pattern)}
              data-testid="filter-pending"
            >
              {S.filterBar.pending}
            </span>
          ) : null}
          {draft.pattern !== '' || applied.pattern !== '' ? (
            <button
              type="button"
              className={styles.iconButton}
              aria-label={S.filterBar.clearText}
              aria-disabled={locked || undefined}
              title={withLockNote(S.filterBar.clearText, locked)}
              onClick={clearText}
            >
              <Icon name="close" />
            </button>
          ) : null}
          <button
            type="button"
            className={styles.toggle}
            aria-label={S.filterBar.regex}
            aria-pressed={draft.regex}
            aria-disabled={locked || undefined}
            title={withLockNote(S.filterBar.regexTitle, locked)}
            onClick={() => toggle('regex')}
          >
            <Icon name="regex" />
          </button>
          <button
            type="button"
            className={styles.toggle}
            aria-label={S.filterBar.matchCase}
            aria-pressed={draft.matchCase}
            aria-disabled={locked || undefined}
            title={withLockNote(S.filterBar.matchCase, locked)}
            onClick={() => toggle('matchCase')}
          >
            <Icon name="caseSensitive" />
          </button>
        </div>
        {textError !== null ? (
          <div id={errorId} className={styles.textError} role="alert">
            <Icon name="error" />
            <span>{textError}</span>
          </div>
        ) : null}
      </div>
      {stacked ? tail : null}
      <div className={styles.drops}>
        {capabilities.repoScope && repos ? (
          <ChecklistDropdown
            name={S.filterBar.repo}
            icon="repo"
            summary={repoSummary}
            options={repoOptions}
            selected={repos.scope}
            onApply={repos.onScopeChange}
            missingSection={S.filterBar.repo}
            note={S.filterBar.repoNone}
            first={first === 'repo'}
            locked={locked}
          />
        ) : null}
        <ChecklistDropdown
          name={S.filterBar.branch}
          icon="branch"
          summary={branchSummary}
          options={branchOptions}
          selected={revsSelection(query.revs)}
          onApply={(ids) => change(withRevs(query, revsOfSelection(ids)))}
          exclusive={[HEAD_OPTION_ID]}
          missingSection={branches.missingSection ?? S.filterBar.branch}
          first={first === 'branch'}
          locked={locked}
          onOpen={branches.onOpen}
          action={
            branches.custom
              ? { label: branches.custom.label, onSelect: branches.custom.onEdit }
              : undefined
          }
        />
        <ChecklistDropdown
          name={S.filterBar.author}
          icon="author"
          summary={authorSummary}
          options={authorOptions}
          selected={f.authors}
          onApply={(emails) => change(withAuthors(query, emails))}
          missingSection={S.filterBar.authorMissing}
          status={authorStatus}
          onOpen={() => authors.load(false)}
          locked={locked}
        />
        <DateDropdown
          summary={dateSummary}
          range={f}
          onApply={(range) => change(withDates(query, range))}
          now={now}
          locked={locked}
        />
        {capabilities.pathScope ? (
          <PathDropdown
            summary={pathSummary}
            paths={query.pathScope}
            onApply={(paths) => change(withPaths(query, paths))}
            placeholder={S.graph.filter.pathPlaceholder}
            locked={locked}
          />
        ) : null}
        {anyCondition ? (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={S.filterBar.clearAll}
            aria-disabled={locked || undefined}
            title={withLockNote(S.filterBar.clearAll, locked)}
            onClick={clearAll}
          >
            <Icon name="clearAll" />
          </button>
        ) : null}
      </div>
      {stacked ? null : tail}
    </search>
  );
}

/** 작성자 드롭다운 목록 위의 상태 줄: 읽는 중 / 실패(다시 시도) / 시간 초과(다시 시도) / 잘림. 없으면 undefined */
function authorStatusOf(source: AuthorSource): ReactNode {
  if (source.state === 'idle' || source.state === 'loading') {
    return <div className={styles.listStatus}>{S.filterBar.authorsLoading}</div>;
  }
  if (source.state === 'error') {
    return (
      <div className={styles.listStatus} data-tone="error" role="alert">
        <span>{S.filterBar.authorsFailed(source.error ?? '')}</span>
        <RetryButton onClick={() => source.load(true)} />
      </div>
    );
  }
  const list = source.list;
  const notes: ReactNode[] = [];
  if (list?.timedOut) {
    notes.push(
      <div key="timeout" className={styles.listStatus} data-tone="warn">
        <span>{S.filterBar.authorsTimedOut}</span>
        <RetryButton onClick={() => source.load(true)} />
      </div>,
    );
  }
  if (list?.truncated) {
    notes.push(
      <div key="trunc" className={styles.listStatus}>
        {S.filterBar.authorsTruncated(list.authors.length, list.total)}
      </div>,
    );
  }
  return notes.length > 0 ? notes : undefined;
}

/** 잠겨 있으면 툴팁 둘째 줄에 까닭을 붙인다 */
function withLockNote(title: string, locked: boolean): string {
  return locked ? `${title}\n${S.filterBar.locked}` : title;
}

/** 경로 → 단추에 보일 이름과 툴팁. 주어진 것이 없으면 경로 그대로 */
function pathDescriber(
  describe: ((path: string) => { label: string; title: string }) | undefined,
): (path: string) => { label: string; title: string } {
  return describe ?? ((path) => ({ label: path, title: path }));
}

/** 날짜 단추에 보일 값 (조건이 없으면 빈 목록) */
function dateValues(range: DateRange, now: () => Date): string[] {
  const label = describeRange(range, now());
  return label === null ? [] : [label];
}

/** 목록 상태 줄의 "다시 시도" */
function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className={styles.linkButton} onClick={onClick}>
      {S.filterBar.retry}
    </button>
  );
}
