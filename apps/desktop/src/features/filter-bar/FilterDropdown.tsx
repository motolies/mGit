import {
  Button,
  Icon,
  type IconName,
  isImeKey,
  Popover,
  type PopoverCloseReason,
  S,
} from '@mgit/ui';
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from 'react';
import styles from './FilterBar.module.css';
import {
  type ButtonSummary,
  type DateRange,
  dayInputOf,
  dayOf,
  describeRange,
  parseDayInput,
  QUICK_RANGES,
  quickRange,
  rangeOfDays,
  sameChecked,
  splitList,
  toggleChecked,
} from './filter-model';

/** 닫기: `restoreFocus` 면 단추로 포커스를 돌린다 (Esc·안에서 고른 뒤). 바깥 클릭·Tab 으로 닫으면 돌리지 않는다 */
type Close = (restoreFocus: boolean) => void;

interface FilterDropdownProps {
  /** 조건 이름 (단추의 접근성 이름에도 쓴다) */
  name: string;
  icon: IconName;
  summary: ButtonSummary;
  /** 단추 안 × : 이 조건만 지운다 */
  onClear: () => void;
  /** 열릴 때 (작성자 후보 읽기 등) */
  onOpen?: () => void;
  /** 닫힐 때 한 번 (체크 목록은 여기서 적용한다) */
  onClosed?: () => void;
  /** 필터 바의 첫 드롭다운인지 (⌘⇧G 가 포커스를 준다) */
  first?: boolean;
  /** 열 때 포커스를 줄 안쪽 요소 */
  initialFocus?: RefObject<HTMLElement | null>;
  /**
   * 잠금 (저장소 탭의 쓰기 진행 중, W26): 단추·× 가 `aria-disabled` 가 되고 눌러도 열거나 지우지 않는다. 포커스와 Tab
   * 정지는 그대로다 (`disabled` 는 포커스를 잃는다). 이미 열린 팝오버는 닫을 때 그대로 적용한다
   */
  locked?: boolean;
  children: (close: Close) => ReactNode;
}

/**
 * 필터 드롭다운 하나: 단추(지금 고른 값의 요약 + 고른 것이 있으면 ×) + 팝오버. 고른 것이 없으면 이름만 흐리게
 * 보인다. 바깥 클릭·Esc·Tab 으로 닫히고, Esc 로 닫으면 포커스가 단추로 돌아온다
 */
function FilterDropdown({
  name,
  icon,
  summary,
  onClear,
  onOpen,
  onClosed,
  first,
  initialFocus,
  locked = false,
  children,
}: FilterDropdownProps) {
  const [open, setOpen] = useState(false);
  const [button, setButton] = useState<HTMLButtonElement | null>(null);
  // 같은 닫힘이 두 경로(바깥 클릭 + 포커스 이동)로 와도 한 번만 적용한다
  const openRef = useRef(false);

  const close: Close = (restoreFocus) => {
    if (!openRef.current) {
      return;
    }
    openRef.current = false;
    setOpen(false);
    onClosed?.();
    if (restoreFocus) {
      button?.focus();
    }
  };
  /** 단추: 닫혀 있으면 열고(잠겨 있으면 열지 않는다), 열려 있으면 닫는다 */
  const toggle = () => {
    if (openRef.current) {
      close(false);
      return;
    }
    if (locked) {
      return;
    }
    openRef.current = true;
    setOpen(true);
    onOpen?.();
  };
  /** 팝오버의 닫기 요청: Esc 는 포커스를 단추로 돌린다 */
  const onPopoverClose = (reason: PopoverCloseReason) => close(reason === 'escape');
  // 잠긴 까닭은 툴팁 둘째 줄에
  const lockNote = locked ? `\n${S.filterBar.locked}` : '';

  return (
    <span className={styles.drop} data-active={summary.active ? 'true' : 'false'}>
      <button
        ref={setButton}
        type="button"
        className={styles.dropButton}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={locked || undefined}
        title={`${summary.title}${lockNote}`}
        data-filter-first={first ? '' : undefined}
        onClick={toggle}
      >
        <Icon name={icon} />
        <span className={styles.dropLabel}>{summary.label}</span>
        <Icon name="chevronDown" />
      </button>
      {summary.active ? (
        <button
          type="button"
          className={styles.dropClear}
          aria-label={S.filterBar.clearCondition(summary.label)}
          aria-disabled={locked || undefined}
          title={`${S.filterBar.clearCondition(summary.label)}${lockNote}`}
          onClick={locked ? undefined : onClear}
        >
          <Icon name="close" />
        </button>
      ) : null}
      <Popover
        open={open}
        anchor={button}
        onClose={onPopoverClose}
        label={name}
        initialFocus={initialFocus}
      >
        {children(close)}
      </Popover>
    </span>
  );
}

