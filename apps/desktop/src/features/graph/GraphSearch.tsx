import { Button, isImeKey, S } from '@mgit/ui';
import { useEffect, useRef, useState } from 'react';
import { useCommandTitle } from '../../components/use-command-shortcut';
import { useSession } from '../../store';
import styles from './GraphSearch.module.css';

/** 빈 문자열은 null */
function orNull(text: string): string | null {
  const t = text.trim();
  return t === '' ? null : t;
}

/** 그래프 검색 바 (GRAPH-06 + GRAPH-07 고급): 입력 → 코어 검색 → n/N 이동 */
export function GraphSearch() {
  const previousTitle = useCommandTitle('log.searchPrevious', S.search.prev);
  const nextTitle = useCommandTitle('log.searchNext', S.search.next);
  const s = useSession((st) => ({
    search: st.search,
    runSearch: st.runSearch,
    runAdvanced: st.runAdvancedSearch,
    step: st.searchStep,
    setOpen: st.setSearchOpen,
  }));
  const [text, setText] = useState(s.search.query);
  const [advanced, setAdvanced] = useState(s.search.advanced !== null);
  const [author, setAuthor] = useState(s.search.advanced?.author ?? '');
  const [path, setPath] = useState(s.search.advanced?.path ?? '');
  const [pickaxe, setPickaxe] = useState(s.search.advanced?.pickaxe ?? '');
  const [regex, setRegex] = useState(s.search.advanced?.pickaxeRegex ?? false);
  const [since, setSince] = useState(s.search.advanced?.since ?? '');
  const [until, setUntil] = useState(s.search.advanced?.until ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    // 입력 직후 닫아도 밀린 검색이 돌지 않게 한다
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
      }
    };
  }, []);

  /** 고급 조건으로 검색 (모두 AND) */
  const runAdvanced = () =>
    void s.runAdvanced({
      text: orNull(text),
      author: orNull(author),
      path: orNull(path),
      pickaxe: orNull(pickaxe),
      pickaxeRegex: regex,
      since: orNull(since),
      until: orNull(until),
    });

  /** 입력이 멈추면 검색한다 (200ms). 고급 모드에서는 Enter 로만 */
  const onChange = (value: string) => {
    setText(value);
    if (advanced) {
      return;
    }
    if (timer.current) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(() => void s.runSearch(value), 200);
  };

  /** Enter: 고급이면 검색, 아니면 재검색 또는 다음 항목 */
  const onEnter = (shift: boolean) => {
    if (advanced) {
      runAdvanced();
    } else if (text !== s.search.query) {
      void s.runSearch(text);
    } else {
      s.step(shift ? -1 : 1);
    }
  };

  /** 고급 필드 공통 키 처리 */
  const fieldKeys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeKey(e)) {
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runAdvanced();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      s.setOpen(false);
    }
  };

  return (
    <>
      <div className={styles.bar}>
        <input
          ref={inputRef}
          className={styles.input}
          value={text}
          placeholder={S.search.placeholder}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (isImeKey(e)) {
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              onEnter(e.shiftKey);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              s.setOpen(false);
            }
          }}
        />
        <span className={styles.count}>
          {S.search.count(s.search.cursor, s.search.total)}
          {s.search.truncated ? ` ${S.search.truncated}` : ''}
        </span>
        <Button
          title={previousTitle}
          onClick={() => s.step(-1)}
          disabled={s.search.rows.length === 0}
        >
          {S.search.prev}
        </Button>
        <Button title={nextTitle} onClick={() => s.step(1)} disabled={s.search.rows.length === 0}>
          {S.search.next}
        </Button>
        <Button
          variant={advanced ? 'primary' : undefined}
          aria-pressed={advanced}
          onClick={() => setAdvanced((v) => !v)}
        >
          {S.search.advanced}
        </Button>
        <Button onClick={() => s.setOpen(false)}>{S.search.close}</Button>
      </div>
      {advanced ? (
        <div className={styles.advanced}>
          <label className={styles.field}>
            {S.search.author}
            <input
              className={styles.small}
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              onKeyDown={fieldKeys}
            />
          </label>
          <label className={styles.field}>
            {S.search.path}
            <input
              className={styles.small}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={fieldKeys}
            />
          </label>
          <label className={styles.field}>
            {S.search.pickaxe}
            <input
              className={styles.small}
              value={pickaxe}
              onChange={(e) => setPickaxe(e.target.value)}
              onKeyDown={fieldKeys}
            />
          </label>
          <label className={styles.field}>
            <input type="checkbox" checked={regex} onChange={(e) => setRegex(e.target.checked)} />
            {S.search.pickaxeRegex}
          </label>
          <label className={styles.field}>
            {S.search.since}
            <input
              className={styles.small}
              value={since}
              placeholder="2025-01-01"
              onChange={(e) => setSince(e.target.value)}
              onKeyDown={fieldKeys}
            />
          </label>
          <label className={styles.field}>
            {S.search.until}
            <input
              className={styles.small}
              value={until}
              placeholder="1 week ago"
              onChange={(e) => setUntil(e.target.value)}
              onKeyDown={fieldKeys}
            />
          </label>
          <Button variant="primary" onClick={runAdvanced}>
            {S.search.run}
          </Button>
        </div>
      ) : null}
    </>
  );
}
