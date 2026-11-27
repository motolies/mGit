// 비교 화면 기준(A)·대상(B) 칸의 ref 선택 칸 (F4, 명세 `plan/perf-responsiveness-ref-picker-명세.md`). 브라우저 기본
// `<datalist>` 를 대신한다: 닫힌 칸은 종류 아이콘 + 짧은 이름(가운데 말줄임, 전체 이름은 툴팁), 누르면 공용 `Popover` 안에
// 검색칸(combobox)과 목록(listbox)이 열린다. 목록에서 고르면 바로 확정하고, 목록에 없는 커밋·식은 "입력한 값 사용" 줄을
// 골라 `verify` 로 확인한 뒤 확정한다.
//
// 사용 예 (ComparisonDoc — 끼워 넣기는 화면 레인이 한다):
//
//   <RefPicker
//     label={S.history.compareB}
//     value={request.b}                    // 전체 이름·'HEAD'·OID·식·짧은 이름·LOCAL 모두 받는다
//     refs={repo.refs}                     // RepoRefs (head·labels 만 읽는다, stash 는 목록에서 뺀다)
//     local={{ value: LOCAL, label: S.comparison.localContent, detail: S.comparison.includesDraft }}  // B 칸만
//     disabled={session === null}          // 세션 확보 중: 값은 보이고 열리지 않는다
//     invalid={failed?.side === 'b' ? failed.message : null}  // 적용한 값의 해석 실패 (테두리·아이콘·설명)
//     verify={(text) => client.resolveRevision(session, text).then(() => {})}  // 직접 입력 확인 (실패면 reject)
//     onCommit={pickB}                     // 고른 값 (ref 는 전체 이름). 지금 값과 같으면 부르지 않는다
//   />
import { Icon, type IconName, isImeKey, Popover, type PopoverCloseReason, S } from '@mgit/ui';
import {
  Fragment,
  type KeyboardEvent,
  memo,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import styles from './RefPicker.module.css';
import {
  describeRef,
  filterRefSections,
  type RefDescription,
  type RefOption,
  type RefPickerLocal,
  type RefPickerRefs,
  type RefPickKind,
  refSections,
  splitRefName,
} from './ref-picker-model';

export interface RefPickerProps {
  /** 칸 이름 (`S.history.compareA`·`compareB`). 팝오버·검색칸·목록의 접근성 이름에도 쓴다 */
  label: string;
  /** 지금 값: 전체 이름·`HEAD`·OID·식·짧은 이름, 또는 `local.value` */
  value: string;
  /** ref 재료 (`RepoRefs` 를 그대로 넘기면 된다) */
  refs: RefPickerRefs;
  /** "현재 로컬 내용" 같은 특수 값을 목록 맨 위에 둔다 (대상 칸만) */
  local?: RefPickerLocal;
  /** 열리지 않게 한다 (포커스는 받는다). 세션을 확보하는 중일 때 */
  disabled?: boolean;
  /** 적용한 값을 해석하지 못한 까닭. 있으면 칸 테두리·아이콘으로 알리고 설명으로 잇는다 */
  invalid?: string | null;
  /** 직접 입력한 값을 확인한다 (`resolveRevision`). 실패하면 reject 한다 */
  verify: (text: string) => Promise<void>;
  /** 값을 확정한다. 목록 항목은 고르는 즉시, 직접 입력은 확인에 성공한 뒤 부른다. 지금 값과 같으면 부르지 않는다 */
  onCommit: (value: string) => void;
}

/** 종류별 아이콘 (모양이 종류를 전하고 색은 보조다) */
const KIND_ICON: Record<RefPickKind, IconName> = {
  local: 'branch',
  remote: 'remote',
  tag: 'tag',
  head: 'head',
  commit: 'commit',
  expression: 'commit',
  workingTree: 'project',
};

/** "입력한 값 사용" 줄의 활성 키 (ref 값과 겹치지 않는다) */
const TYPED_KEY = '\u0000typed';

/** 목록의 한 줄: ref 항목 또는 "입력한 값 사용" 줄 */
type Row =
  | { key: string; kind: 'option'; option: RefOption; section: string }
  | { key: typeof TYPED_KEY; kind: 'typed'; text: string };

/** 접근성 이름의 종류 글자. HEAD·현재 로컬 내용은 이름이 곧 종류라 비우고, 현재 브랜치는 로컬 브랜치다 */
function kindWord(description: RefDescription): string {
  const kinds = S.comparison.refPicker.kind;
  if (description.kind === 'workingTree') return '';
  if (description.kind === 'head') return description.current ? kinds.local : '';
  return kinds[description.kind];
}

/** 목록용 이름 조각: `/` 마다 나눈다. 키는 이름 안의 글자 위치, `slash` 는 뒤에 `/` 가 붙는지 */
function nameSegments(name: string): { at: number; text: string; slash: boolean }[] {
  const out: { at: number; text: string; slash: boolean }[] = [];
  let at = 0;
  for (const text of name.split('/')) {
    out.push({ at, text, slash: at + text.length < name.length });
    at += text.length + 1;
  }
  return out;
}

/**
 * 이름. 닫힌 칸(`full` 아님)은 마지막 `/` 앞부분이 먼저 줄어드는 가운데 말줄임이고, 열린 목록(`full`)은 이름 전체를 보이며
 * 한 줄에 안 들어가면 `/` 뒤에서 줄을 바꾼다 (`<wbr>`). 해시·식은 고정폭
 */
function RefName({ name, mono, full = false }: { name: string; mono: boolean; full?: boolean }) {
  if (full) {
    return (
      <span className={styles.fullName} data-mono={mono ? 'true' : undefined}>
        {nameSegments(name).map((segment) => (
          <Fragment key={segment.at}>
            {segment.text}
            {segment.slash ? (
              <>
                /<wbr />
              </>
            ) : null}
          </Fragment>
        ))}
      </span>
    );
  }
  const { head, tail } = splitRefName(name);
  return (
    <span className={styles.name} data-mono={mono ? 'true' : undefined}>
      <span className={styles.nameHead}>{head}</span>
      {tail ? <span className={styles.nameTail}>{tail}</span> : null}
    </span>
  );
}

/**
 * ref 선택 칸. 닫힘: 클릭·Enter·Space·↑↓ 로 열고, 글자를 치면 그 글자로 검색하며 연다(한글 조합 키는 빈 검색어로 연다).
 * 열림: ↑↓ 는 양끝에서 멈추고, Home·End 는 검색어가 비었을 때만 목록 끝으로 간다. Enter·클릭으로 고르면 닫고 칸으로
 * 포커스를 돌린다. Esc 는 값을 그대로 두고 닫으며 칸으로 돌아가고, Tab·바깥 클릭은 고르지 않고 닫는다(Popover 규칙).
 * 활성 항목은 값으로 기억해 목록이 바뀌어도 같은 항목에 머문다
 */
// 받은 값이 같으면 다시 그리지 않는다 — 비교 화면이 파일을 옮길 때마다 머리의 두 칸을 다시 그리지 않게 (E-3)
export const RefPicker = memo(function RefPicker({
  label,
  value,
  refs,
  local,
  disabled = false,
  invalid = null,
  verify,
  onCommit,
}: RefPickerProps) {
  const t = S.comparison.refPicker;
  const baseId = useId();
  const listId = `${baseId}-list`;
  const errorId = `${baseId}-error`;
  const invalidId = `${baseId}-invalid`;
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  // 같은 닫힘이 두 경로(바깥 클릭 + 포커스 이동)로 와도 한 번만 적용하고, 닫은 뒤 늦게 온 확인 결과를 버린다
  const openRef = useRef(false);
  const verifyToken = useRef(0);
  // 연 직후 검색칸 글자를 어떻게 둘지 (전체 선택 / 끝에 커서)
  const caret = useRef<'all' | 'end' | null>(null);

  const localValue = local?.value;
  const localLabel = local?.label;
  const localDetail = local?.detail;
  const sections = useMemo(
    () =>
      refSections(
        refs,
        localValue === undefined
          ? undefined
          : { value: localValue, label: localLabel ?? '', detail: localDetail ?? '' },
      ),
    [refs, localValue, localLabel, localDetail],
  );
  const description = useMemo(() => describeRef(value, refs, local), [value, refs, local]);
  // 지금 값에 해당하는 목록 항목 (짧은 이름이면 git 이 쓰는 ref)
  const chosenKey = useMemo(() => {
    const options = sections.flatMap((section) => section.options);
    return (
      options.find((o) => o.value === value)?.value ??
      options.find((o) => o.value === (description.ambiguous ?? description.title))?.value ??
      null
    );
  }, [sections, value, description]);
  const filtered = useMemo(() => filterRefSections(sections, query), [sections, query]);
  const rows = useMemo<Row[]>(() => {
    const typed: Row[] = filtered.typed
      ? [{ key: TYPED_KEY, kind: 'typed', text: filtered.typed.text }]
      : [];
    const options: Row[] = filtered.sections.flatMap((section) =>
      section.options.map((option) => ({
        key: option.value,
        kind: 'option' as const,
        option,
        section: section.id,
      })),
    );
    return filtered.typed?.first ? [...typed, ...options] : [...options, ...typed];
  }, [filtered]);
  const activeIndex = Math.max(
    0,
    rows.findIndex((row) => row.key === activeKey),
  );
  const active = rows[activeIndex] ?? null;
  const rowId = (index: number) => `${baseId}-row-${index}`;

  // 연 직후: 검색칸 글자를 고르고 활성 항목이 보이게 한다 (Popover 가 먼저 검색칸에 포커스를 준다)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 열릴 때 한 번만 본다
  useEffect(() => {
    if (!open) return;
    const input = inputRef.current;
    if (input && caret.current === 'all') input.select();
    if (input && caret.current === 'end')
      input.setSelectionRange(input.value.length, input.value.length);
    caret.current = null;
    document.getElementById(rowId(activeIndex))?.scrollIntoView?.({ block: 'nearest' });
  }, [open]);

  /** 연다. `typed` 를 주면 그 글자로 검색하며 열고(글자 치며 열기), 아니면 지금 값에 맞춰 연다 */
  const openWith = (typed?: string) => {
    if (disabled || openRef.current) return;
    openRef.current = true;
    verifyToken.current += 1;
    setChecking(false);
    setFailed(null);
    if (typed !== undefined) {
      setQuery(typed);
      setActiveKey(null);
      caret.current = 'end';
    } else if (chosenKey !== null) {
      setQuery('');
      setActiveKey(chosenKey);
    } else {
      // 해시·식·목록에 없는 이름: 검색칸에 채우고 전체 선택, 활성은 "입력한 값 사용" 줄
      setQuery(value);
      setActiveKey(TYPED_KEY);
      caret.current = 'all';
    }
    setOpen(true);
  };

  /** 닫는다. `restore` 면 칸으로 포커스를 돌린다 (고른 뒤·Esc). 진행 중인 확인의 결과는 버린다 */
  const close = (restore: boolean) => {
    if (!openRef.current) return;
    openRef.current = false;
    verifyToken.current += 1;
    setOpen(false);
    setChecking(false);
    setFailed(null);
    if (restore) trigger?.focus();
  };

  /** 줄 하나를 고른다: ref 는 바로 확정, 직접 입력은 확인한 뒤 확정 (실패면 열어 둔 채 오류를 보인다) */
  const pick = (row: Row | null) => {
    if (!row || checking) return;
    if (row.kind === 'option') {
      if (row.option.value !== value) onCommit(row.option.value);
      close(true);
      return;
    }
    const text = row.text;
    if (text === value) {
      close(true);
      return;
    }
    const token = verifyToken.current + 1;
    verifyToken.current = token;
    setChecking(true);
    setFailed(null);
    verify(text).then(
      () => {
        if (token !== verifyToken.current || !openRef.current) return;
        onCommit(text);
        close(true);
      },
      () => {
        if (token !== verifyToken.current || !openRef.current) return;
        setChecking(false);
        setFailed(text);
      },
    );
  };

  /** 활성 줄을 옮기고 보이게 한다 (양끝에서 멈춘다) */
  const move = (index: number) => {
    const next = Math.max(0, Math.min(index, rows.length - 1));
    const row = rows[next];
    if (!row) return;
    setActiveKey(row.key);
    document.getElementById(rowId(next))?.scrollIntoView?.({ block: 'nearest' });
  };

  /** 닫힌 칸의 키: 열기와 글자 치며 열기. 잠겼으면 아무것도 하지 않는다 */
  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled || open) return;
    if (isImeKey(e)) {
      openWith('');
      return;
    }
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openWith();
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // 맨 글자 전역 단축키가 함께 돌지 않게 막는다
      e.preventDefault();
      openWith(e.key);
    }
  };

  /** 검색칸의 키 (한글 조합 중의 Enter·↑↓ 는 입력기 몫이다). Esc·Tab 은 Popover 가 맡는다 */
  const onInputKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e)) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(activeIndex + (e.key === 'ArrowDown' ? 1 : -1));
    } else if ((e.key === 'Home' || e.key === 'End') && query === '') {
      e.preventDefault();
      move(e.key === 'Home' ? 0 : rows.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    }
  };

  /** 옵션에 포커스가 간 경우(클릭 등)의 Enter·Space: 그 줄을 고른다. 평소 포커스는 검색칸에 있다 */
  const onOptionKeyDown = (e: KeyboardEvent<HTMLDivElement>, row: Row) => {
    if ((e.key === 'Enter' || e.key === ' ') && !isImeKey(e)) {
      e.preventDefault();
      pick(row);
    }
  };

  /** 팝오버의 닫기 요청: Esc 는 칸으로 돌아간다 (Tab 은 Popover 가 칸으로 돌리고, 바깥 클릭은 그 자리가 가져간다) */
  const onPopoverClose = (reason: PopoverCloseReason) => close(reason === 'escape');

  /** 줄 하나를 그린다 */
  const renderRow = (row: Row, index: number) => {
    const isActive = index === activeIndex;
    if (row.kind === 'typed') {
      return (
        <div
          key={row.key}
          id={rowId(index)}
          role="option"
          tabIndex={-1}
          aria-selected={isActive}
          aria-label={t.typedValue(row.text)}
          className={styles.option}
          data-active={isActive ? 'true' : 'false'}
          title={t.typedTitle(row.text)}
          onMouseDown={(e) => e.preventDefault()}
          onMouseEnter={() => setActiveKey(row.key)}
          onClick={() => pick(row)}
          onKeyDown={(e) => onOptionKeyDown(e, row)}
        >
          <span className={styles.check} />
          <span className={styles.icon} data-tone="commit">
            <Icon name="commit" />
          </span>
          <span className={styles.typed}>
            {t.typedValue('')}
            <span className={styles.mono}>{row.text}</span>
          </span>
          <span className={styles.aside}>{t.typedAside}</span>
        </div>
      );
    }
    const d = row.option.description;
    const chosen = row.key === chosenKey;
    const aside = d.current ? t.current : d.kind === 'workingTree' ? local?.detail : d.detail;
    return (
      <div
        key={row.key}
        id={rowId(index)}
        role="option"
        tabIndex={-1}
        aria-selected={isActive}
        aria-label={t.option(d.name, kindWord(d), d.current, chosen)}
        className={styles.option}
        data-active={isActive ? 'true' : 'false'}
        data-current={d.current ? 'true' : undefined}
        title={d.title}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => setActiveKey(row.key)}
        onClick={() => pick(row)}
        onKeyDown={(e) => onOptionKeyDown(e, row)}
      >
        <span className={styles.check}>{chosen ? <Icon name="checkMark" /> : null}</span>
        <span className={styles.icon} data-tone={d.kind}>
          <Icon name={KIND_ICON[d.kind]} />
        </span>
        <RefName name={d.name} mono={d.mono} full />
        {aside ? <span className={styles.aside}>{aside}</span> : null}
      </div>
    );
  };

  // 목록: 머리 없는 특수 줄, 묶음(머리 + 항목), "입력한 값 사용" 줄을 순서대로 그린다
  const listBody: ReactNode[] = [];
  let index = 0;
  if (filtered.typed?.first && rows[0]?.kind === 'typed') {
    listBody.push(renderRow(rows[0], index));
    index += 1;
  }
  for (const section of filtered.sections) {
    const items = section.options.map(() => {
      const row = rows[index];
      const node = row ? renderRow(row, index) : null;
      index += 1;
      return node;
    });
    if (section.title === null) {
      listBody.push(...items);
      continue;
    }
    const headId = `${baseId}-group-${section.id}`;
    listBody.push(
      // biome-ignore lint/a11y/useSemanticElements: listbox 안의 옵션 묶음은 ARIA group 이어야 한다 (fieldset 은 listbox 의 자식이 될 수 없다)
      <div key={section.id} role="group" aria-labelledby={headId}>
        <div id={headId} className={styles.section}>
          {section.title}
        </div>
        {items}
      </div>,
    );
  }
  const last = rows[index];
  if (last?.kind === 'typed') listBody.push(renderRow(last, index));

  const hasRefs = sections.some(
    (section) => section.id !== 'special' && section.options.length > 0,
  );
  const emptyText =
    query.trim() !== '' && filtered.sections.length === 0
      ? t.noMatch
      : query.trim() === '' && !hasRefs
        ? t.noRefs
        : null;

  return (
    <>
      <button
        ref={setTrigger}
        type="button"
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t.trigger(
          label,
          kindWord(description),
          description.detail ? `${description.name} ${description.detail}` : description.name,
        )}
        aria-disabled={disabled || undefined}
        aria-describedby={invalid ? invalidId : undefined}
        data-invalid={invalid ? 'true' : undefined}
        title={disabled ? S.history.loading : description.title}
        onClick={() => (openRef.current ? close(false) : openWith())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={styles.icon} data-tone={description.kind}>
          <Icon name={KIND_ICON[description.kind]} />
        </span>
        <RefName name={description.name} mono={description.mono} />
        {description.detail ? <span className={styles.detail}>{description.detail}</span> : null}
        {description.ambiguous ? (
          <span className={styles.warning}>
            <Icon name="warning" />
          </span>
        ) : null}
        {invalid ? (
          <span className={styles.errorIcon}>
            <Icon name="error" />
          </span>
        ) : null}
        <span className={styles.chevron}>
          <Icon name="chevronDown" />
        </span>
      </button>
      {invalid ? (
        <span id={invalidId} className={styles.srOnly}>
          {invalid}
        </span>
      ) : null}
      <Popover
        open={open}
        anchor={trigger}
        onClose={onPopoverClose}
        label={label}
        initialFocus={inputRef}
        className={styles.popover}
      >
        <div className={styles.panel}>
          <div className={styles.searchRow}>
            <Icon name="search" />
            <input
              ref={inputRef}
              className={styles.searchInput}
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active ? rowId(activeIndex) : undefined}
              aria-label={t.search(label)}
              aria-invalid={failed !== null || undefined}
              aria-describedby={failed !== null ? errorId : undefined}
              placeholder={t.placeholder}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveKey(null);
                // 고쳐 쓰면 지난 오류와 진행 중인 확인을 버린다
                verifyToken.current += 1;
                setChecking(false);
                setFailed(null);
              }}
              onKeyDown={onInputKeyDown}
            />
          </div>
          {checking ? (
            <div className={styles.status} role="status">
              {t.checking}
            </div>
          ) : null}
          {failed !== null ? (
            <div id={errorId} className={styles.error} role="alert">
              <Icon name="error" />
              {t.notFound(failed)}
            </div>
          ) : null}
          <div id={listId} className={styles.list} role="listbox" aria-label={label}>
            {listBody}
          </div>
          {emptyText ? <div className={styles.none}>{emptyText}</div> : null}
          {filtered.hidden > 0 ? (
            <div className={styles.note}>{t.more(filtered.hidden)}</div>
          ) : null}
        </div>
      </Popover>
    </>
  );
});