/** 체크 목록의 항목 */
export interface CheckOption {
  id: string;
  label: string;
  /** 이름 뒤의 흐린 글자 (이메일 등) */
  detail?: string;
  /** 오른쪽 끝의 흐린 글자 (커밋 수·현재 표시 등) */
  aside?: string;
  /** 저장소 색 번호 (`--graph-lane-N`) */
  color?: number | null;
  /** 묶음 이름. 앞 항목과 다르면 묶음 머리를 그린다 */
  section?: string;
  title?: string;
}

/** 검색어로 항목을 거른다 (이름·흐린 글자의 부분 일치, 대소문자 무시) */
export function filterOptions(options: readonly CheckOption[], search: string): CheckOption[] {
  const q = search.trim().toLowerCase();
  if (q === '') {
    return [...options];
  }
  return options.filter((o) => `${o.label}\n${o.detail ?? ''}`.toLowerCase().includes(q));
}

/**
 * 체크한 id 를 적용할 순서로: 목록 순서를 따르고, 목록에 없는 id(지금 후보에 없는 값)는 앞에 둔다. 같은 체크가 늘
 * 같은 질의가 되게 한다
 */
export function orderChecked(
  checked: readonly string[],
  options: readonly CheckOption[],
): string[] {
  const set = new Set(checked);
  const known = new Set(options.map((o) => o.id));
  return [
    ...checked.filter((id) => !known.has(id)),
    ...options.filter((o) => set.has(o.id)).map((o) => o.id),
  ];
}

interface ChecklistDropdownProps {
  name: string;
  icon: IconName;
  summary: ButtonSummary;
  options: readonly CheckOption[];
  /** 지금 적용된 체크 */
  selected: readonly string[];
  /** 닫을 때 체크가 바뀌었으면 한 번 부른다 (git 을 체크마다 돌리지 않는다) */
  onApply: (ids: string[]) => void;
  /** 다른 항목과 함께 고를 수 없는 항목 (branch 의 HEAD) */
  exclusive?: readonly string[];
  /** 고른 값 중 목록에 없는 것의 묶음 이름 (지울 수 있게 맨 앞에 보인다) */
  missingSection: string;
  /** 목록 위의 상태 줄 (읽는 중·실패·잘림 등) */
  status?: ReactNode;
  /** 목록 아래의 안내 */
  note?: ReactNode;
  onOpen?: () => void;
  first?: boolean;
  locked?: boolean;
  /**
   * 목록 아래의 단추 (저장소 탭 branch 의 "ref 이름 입력…", W26). 누르면 초안을 적용하지 않고 팝오버를 닫은 뒤 그때의
   * 초안(적용할 순서)을 넘긴다 — 받은 쪽이 그 초안에서 이어서 고친다
   */
  action?: { label: string; onSelect: (draft: string[]) => void };
}

/**
 * 여러 개 체크 드롭다운 (저장소·branch·작성자). 열 때 지금 값을 초안으로 복사하고, 체크는 초안만 바꾸며, 닫을 때
 * 바뀐 것이 있으면 한 번 적용한다. 검색 칸에서 ↑↓ 로 항목을 옮기고 Enter 로 체크한다
 */
export function ChecklistDropdown({
  name,
  icon,
  summary,
  options,
  selected,
  onApply,
  exclusive,
  missingSection,
  status,
  note,
  onOpen,
  first,
  locked,
  action,
}: ChecklistDropdownProps) {
  const [draft, setDraft] = useState<string[]>([]);
  // 닫힐 때 읽는 최신 초안 (닫기 콜백이 렌더 사이에 불려도 마지막 체크를 놓치지 않게)
  const draftRef = useRef<string[]>([]);
  // 아래 단추로 닫을 때는 초안을 적용하지 않는다 (단추를 받은 쪽에 넘긴다)
  const skipApply = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  /** 초안을 바꾼다 */
  const setChecked = (next: string[]) => {
    draftRef.current = next;
    setDraft(next);
  };
  // 지금 값 중 목록에 없는 것도 보이고 지울 수 있게 맨 앞에 둔다
  const known = new Set(options.map((o) => o.id));
  const missing: CheckOption[] = [...new Set([...selected, ...draft])]
    .filter((id) => !known.has(id))
    .map((id) => ({ id, label: id, section: missingSection }));
  const all = [...missing, ...options];

  return (
    <FilterDropdown
      name={name}
      icon={icon}
      summary={summary}
      first={first}
      locked={locked}
      initialFocus={searchRef}
      onClear={() => onApply([])}
      onOpen={() => {
        setChecked([...selected]);
        onOpen?.();
      }}
      onClosed={() => {
        if (skipApply.current) {
          skipApply.current = false;
          return;
        }
        if (!sameChecked(draftRef.current, selected)) {
          onApply(orderChecked(draftRef.current, all));
        }
      }}
    >
      {(close) => (
        <>
          <Checklist
            name={name}
            options={all}
            checked={draft}
            onToggle={(id) => setChecked(toggleChecked(draftRef.current, id, exclusive))}
            inputRef={searchRef}
            status={status}
            note={note}
          />
          {action ? (
            <div className={styles.listAction}>
              <button
                type="button"
                className={styles.linkButton}
                onClick={() => {
                  const picked = orderChecked(draftRef.current, all);
                  skipApply.current = true;
                  close(true);
                  action.onSelect(picked);
                }}
              >
                {action.label}
              </button>
            </div>
          ) : null}
        </>
      )}
    </FilterDropdown>
  );
}

interface ChecklistProps {
  name: string;
  options: readonly CheckOption[];
  checked: readonly string[];
  onToggle: (id: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  status?: ReactNode;
  note?: ReactNode;
}

/** 검색 칸 + 체크 목록 (listbox). 포커스는 검색 칸에 두고 지금 항목을 `aria-activedescendant` 로 알린다 */
function Checklist({ name, options, checked, onToggle, inputRef, status, note }: ChecklistProps) {
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const shown = filterOptions(options, search);
  const current = Math.min(active, shown.length - 1);
  const optionId = (i: number) => `${listId}-o${i}`;

  /** 지금 항목을 옮기고 보이게 한다 */
  const move = (next: number) => {
    const i = Math.max(0, Math.min(next, shown.length - 1));
    setActive(i);
    document.getElementById(optionId(i))?.scrollIntoView?.({ block: 'nearest' });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e)) {
      return;
    }
    // Space 는 검색어가 비어 있을 때만 체크다 (W19 ③) — 검색어 안의 공백(작성자 이름 등)은 그대로 입력된다.
    // 맨 앞 공백은 검색에서 어차피 무시되므로 빈 칸의 Space 를 체크로 써도 잃는 것이 없다
    const check = e.key === 'Enter' || (e.key === ' ' && search === '');
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      move(current + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      // 검색어가 있으면 입력란의 처음·끝 이동이다
      if (search === '') {
        e.preventDefault();
        move(e.key === 'Home' ? 0 : shown.length - 1);
      }
    } else if (check) {
      e.preventDefault();
      const option = shown[current];
      if (option) {
        onToggle(option.id);
      }
    }
  };

  return (
    <div className={styles.checklist}>
      <div className={styles.searchRow}>
        <Icon name="search" />
        <input
          ref={inputRef}
          className={styles.searchInput}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={current >= 0 ? optionId(current) : undefined}
          aria-label={S.filterBar.search(name)}
          placeholder={S.filterBar.search(name)}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {status}
      <div id={listId} className={styles.list} role="listbox" aria-multiselectable="true">
        {shown.map((o, i) => {
          const isChecked = checked.includes(o.id);
          const header = o.section !== undefined && o.section !== shown[i - 1]?.section;
          return [
            header ? (
              <div key={`s:${o.section}`} className={styles.section} role="presentation">
                {o.section}
              </div>
            ) : null,
            <div
              key={o.id}
              id={optionId(i)}
              role="option"
              aria-selected={isChecked}
              // 포커스는 검색 칸에 두고 지금 항목은 aria-activedescendant 로 알린다 (Tab 순서에 넣지 않는다)
              tabIndex={-1}
              className={styles.option}
              data-active={i === current ? 'true' : 'false'}
              title={o.title ?? (o.detail ? `${o.label} ${o.detail}` : o.label)}
              // 누르는 동안 포커스를 검색 칸에 둔다 (팝오버 밖으로 나간 것으로 보지 않게)
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => onToggle(o.id)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && !isImeKey(e)) {
                  e.preventDefault();
                  onToggle(o.id);
                }
              }}
            >
              <span className={styles.check} data-checked={isChecked ? 'true' : 'false'}>
                {isChecked ? <Icon name="checkMark" /> : null}
              </span>
              {o.color !== undefined && o.color !== null ? (
                <span
                  className={styles.swatch}
                  style={{ '--repo-color': `var(--graph-lane-${o.color})` } as CSSProperties}
                  aria-hidden="true"
                />
              ) : null}
              <span className={styles.optLabel}>{o.label}</span>
              {o.detail ? <span className={styles.optDetail}>{o.detail}</span> : null}
              {o.aside ? <span className={styles.optAside}>{o.aside}</span> : null}
            </div>,
          ];
        })}
      </div>
      {shown.length === 0 && status === undefined ? (
        <div className={styles.none}>
          {options.length === 0 ? S.filterBar.noOptions : S.filterBar.noMatch}
        </div>
      ) : null}
      {note ? <div className={styles.note}>{note}</div> : null}
    </div>
  );
}

interface DateDropdownProps {
  summary: ButtonSummary;
  range: DateRange;
  onApply: (range: DateRange) => void;
  now: () => Date;
  first?: boolean;
  locked?: boolean;
}

/**
 * 날짜 드롭다운: 빠른 선택(오늘·최근 7일·최근 30일 — 고른 시점에 고정한 범위)과 직접 범위(시작·끝 날짜). 빠른 선택은
 * 누르면 바로 적용하고 닫는다. 직접 범위는 "적용"(또는 날짜 칸의 Enter)으로 적용한다
 */
export function DateDropdown({ summary, range, onApply, now, first, locked }: DateDropdownProps) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const firstRef = useRef<HTMLButtonElement>(null);
  const t = S.filterBar.dates;
  // 지금 값과 같은 빠른 선택 (눌린 것으로 보인다)
  const label = describeRange(range, now());

  return (
    <FilterDropdown
      name={S.filterBar.date}
      icon="date"
      summary={summary}
      first={first}
      locked={locked}
      initialFocus={firstRef}
      onClear={() => onApply({ since: null, until: null })}
      onOpen={() => {
        setFrom(range.since === null ? '' : dayInputOf(dayOf(range.since)));
        setTo(range.until === null ? '' : dayInputOf(dayOf(range.until)));
      }}
    >
      {(close) => {
        /** 직접 고른 범위를 적용하고 닫는다 */
        const applyCustom = () => {
          onApply(rangeOfDays(parseDayInput(from), parseDayInput(to)));
          close(true);
        };
        const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter' && !isImeKey(e)) {
            e.preventDefault();
            applyCustom();
          }
        };
        return (
          <div className={styles.dates}>
            <div className={styles.quick}>
              {QUICK_RANGES.map((kind, i) => (
                <button
                  key={kind}
                  ref={i === 0 ? firstRef : undefined}
                  type="button"
                  className={styles.quickButton}
                  aria-pressed={label === t[kind]}
                  onClick={() => {
                    onApply(quickRange(kind, now()));
                    close(true);
                  }}
                >
                  {t[kind]}
                </button>
              ))}
            </div>
            <div className={styles.section}>{t.custom}</div>
            <div className={styles.custom}>
              <label className={styles.dateField}>
                {t.from}
                <input
                  type="date"
                  className={styles.dateInput}
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  onKeyDown={onEnter}
                />
              </label>
              <label className={styles.dateField}>
                {t.to}
                <input
                  type="date"
                  className={styles.dateInput}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  onKeyDown={onEnter}
                />
              </label>
              <Button onClick={applyCustom}>{t.apply}</Button>
            </div>
            <div className={styles.note}>{t.note}</div>
          </div>
        );
      }}
    </FilterDropdown>
  );
}

interface PathDropdownProps {
  summary: ButtonSummary;
  /** 지금 적용된 경로 범위 */
  paths: readonly string[];
  /** 닫을 때 경로가 바뀌었으면 한 번 부른다 (빈 목록 = 범위 없음) */
  onApply: (paths: string[]) => void;
  /** 입력란의 자리 표시 글자 */
  placeholder: string;
  locked?: boolean;
}

/**
 * 경로 범위 드롭다운 (저장소 탭, W26 — 옛 그래프 필터 바의 경로 입력). 입력란 하나에 쉼표로 여럿을 적는다: 쉼표로
 * 나누고 앞뒤 공백을 다듬고 빈 항목은 버린다(`splitList`). 다른 드롭다운처럼 닫으면 적용하고(바뀐 것이 없으면 부르지
 * 않는다), Enter·"적용"은 적용하고 닫는다. 한글 조합 중의 Enter 는 입력기 몫이다
 */
export function PathDropdown({ summary, paths, onApply, placeholder, locked }: PathDropdownProps) {
  const [text, setText] = useState('');
  // 닫힐 때 읽는 최신 입력 (닫기 콜백이 렌더 사이에 불려도 마지막 입력을 놓치지 않게)
  const textRef = useRef('');
  const inputRef = useRef<HTMLInputElement>(null);
  /** 입력을 바꾼다 */
  const edit = (value: string) => {
    textRef.current = value;
    setText(value);
  };

  return (
    <FilterDropdown
      name={S.filterBar.path}
      icon="folder"
      summary={summary}
      locked={locked}
      initialFocus={inputRef}
      onClear={() => onApply([])}
      onOpen={() => edit(paths.join(', '))}
      onClosed={() => {
        const next = splitList(textRef.current);
        if (next.join('\n') !== paths.join('\n')) {
          onApply(next);
        }
      }}
    >
      {(close) => (
        <div className={styles.paths}>
          <div className={styles.custom}>
            <input
              ref={inputRef}
              className={styles.pathInput}
              aria-label={S.filterBar.path}
              placeholder={placeholder}
              value={text}
              spellCheck={false}
              onChange={(e) => edit(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isImeKey(e)) {
                  e.preventDefault();
                  close(true);
                }
              }}
            />
            <Button onClick={() => close(true)}>{S.filterBar.dates.apply}</Button>
          </div>
          <div className={styles.note}>{S.filterBar.pathNote}</div>
        </div>
      )}
    </FilterDropdown>
  );
}
