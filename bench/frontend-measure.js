// W18 ② 화면(프런트) 렌더링 측정 도구. 페이지 안에서 돌리는 순수 JS 다 (의존성·빌드 없음, 앱 코드를 고치지 않는다).
//
// 쓰는 법 (자세한 절차는 bench/README.md "W18 ② 화면 측정"):
//   - 브라우저 자동화의 초기화 스크립트로 넣는다 (Playwright `page.addInitScript({ path: '<이 파일의 절대 경로>' })`).
//     문서가 만들어질 때마다 먼저 돌아 `window.__mgitMeasure` 를 만든다. 페이지를 연 뒤 `page.evaluate` 로 넣어도
//     도우미·시나리오는 쓸 수 있지만, 첫 표시 표식(`marks`)과 렌더 계수는 문서 시작부터 돌아야 한다.
//   - 렌더 계수(재렌더 범위)는 `localStorage['mgit.measure.renders'] = '1'` 일 때만 켠다: React 가 뜨기 전에 개발 도구
//     훅(`__REACT_DEVTOOLS_GLOBAL_HOOK__`) 자리에 계수기를 놓는다. 시간 측정은 이 값을 끈 채로 한다.
//     `'boot'` 이면 문서 시작부터 기록을 켠다 — 첫 표시 동안 영역별로 무엇을 그렸는지 (W29, `renders.stop()` 이나
//     `renders.until(ms)` 로 읽는다).
//   - W29 부터 저장소 탭 시나리오의 기본 영역 이름은 새 셸(`git-log`·`git-detail`)이고, 탭 전환·저장소 탭 열기의 끝은
//     "바꾸기 전 로그 행이 DOM 에서 빠지고 그 탭이 활성"을 더 본다. 옛 틀(W18 ②)의 수치를 다시 내려면
//     `repoGraph({ panel: 'center', detail: 'detail' })`·`repoTabReady('center')`·`openRepoTab({ panel: 'center', strict: false })`·
//     `tabSwitch({ …, strict: false })` 로 부른다 (옛 틀 `MainLayout` 은 W28 에서 지워져 지금 빌드에는 없다).
//   - 수치는 Playwright 의 Chromium 것이라 실제 앱(WKWebView)과 다르다. 상대 비교와 기준 대비 여유를 보는 용도다.
//
// 시간의 뜻: "동작 → 다음 그리기" 는 동작을 보낸 시각부터, (기다릴 조건이 있으면 그 조건이 참이 된 뒤) 두 번째
// requestAnimationFrame 이 돈 시각까지다. 그린 프레임 다음 프레임의 시작이므로 실제보다 최대 한 프레임 길다. 시나리오는
// 동작을 프레임 시작 직후에 보내므로 아무 일도 없을 때의 바닥값이 두 프레임이다 (120Hz 화면이면 16.7ms, 60Hz 면 33.3ms —
// 같은 기계에서 잰 값끼리만 견준다).
(() => {
  if (window.__mgitMeasure) {
    return;
  }

  /** React 파이버 태그 (React 19): 함수·클래스·forwardRef·memo 컴포넌트, 호스트(DOM) 요소 */
  const COMPONENT_TAGS = new Set([0, 1, 11, 14, 15]);
  const HOST_TAGS = new Set([5, 26, 27]);
  /** 파이버 flags 의 PerformedWork (이번 렌더에서 컴포넌트 함수가 실제로 돌았다) */
  const PERFORMED_WORK = 1;

  const M = {
    version: 2,
    /** 렌더 계수를 기록하는 중인지 */
    recording: false,
    /** 기록한 커밋 (커밋마다 영역별 렌더 수) */
    commits: [],
    /** 문서 시작부터 잰 표식: 이름 → { dom, paint } (ms, performance.now 기준) */
    marks: {},
    /** 긴 작업 (50ms 넘는 메인 스레드 작업) */
    longTasks: [],
    /**
     * 렌더 계수에서 영역 안을 더 나눠 볼 선택자 (W29): 호스트 요소가 영역 안의 이 선택자 안에 있으면 영역 이름을
     * `<영역> <선택자>` 로 센다. 예: `M.split = ['[data-filter-bar]']` → `git-log [data-filter-bar]`
     */
    split: [],
  };

  // ── 기본 도우미 ───────────────────────────────────────────────────────────────

  /** 선택자 하나 */
  const q = (sel, root = document) => root.querySelector(sel);
  /** 선택자 전부 (배열) */
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
  /** 없으면 던진다 */
  function need(sel, root = document) {
    const el = q(sel, root);
    if (!el) {
      throw new Error(`요소 없음: ${sel}`);
    }
    return el;
  }
  /** 다음 애니메이션 프레임 (프레임 시작 시각을 준다) */
  const raf = () => new Promise((resolve) => requestAnimationFrame(resolve));
  /** 지금 걸린 그리기가 화면에 나간 뒤 (두 번째 rAF) */
  async function afterPaint() {
    await raf();
    await raf();
  }
  /** 조건이 참이 될 때까지 기다린다 (작업 사이마다 본다). 시간을 넘기면 던진다 */
  async function waitFor(pred, timeout = 20_000) {
    const t0 = performance.now();
    for (;;) {
      const value = pred();
      if (value) {
        return value;
      }
      if (performance.now() - t0 > timeout) {
        throw new Error(`기다리다 시간 초과 (${timeout}ms)`);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  /** 그 시각 이후에 시작한 긴 작업들 */
  const longTasksSince = (t) => M.longTasks.filter((e) => e.start >= t - 1);

  /**
   * 동작 하나의 시간: 동작 → (조건) → 다음 그리기. 결과는 { ms, longTasks: 50ms 넘는 작업 수, longest: 가장 긴 작업 }
   */
  async function time(action, until, timeout) {
    const t0 = performance.now();
    await action();
    if (until) {
      await waitFor(until, timeout);
    }
    await afterPaint();
    const ms = performance.now() - t0;
    const tasks = longTasksSince(t0);
    return {
      ms: round(ms),
      longTasks: tasks.length,
      longest: round(Math.max(0, ...tasks.map((e) => e.duration))),
    };
  }

  /** 소수 첫째 자리 */
  const round = (n) => Math.round(n * 10) / 10;

  /** 수 목록의 통계: 개수·중앙값·p95(최근접 순위)·최솟값·최댓값 */
  function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (p) =>
      sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
    return {
      n: sorted.length,
      median: round(at(0.5) ?? 0),
      p95: round(at(0.95) ?? 0),
      min: round(sorted[0] ?? 0),
      max: round(sorted[sorted.length - 1] ?? 0),
    };
  }

  /** 같은 측정을 n 번 해서 시간 통계와 긴 작업 수를 낸다. `fn(i)` 는 `time()` 의 결과를 준다 */
  async function repeat(n, fn) {
    const runs = [];
    for (let i = 0; i < n; i += 1) {
      runs.push(await fn(i));
      await afterPaint();
    }
    return {
      ...stats(runs.map((r) => r.ms)),
      longTasks: runs.reduce((sum, r) => sum + r.longTasks, 0),
      longest: round(Math.max(0, ...runs.map((r) => r.longest))),
      runs: runs.map((r) => r.ms),
    };
  }

  /** 클릭 (React 의 onClick 은 버블링되는 click 하나면 된다). `detail` 은 연속 클릭 수 */
  function click(el, init = {}) {
    el.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, ...init }),
    );
  }
  /** 키 누름 (keydown) */
  function key(el, k, init = {}) {
    el.dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
    );
  }
  /** 입력 칸 값 바꾸기 (React 의 onChange 가 듣는 input 이벤트) */
  function type(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  /** 스크롤되는 요소: 자신이나 조상 중 세로로 넘치는 첫 요소 */
  function scrollerOf(el) {
    for (let at = el; at; at = at.parentElement) {
      const style = getComputedStyle(at);
      if (/(auto|scroll)/.test(style.overflowY) && at.scrollHeight > at.clientHeight) {
        return at;
      }
    }
    return null;
  }
  /** 요소 수 (선택자가 없으면 문서 전체) */
  function domCount(sel) {
    const root = sel ? q(sel) : document;
    return root ? root.getElementsByTagName('*').length : 0;
  }

  /**
   * 스크롤 중 프레임 간격: 프레임마다 `step` px 씩 `frames` 번 옮기며(끝에 닿으면 방향을 바꾼다) rAF 간격을 잰다.
   * `busy` 를 주면 그 선택자(자리 표시 행)가 보인 프레임 수도 센다. 결과: 간격의 p50·p95·최대, 32ms·50ms 넘는 프레임 수,
   * 긴 작업 수·가장 긴 작업
   */
  async function scroll(el, { step, frames = 120, busy } = {}) {
    await afterPaint();
    const t0 = performance.now();
    const gaps = [];
    let busyFrames = 0;
    let dir = 1;
    let last = await raf();
    for (let i = 0; i < frames; i += 1) {
      const max = el.scrollHeight - el.clientHeight;
      if ((dir > 0 && el.scrollTop >= max - 1) || (dir < 0 && el.scrollTop <= 0)) {
        dir = -dir;
      }
      el.scrollTop += dir * step;
      const now = await raf();
      gaps.push(now - last);
      last = now;
      if (busy && q(busy, el)) {
        busyFrames += 1;
      }
    }
    const s = stats(gaps);
    const tasks = longTasksSince(t0);
    return {
      frames,
      step,
      p50: s.median,
      p95: s.p95,
      max: s.max,
      over32: gaps.filter((g) => g > 32).length,
      over50: gaps.filter((g) => g > 50).length,
      longTasks: tasks.length,
      longest: round(Math.max(0, ...tasks.map((e) => e.duration))),
      ...(busy ? { busyFrames } : {}),
    };
  }

  // ── 첫 표시 표식 (문서 시작부터) ────────────────────────────────────────────────

  /** 선택자가 처음 나타난 시각(dom)과 그 뒤 그리기(paint)를 표식으로 남긴다 */
  function watch(name, selector) {
    if (M.marks[name]) {
      return;
    }
    const check = () => {
      if (M.marks[name] || !document.querySelector(selector)) {
        return false;
      }
      const dom = performance.now();
      M.marks[name] = { dom: round(dom), paint: null };
      afterPaint().then(() => {
        M.marks[name].paint = round(performance.now());
      });
      return true;
    };
    if (check()) {
      return;
    }
    const observer = new MutationObserver(() => {
      if (check()) {
        observer.disconnect();
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }

  // ── 렌더 계수 (재렌더 범위) ──────────────────────────────────────────────────────

  /**
   * 파이버가 속한 화면 영역: 가장 가까운 호스트 요소를 감싼 앱의 `[data-panel]` 이름. 없으면 분할 패널
   * (react-resizable-panels 가 `data-panel="true"` 를 붙인다)의 id 를 `panel:<id>` 로, 그것도 없으면 'other'
   */
  function regionOf(fiber) {
    for (let f = fiber; f; f = f.return) {
      if (HOST_TAGS.has(f.tag) && f.stateNode?.closest) {
        const named = f.stateNode.closest('[data-panel]:not([data-panel="true"])');
        if (named) {
          const name = named.getAttribute('data-panel');
          for (const sel of M.split) {
            const inner = f.stateNode.closest(sel);
            if (inner && named.contains(inner)) {
              return `${name} ${sel}`;
            }
          }
          return name;
        }
        const split = f.stateNode.closest('[data-panel="true"]');
        return split ? `panel:${split.id}` : 'other';
      }
    }
    return 'other';
  }

  /**
   * 커밋 하나에서 다시 그린 것을 영역별로 센다 (React 개발 도구의 방식): 바뀌지 않은 하위 트리(새 트리와 옛 트리의
   * 자식이 같은 객체)는 건너뛰고, 컴포넌트는 이번에 함수가 돈 것(PerformedWork)·새로 붙은 것을, 호스트 요소는 props 가
   * 새로 만들어진 것·새로 붙은 것을 센다
   */
  function summarize(root) {
    const out = {};
    const add = (fiber, kind) => {
      const region = regionOf(fiber);
      out[region] ??= { components: 0, hosts: 0 };
      out[region][kind] += 1;
    };
    const visit = (next, prev) => {
      if (COMPONENT_TAGS.has(next.tag)) {
        if (prev === null || (next.flags & PERFORMED_WORK) !== 0) {
          add(next, 'components');
        }
      } else if (HOST_TAGS.has(next.tag)) {
        if (prev === null || next.memoizedProps !== prev.memoizedProps) {
          add(next, 'hosts');
        }
      }
      if (prev !== null && next.child === prev.child) {
        return;
      }
      for (let c = next.child; c; c = c.sibling) {
        visit(c, prev === null ? null : c.alternate);
      }
    };
    const current = root.current;
    visit(current, current.alternate);
    return out;
  }

  /** React 가 뜨기 전에 개발 도구 훅 자리에 계수기를 놓는다 (이미 훅이 있으면 놓지 않는다) */
  function installRenderHook() {
    if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) {
      return false;
    }
    let nextId = 1;
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      isDisabled: false,
      renderers: new Map(),
      inject(renderer) {
        const id = nextId++;
        this.renderers.set(id, renderer);
        return id;
      },
      checkDCE() {},
      onScheduleFiberRoot() {},
      onCommitFiberUnmount() {},
      onPostCommitFiberRoot() {},
      setStrictMode() {},
      onCommitFiberRoot(_id, root) {
        if (!M.recording) {
          return;
        }
        try {
          M.commits.push({ t: round(performance.now()), regions: summarize(root) });
        } catch (error) {
          M.commits.push({ error: String(error) });
        }
      },
    };
    return true;
  }

  /** 렌더 계수: 시작 → 동작 → 끝(영역별 합계와 커밋 수) */
  const renders = {
    installed: false,
    start() {
      M.commits = [];
      M.recording = true;
    },
    stop() {
      M.recording = false;
      return renders.until(Number.POSITIVE_INFINITY);
    },
    /** 기록한 커밋 중 시각 `t`(performance.now) 까지의 영역별 합계와 커밋 수 (기록은 그대로 둔다 — 첫 표시 나누기, W29) */
    until(t) {
      const total = {};
      const commits = M.commits.filter((c) => (c.t ?? 0) <= t);
      for (const commit of commits) {
        for (const [region, r] of Object.entries(commit.regions ?? {})) {
          total[region] ??= { components: 0, hosts: 0 };
          total[region].components += r.components;
          total[region].hosts += r.hosts;
        }
      }
      return { commits: commits.length, regions: total };
    },
    /** 동작 하나의 재렌더 범위: 기록을 켜고 동작·조건·그리기를 기다린 뒤 끈다 */
    async of(action, until, timeout) {
      renders.start();
      await action();
      if (until) {
        await waitFor(until, timeout);
      }
      await afterPaint();
      await afterPaint();
      return renders.stop();
    },
  };

  // ── 시나리오 (W18 ② 에서 잰 동작 그대로. W29 는 저장소 탭 것을 다시 돌린다) ───────────────────────────

  /** 이름이 그것인 탭 (Git 도구 창의 로그·콘솔, 에디터 탭 등) */
  const tabNamed = (name) => qa('[role="tab"]').find((t) => t.textContent.trim() === name);
  /** 접근성 이름(aria-label 또는 title)이 그것인 단추 */
  const buttonNamed = (name, root = document) =>
    qa('button', root).find(
      (b) => b.getAttribute('aria-label') === name || b.getAttribute('title') === name,
    );
  /** 잠깐 쉰다 (비동기 응답이 끝나기를 기다릴 조건이 없을 때만) */
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Git 도구 창의 로그 탭을 다시 붙인다: 콘솔 탭으로 갔다가(로그 탭이 내려간다) 로그 탭으로 돌아온 시간 */
  async function remountLog(until) {
    click(tabNamed('콘솔'));
    await waitFor(() => !q('[data-panel="git-log"]'));
    await afterPaint();
    return time(() => click(tabNamed('로그')), until);
  }

  /**
   * 브랜치 트리 (원격 브랜치 수는 조절값 `remoteBranches`): 첫 표시(로그 탭 다시 붙이기), 검색 한 글자·지우기, 모두
   * 펼치기·접기, 원격 그룹 접기·펼치기, 잎 클릭(로그 필터), 스크롤
   */
  async function branchTree({ n = 5, char = '4' } = {}) {
    const panel = '[data-panel="git-branches"]';
    const rowSel = `${panel} [role="treeitem"]`;
    const rows = () => qa(rowSel);
    const count = rows().length;
    const out = { rows: count, dom: domCount(panel) };
    out.firstShow = await repeat(n, () => remountLog(() => rows().length >= count));
    const input = () => need(`${panel} input[type="search"]`);
    const search = [];
    const clear = [];
    for (let i = 0; i < n; i += 1) {
      search.push(await time(() => type(input(), char)));
      clear.push(await time(() => type(input(), '')));
    }
    out.searchChar = summarizeRuns(search);
    out.searchClear = summarizeRuns(clear);
    const toolbar = need('[role="toolbar"][aria-label="브랜치 도구"]');
    const collapseAll = [];
    const expandAll = [];
    for (let i = 0; i < n; i += 1) {
      collapseAll.push(await time(() => click(buttonNamed('모두 접기', toolbar))));
      expandAll.push(await time(() => click(buttonNamed('모두 펼치기', toolbar))));
    }
    out.collapseAll = summarizeRuns(collapseAll);
    out.expandAll = summarizeRuns(expandAll);
    const group = () => rows().find((r) => r.getAttribute('data-node-id') === 'group:remote');
    const groupClose = [];
    const groupOpen = [];
    for (let i = 0; i < n; i += 1) {
      groupClose.push(await time(() => click(group())));
      groupOpen.push(await time(() => click(group())));
    }
    out.groupCollapse = summarizeRuns(groupClose);
    out.groupExpand = summarizeRuns(groupOpen);
    const leaves = () =>
      rows().filter((r) => (r.getAttribute('data-node-id') ?? '').startsWith('ref:refs/remotes/'));
    out.leafClick = await repeat(n, (i) => time(() => click(leaves()[i + 1])));
    // 로그 필터를 푼다 (branch 조건의 ×)
    const clearBranch = q('[data-filter-bar] button[aria-label^="필터 해제: branch"]');
    if (clearBranch) {
      click(clearBranch);
      await afterPaint();
    }
    const scroller = scrollerOf(need(`${panel} [role="tree"]`));
    out.scroll = scroller ? await scroll(scroller, { step: 22, frames: 120 }) : null;
    return out;
  }

  /** `time()` 결과 목록의 통계 (repeat 와 같은 모양) */
  function summarizeRuns(runs) {
    return {
      ...stats(runs.map((r) => r.ms)),
      longTasks: runs.reduce((sum, r) => sum + r.longTasks, 0),
      longest: round(Math.max(0, ...runs.map((r) => r.longest))),
      runs: runs.map((r) => r.ms),
    };
  }

  /** 상세 칸에 그 커밋이 떴는지 (해시 앞 8자) */
  const detailShows = (oid) =>
    (q('[data-panel="git-detail"]')?.textContent ?? '').includes(oid.slice(0, 8));

  /**
   * 변경 파일 트리 (파일 수는 조절값 `commitFiles`): 로그에서 커밋 선택 → 트리 표시(그 커밋의 상세가 뜨고 트리의 스크롤 높이가
   * 파일 `files` 개의 행 높이 이상 — 가상 스크롤 전후에 같은 조건), 폴더 접기·펼치기, 스크롤, 파일 클릭(미리보기 탭)
   */
  async function changedFiles({ n = 5, files } = {}) {
    const tree = '[data-panel="git-detail"] [role="tree"]';
    const fileRows = () => qa(`${tree} [data-kind="file"]`);
    const logRows = () => qa('[data-panel="git-log"] [data-oid]');
    const laidOut = () => (q(tree)?.scrollHeight ?? 0) >= files * 22;
    const out = {};
    out.select = await repeat(n, (i) => {
      const row = logRows()[1 + i];
      const oid = row.getAttribute('data-oid');
      return time(
        () => click(row),
        () => detailShows(oid) && laidOut(),
        60_000,
      );
    });
    out.rows = qa(`${tree} [role="treeitem"]`).length;
    out.dom = domCount('[data-panel="git-detail"]');
    const dir = () => qa(`${tree} [data-kind="dir"]`)[0];
    const close = [];
    const open = [];
    for (let i = 0; i < n; i += 1) {
      close.push(await time(() => click(dir())));
      open.push(await time(() => click(dir())));
    }
    out.dirCollapse = summarizeRuns(close);
    out.dirExpand = summarizeRuns(open);
    const scroller = scrollerOf(need(tree));
    out.scroll = scroller ? await scroll(scroller, { step: 22, frames: 120 }) : null;
    out.fileClick = await repeat(n, (i) => time(() => click(fileRows()[i * 3])));
    return out;
  }

  /** 프로젝트 트리의 그 이름 행 (이름 칸의 글자가 같은 것, 화면에 그려진 행 중에서) */
  const projectRow = (name) =>
    qa('[data-panel="project"] [role="treeitem"]').find((r) =>
      qa('span[title]', r).some((s) => s.textContent === name),
    );

  /**
   * 프로젝트 트리 (항목 수는 조절값 `dirEntries`, 기본 2,400): `logs/` 펼치기·접기, "더 보기"(전부 읽기), 스크롤,
   * ↑↓ 이동
   */
  async function projectTree({ n = 5 } = {}) {
    const treeEl = need('[data-panel="project"] [role="tree"]');
    const out = {};
    const expanded = () => projectRow('logs')?.getAttribute('aria-expanded') === 'true';
    const open = [];
    const close = [];
    for (let i = 0; i < n; i += 1) {
      open.push(
        await time(
          () => click(projectRow('logs')),
          () => expanded() && projectRow('archive'),
        ),
      );
      close.push(
        await time(
          () => click(projectRow('logs')),
          () => !expanded(),
        ),
      );
    }
    out.expand = summarizeRuns(open);
    out.collapse = summarizeRuns(close);
    click(projectRow('logs'));
    await waitFor(() => projectRow('archive'));
    // "더 보기" 행이 그려지도록 끝까지 내린다
    const scroller = treeEl;
    scroller.scrollTop = scroller.scrollHeight;
    const more = await waitFor(() => q('[data-panel="project"] [data-kind="more"]'));
    const before = scroller.scrollHeight;
    out.loadMore = await time(
      () => click(more),
      () =>
        !q('[data-panel="project"] [data-kind="more"]') || scroller.scrollHeight > before + 1000,
      60_000,
    );
    out.contentHeight = scroller.scrollHeight;
    scroller.scrollTop = 0;
    await afterPaint();
    out.scrollSlow = await scroll(scroller, { step: 22, frames: 120 });
    out.scrollFast = await scroll(scroller, { step: scroller.clientHeight, frames: 120 });
    scroller.scrollTop = 0;
    await waitFor(() => projectRow('logs'));
    click(projectRow('logs'));
    await afterPaint();
    treeEl.focus();
    out.arrowDown = await repeat(n * 2, () => time(() => key(treeEl, 'ArrowDown')));
    out.dom = domCount('[data-panel="project"]');
    return out;
  }

  /**
   * Commit 도구 창 (변경 수는 조절값 `worktreeChanges`): 표시(Project → Commit), 체크 하나(stage → 다시 읽기까지),
   * 저장소 접기·펼치기, 스크롤
   */
  async function commitTree({ n = 5, repo = 'web-console' } = {}) {
    const stripe = need('[role="toolbar"][aria-label="도구 창"]');
    const tree = '[data-panel="commit"] [role="tree"]';
    const out = {};
    const shows = [];
    for (let i = 0; i < n; i += 1) {
      click(buttonNamed('Project', stripe));
      await waitFor(() => q('[data-panel="project"] [role="tree"]'));
      await afterPaint();
      shows.push(
        await time(
          () => click(buttonNamed('Commit', stripe)),
          () => qa(`${tree} [role="treeitem"]`).length > 10,
        ),
      );
    }
    out.show = summarizeRuns(shows);
    const busy = () => q(`${tree} [aria-busy="true"]`);
    const checkable = () =>
      qa(`${tree} [data-kind="file"]`).find(
        (r) => !q('[data-check][data-disabled]', r) && r.getAttribute('aria-checked') !== 'mixed',
      );
    const checks = [];
    const settled = [];
    for (let i = 0; i < n; i += 1) {
      const row = checkable();
      const box = need('[data-check]', row);
      const t0 = performance.now();
      checks.push(await time(() => click(box)));
      await waitFor(() => !busy());
      await afterPaint();
      settled.push(round(performance.now() - t0));
    }
    out.check = summarizeRuns(checks);
    out.checkSettled = stats(settled);
    const repoRow = () =>
      qa(`${tree} [data-kind="repo"]`).find((r) => r.textContent.includes(repo));
    const close = [];
    const open = [];
    for (let i = 0; i < n; i += 1) {
      close.push(await time(() => click(repoRow())));
      open.push(await time(() => click(repoRow())));
    }
    out.repoCollapse = summarizeRuns(close);
    out.repoExpand = summarizeRuns(open);
    const scroller = need(tree);
    out.scrollSlow = await scroll(scroller, { step: 22, frames: 120 });
    out.scrollFast = await scroll(scroller, { step: scroller.clientHeight, frames: 120 });
    out.dom = domCount('[data-panel="commit"]');
    click(buttonNamed('Project', stripe));
    await afterPaint();
    return out;
  }

  /**
   * 필터 드롭다운 하나 (`name` = 저장소·branch·작성자): 열기(항목이 그려질 때까지), 검색 한 글자·지우기, 체크·해제, 닫기
   */
  async function filterDropdown(name, { n = 5, char = 'e' } = {}) {
    const button = () =>
      qa('[data-filter-bar] button[aria-haspopup="dialog"]').find((b) =>
        b.textContent.trim().startsWith(name),
      );
    const input = () => q(`input[aria-label="${name} 검색"]`);
    const options = () => qa('[role="listbox"] [role="option"]');
    const opens = [];
    const types = [];
    const clears = [];
    const checks = [];
    const closes = [];
    let shown = 0;
    let dom = 0;
    for (let i = 0; i < n; i += 1) {
      opens.push(
        await time(
          () => click(button()),
          () => input() && options().length > 0,
          30_000,
        ),
      );
      shown = options().length;
      dom = domCount('[role="listbox"]');
      types.push(await time(() => type(input(), char)));
      clears.push(await time(() => type(input(), '')));
      checks.push(await time(() => click(options()[1])));
      checks.push(await time(() => click(options()[1])));
      closes.push(
        await time(
          () => key(input(), 'Escape'),
          () => !input(),
        ),
      );
    }
    return {
      options: shown,
      dom,
      open: summarizeRuns(opens),
      searchChar: summarizeRuns(types),
      searchClear: summarizeRuns(clears),
      check: summarizeRuns(checks),
      close: summarizeRuns(closes),
    };
  }

  /** 그래프 뷰의 마지막으로 그린 행 번호 */
  const lastRow = (scroller) =>
    Math.max(-1, ...qa('[data-row]', scroller).map((r) => Number(r.getAttribute('data-row'))));
  /** 그래프 뷰에 자리 표시(아직 못 읽은) 행이 없는지 */
  const graphSettled = (scroller) =>
    !q('[aria-busy="true"]', scroller) && q('[data-oid]', scroller);

  /**
   * 그래프 뷰 (폴더 로그·저장소 탭 공용, `panel` 은 그 영역): 스크롤(천천히 24px/프레임·빠르게 한 화면/프레임), 끝으로
   * 건너뛰기·맨 위로(행 `rows` 개), 행 선택 → 상세(`detailOf(oid)` 가 참이 될 때까지)
   */
  async function graph({ panel, rows, detailOf, n = 5 } = {}) {
    const scroller = need(`[data-panel="${panel}"] [data-testid="graph-scroller"]`);
    const busy = '[aria-busy="true"]';
    const out = { dom: domCount(`[data-panel="${panel}"]`) };
    scroller.scrollTop = 0;
    await waitFor(() => graphSettled(scroller));
    out.scrollSlow = await scroll(scroller, { step: 24, frames: 240, busy });
    out.scrollFast = await scroll(scroller, { step: scroller.clientHeight, frames: 120, busy });
    const toEnd = [];
    const toTop = [];
    for (let i = 0; i < n; i += 1) {
      toEnd.push(
        await time(
          () => {
            scroller.scrollTop = scroller.scrollHeight;
          },
          () => lastRow(scroller) >= rows - 1 && graphSettled(scroller),
        ),
      );
      toTop.push(
        await time(
          () => {
            scroller.scrollTop = 0;
          },
          () => q('[data-row="0"][data-oid]', scroller) && graphSettled(scroller),
        ),
      );
    }
    out.jumpEnd = summarizeRuns(toEnd);
    out.jumpTop = summarizeRuns(toTop);
    out.select = await repeat(n, (i) => {
      const row = qa('[data-oid]', scroller)[2 + i];
      const oid = row.getAttribute('data-oid');
      return time(
        () => click(row),
        () => detailOf(oid),
      );
    });
    return out;
  }

  /** 폴더 로그 (통합 타임라인, 행 수는 `VITE_MGIT_MOCK`) */
  const timeline = ({ rows, n = 5 } = {}) =>
    graph({ panel: 'git-log', rows, detailOf: detailShows, n });

  /**
   * 저장소 탭: 그래프 스크롤·건너뛰기·커밋 선택 → 상세. 상세 칸에 해시 앞 7자가 보일 때까지. 기본 영역은 새 셸(W21 —
   * Git 도구 창 로그 탭의 `git-log`·`git-detail`, W29 에서 기본값을 바꿨다). 옛 틀(W18 ②)은 `center`·`detail` 을 준다
   */
  const repoGraph = ({ rows, n = 5, panel = 'git-log', detail = 'git-detail' } = {}) =>
    graph({
      panel,
      rows,
      n,
      detailOf: (oid) =>
        (q(`[data-panel="${detail}"]`)?.textContent ?? '').includes(oid.slice(0, 7)),
    });

  /**
   * 툴바 탭 막대에서 경로가 `path` 인 탭이 활성인지. W29 의 틀은 탭 감싸개의 CSS 모듈 클래스 이름에 `tabActive` 가 들고,
   * 지금 틀(`[role="tablist"]` 의 단추, 2026-11-27 확인)은 `aria-selected`
   */
  const tabActive = (path) => {
    const tab = sessionTab(path);
    if (!tab) return false;
    if (tab.hasAttribute('aria-selected')) return tab.getAttribute('aria-selected') === 'true';
    return (tab.parentElement?.className ?? '').includes('tabActive');
  };

  /**
   * 지금 로그 칸의 첫 그래프 행을 잡아 두고, 그 행이 DOM 에서 빠졌는지 묻는 함수를 준다. W21 뒤 폴더·저장소 탭이 같은
   * `git-log` 영역을 써서 "로그 칸에 그래프 행이 있다"는 바꾸기 전 화면에서도 참이다. 탭을 바꾸면 그래프 뷰가 새로
   * 붙으므로(폴더 ↔ 저장소는 컴포넌트가, 저장소 ↔ 저장소는 `GraphView` 의 key 가 바뀐다) 옛 행은 떨어져 나간다 (W29)
   */
  function leaving() {
    const row = q('[data-panel="git-log"] [data-testid="graph-scroller"] [data-oid]');
    return () => row === null || !row.isConnected;
  }

  /**
   * 탭 `path` 로 바뀐 끝 (W29): 바꾸기 전 로그 행이 빠졌고, 그 탭이 활성이고, `ready()` 가 참. 동작을 보내기 **전에**
   * 만든다(옛 행을 그때 잡는다). `strict: false` 면 W18 ② 의 조건(`ready()` 만)
   */
  function switchedTo(path, ready, { strict = true } = {}) {
    if (!strict) {
      return ready;
    }
    const left = leaving();
    return () => left() && tabActive(path) && ready();
  }

  /**
   * 탭 전환 (명세 4.1 의 100ms): 툴바 탭 막대에서 `title`(경로)이 `path` 인 탭을 누르고 끝 조건이 참이 되어 그려질
   * 때까지. `back` 탭과 번갈아 `n` 번씩 잰다. 끝 조건은 `switchedTo`(W29), `strict: false` 면 W18 ② 처럼 `ready()` 만
   */
  async function tabSwitch({ to, toReady, back, backReady, n = 5, strict = true }) {
    const tab = (path) => {
      const el = sessionTab(path);
      if (!el) throw new Error(`탭 없음: ${path}`);
      return el;
    };
    const go = [];
    const ret = [];
    for (let i = 0; i < n; i += 1) {
      go.push(await time(() => click(tab(to)), switchedTo(to, toReady, { strict })));
      await pause(100);
      ret.push(await time(() => click(tab(back)), switchedTo(back, backReady, { strict })));
      await pause(100);
    }
    return { to: summarizeRuns(go), back: summarizeRuns(ret) };
  }

  /** 저장소 탭이 그래프 행을 그렸는지 (새 셸: Git 도구 창 로그 탭의 `git-log`. 옛 틀은 `'center'`) */
  const repoTabReady =
    (panel = 'git-log') =>
    () =>
      q(`[data-panel="${panel}"] [data-testid="graph-scroller"] [data-oid]`);
  /** 폴더 탭이 그려졌는지 (프로젝트 트리 행과 로그 행) */
  const folderTabReady = () =>
    q('[data-panel="project"] [role="treeitem"]') &&
    q('[data-panel="git-log"] [data-testid="graph-scroller"] [data-oid]');
  /**
   * 툴바 탭 막대에서 경로가 `path` 인 탭. W29 의 틀은 `nav[aria-label="repositories"]` 의 `title` 이 경로, 지금 틀은
   * `[role="tablist"]` 단추의 `title` 이 "폴더: <경로>"·"Git 저장소: <경로>" 꼴이다 (2026-11-27 확인)
   */
  function sessionTab(path) {
    return (
      q(`nav[aria-label="repositories"] button[title="${path}"]`) ??
      qa('[role="tablist"] button[title]').find((b) =>
        (b.getAttribute('title') ?? '').endsWith(`: ${path}`),
      ) ??
      null
    );
  }

  /**
   * 폴더 탭에서 저장소 탭 열기 (첫 표시): 프로젝트 트리의 저장소 행 우클릭 → "저장소 탭으로 열기" 를 눌러 저장소 탭의
   * 첫 그래프 행이 그려질 때까지(`switchedTo` — 폴더 로그 행이 빠지고 새 탭이 활성). `n` 번 재며 매번 그 탭을 닫고
   * 폴더 탭으로 돌아온다 (매번 새 세션). 옛 틀은 `{ panel: 'center', strict: false }`
   */
  async function openRepoTab({ name, path, n = 5, panel = 'git-log', strict = true } = {}) {
    const runs = [];
    for (let i = 0; i < n; i += 1) {
      const row = projectRow(name);
      const box = row.getBoundingClientRect();
      row.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: box.x + 20,
          clientY: box.y + 5,
        }),
      );
      const item = await waitFor(() =>
        qa('[role="menuitem"]').find((m) => m.textContent.trim() === '저장소 탭으로 열기'),
      );
      await afterPaint();
      runs.push(
        await time(() => click(item), switchedTo(path, repoTabReady(panel), { strict }), 60_000),
      );
      if (i < n - 1) {
        const tab = sessionTab(path)?.parentElement;
        click(need('button[aria-label="저장소 닫기"]', tab));
        await waitFor(() => !sessionTab(path) && folderTabReady(), 60_000);
        await pause(300);
      }
    }
    return summarizeRuns(runs);
  }

  /**
   * 저장소 장면에서 두 번째 저장소 열기 (툴바 "저장소 열기" — 목은 `path` 를 연다): 새 탭의 첫 그래프 행이 그려질 때까지
   * (`switchedTo`). 한 번만 잰다 (같은 저장소를 다시 열면 그 탭으로 갈 뿐이다)
   */
  async function openRepo({ path = '/mock/repo-100000', strict = true } = {}) {
    const open = qa('button').find((b) => b.textContent.trim() === '저장소 열기');
    if (!open) {
      throw new Error('"저장소 열기" 단추 없음');
    }
    return time(() => click(open), switchedTo(path, repoTabReady(), { strict }), 60_000);
  }

  /** 왼쪽 도구 창 띠의 단추 (Project·Commit·Pull Requests) */
  const stripeButton = (name) => buttonNamed(name, need('[role="toolbar"][aria-label="도구 창"]'));

  /**
   * 저장소 탭의 왼쪽 도구 창 (W21~W24 의 새 영역, W29 첫 기록): PR 첫 열기(PR 목록의 첫 읽기 포함 — 프로젝트당 한 번이라
   * 새로 읽은 페이지에서 처음 부를 때만 뜻이 있다), 그 뒤 `n` 번씩 Project → Commit(변경 목록이 그려질 때까지), 변경 →
   * Stash 탭(목록 행), Stash → 변경 탭, Commit → Project(트리 행), Project → Pull Requests(목록 행, 다시 열기)
   */
  async function repoLeftTools({ n = 5 } = {}) {
    const commit = '[data-panel="commit"]';
    const changesShown = () => qa(`${commit} [role="tabpanel"] ul li`).length > 3;
    const stashShown = () => qa(`${commit} [role="listbox"] [role="option"]`).length > 0;
    const projectShown = () => q('[data-panel="project"] [role="treeitem"]');
    const prShown = () => qa('[data-panel="pull-requests"] [role="option"]').length > 0;
    const commitTab = (name) =>
      qa(`${commit} [role="tab"]`).find((t) => t.textContent.trim().startsWith(name));
    const toProject = async () => {
      if (!projectShown()) {
        click(stripeButton('Project'));
        await waitFor(projectShown);
        await afterPaint();
      }
    };
    const out = {};
    await toProject();
    out.prFirst = await time(() => click(stripeButton('Pull Requests')), prShown, 30_000);
    const commitOpen = [];
    const toStash = [];
    const toChanges = [];
    const projectOpen = [];
    const prOpen = [];
    for (let i = 0; i < n; i += 1) {
      await toProject();
      commitOpen.push(await time(() => click(stripeButton('Commit')), changesShown));
      toStash.push(await time(() => click(commitTab('Stash')), stashShown));
      toChanges.push(await time(() => click(commitTab('변경')), changesShown));
      projectOpen.push(await time(() => click(stripeButton('Project')), projectShown));
      prOpen.push(await time(() => click(stripeButton('Pull Requests')), prShown));
    }
    await toProject();
    out.commitOpen = summarizeRuns(commitOpen);
    out.stashTab = summarizeRuns(toStash);
    out.changesTab = summarizeRuns(toChanges);
    out.projectOpen = summarizeRuns(projectOpen);
    out.prOpen = summarizeRuns(prOpen);
    return out;
  }

  /**
   * 로그 필터 바의 텍스트 필터 (W26 — 저장소 탭, 폴더 탭도 같은 바): 텍스트 칸에 `text` 를 넣고 Enter → 걸러진 행이
   * 그려질 때까지(보이는 그래프 행이 모두 그 글자를 담고 자리 표시 행이 없다), × "검색어 지우기" → 걸러지지 않은
   * 행(그 글자가 없는 행)이 다시 보일 때까지. 동작마다 그래프 스크롤 요소가 새로 붙은 수(`GraphView` 다시 마운트 —
   * 저장소 탭은 목록 모드로 바뀔 때 1~2회)를 끝 뒤 `settle` ms 동안까지 센다
   */
  async function logTextFilter({ text = 'fix:', panel = 'git-log', n = 5, settle = 300 } = {}) {
    const root = need(`[data-panel="${panel}"]`);
    const scroller = () => q('[data-testid="graph-scroller"]', root);
    const input = () => need('[data-filter-bar] input[data-filter-text]', root);
    const needle = text.toLowerCase();
    const shownRows = () => qa('[data-oid]', scroller() ?? root);
    const settled = () => scroller() && !q('[aria-busy="true"]', scroller());
    const filtered = () =>
      settled() &&
      shownRows().length > 0 &&
      shownRows().every((r) => r.textContent.toLowerCase().includes(needle));
    const cleared = () =>
      settled() && shownRows().some((r) => !r.textContent.toLowerCase().includes(needle));
    /** 동작 하나: 시간과 그 사이 그래프 스크롤 요소가 새로 붙은 수·시각(동작부터 ms — 끝 조건보다 늦게 붙으면 보인다) */
    const measure = async (action, until) => {
      const mountsAt = [];
      const t0 = performance.now();
      const observer = new MutationObserver((records) => {
        for (const rec of records) {
          for (const node of rec.addedNodes) {
            if (
              node.nodeType === 1 &&
              (node.matches('[data-testid="graph-scroller"]') ||
                node.querySelector('[data-testid="graph-scroller"]'))
            ) {
              mountsAt.push(round(performance.now() - t0));
            }
          }
        }
      });
      observer.observe(root, { childList: true, subtree: true });
      const r = await time(action, until, 60_000);
      await pause(settle);
      observer.disconnect();
      return { ...r, mounts: mountsAt.length, mountsAt };
    };
    const apply = [];
    const clear = [];
    for (let i = 0; i < n; i += 1) {
      apply.push(
        await measure(() => {
          type(input(), text);
          key(input(), 'Enter');
        }, filtered),
      );
      clear.push(
        await measure(
          () => click(need(`[data-filter-bar] button[aria-label="검색어 지우기"]`, root)),
          cleared,
        ),
      );
    }
    const mounts = (runs) => runs.map((r) => r.mountsAt);
    return {
      apply: { ...summarizeRuns(apply), mounts: mounts(apply) },
      clear: { ...summarizeRuns(clear), mounts: mounts(clear) },
    };
  }

  /** 영역별 크기 (`data-panel` 이름 → 폭·높이 px, 분할 패널의 `true` 는 뺀다) — 작업 진행 띠가 본문을 줄이는 몫 등 */
  function regionSizes() {
    const out = {};
    for (const el of qa('[data-panel]:not([data-panel="true"])')) {
      const box = el.getBoundingClientRect();
      out[el.getAttribute('data-panel')] = { w: round(box.width), h: round(box.height) };
    }
    return out;
  }

  /**
   * 파일 보기 (크기는 조절값 `bigFileKiB`): 프로젝트 트리의 `samples/` 를 펼치고 파일을 눌러 줄이 그려질 때까지, 스크롤
   */
  async function fileView({ name, n = 5 } = {}) {
    const out = {};
    if (projectRow('samples')?.getAttribute('aria-expanded') !== 'true') {
      click(projectRow('samples'));
      await waitFor(() => projectRow(name));
    }
    const text = '[data-panel="editor"] [data-testid="file-text"]';
    const lines = () => q(text)?.firstElementChild?.childElementCount ?? 0;
    const opens = [];
    for (let i = 0; i < n; i += 1) {
      // 미리보기 탭을 닫고 다시 연다 (같은 문서면 다시 읽지 않으므로)
      const close = buttonNamed(`${name} 닫기`);
      if (close) {
        click(close);
        await waitFor(() => !buttonNamed(`${name} 닫기`));
        await afterPaint();
      }
      opens.push(
        await time(
          () => click(projectRow(name)),
          () => lines() > 10,
          30_000,
        ),
      );
    }
    out.open = summarizeRuns(opens);
    out.dom = domCount('[data-panel="editor"]');
    const scroller = q(text);
    out.scrollSlow = scroller ? await scroll(scroller, { step: 20, frames: 120 }) : null;
    out.scrollFast = scroller
      ? await scroll(scroller, { step: scroller.clientHeight, frames: 120 })
      : null;
    return out;
  }

  // ── 반응성 기준선 (2026-11-27, 계획 `plan/perf-responsiveness.md` M3) ─────────────────────────────────────
  // IPC 수는 앱의 성능 기록기(M1, 목 빌드에서는 메모리 모드 `window.__mgitPerf`)의 `ipc` 줄로 센다 — 목 메서드 하나가 한 줄이다.
  // 편집기 저장소 알림 수는 같은 기록기의 `stores` 줄(`fileEditors`)이다. 화면 문구로 요소를 찾으므로 `mgit.language = 'ko'` 로 잰다.

  /**
   * 구간의 IPC·저장소 알림·코어 이벤트를 센다: 만들 때 기록기의 메모리를 비우고, `stop()` 이 구간을 닫아 명령별 수(`ipc`),
   * 합계(`total`), 순서(`order` — 구간 시작부터 ms·이름·소요 ms), 저장소 알림(`stores`), 이벤트(`events`)를 준다. 기록기가
   * 없으면(`mgit.perf = '0'`) 목 계수기 `__mgitMockCalls`(일부 메서드만)의 차이를 `ipc` 로 준다
   */
  function ipcWindow() {
    const P = window.__mgitPerf;
    const mock0 = { ...(globalThis.__mgitMockCalls ?? {}) };
    P?.clear();
    const t0 = performance.now();
    return {
      stop() {
        if (!P) {
          const ipc = {};
          for (const [name, n] of Object.entries(globalThis.__mgitMockCalls ?? {})) {
            if (n - (mock0[name] ?? 0) > 0) ipc[name] = n - (mock0[name] ?? 0);
          }
          return {
            source: '__mgitMockCalls',
            ipc,
            total: Object.values(ipc).reduce((s, n) => s + n, 0),
          };
        }
        P.cut();
        const entries = P.entries();
        const ipc = {};
        const stores = {};
        const events = {};
        const order = [];
        for (const e of [...entries].sort((a, b) => a.t - b.t)) {
          if (e.kind === 'ipc') {
            ipc[e.name] = (ipc[e.name] ?? 0) + 1;
            order.push([round(e.t - t0), e.name, e.ms]);
          } else if (e.kind === 'stores' || e.kind === 'events') {
            const into = e.kind === 'stores' ? stores : events;
            for (const [key, n] of Object.entries(e.counts)) into[key] = (into[key] ?? 0) + n;
          }
        }
        return { source: '__mgitPerf', ipc, total: order.length, order, stores, events };
      },
    };
  }

  /**
   * canvas 글자 폭 측정 호출 수: `measureText`(글자 하나하나)와 `getContext`(트리 폭 계산 효과가 한 번 돌 때마다 캔버스를
   * 하나 만든다)를 원형에서 감싸 센다. 어느 트리의 것인지는 캔버스마다 처음 잰 글자(그 트리의 첫 행)로 묶는다(`byTree`:
   * 표본 → 측정 수·캔버스 수). `stop()` 이 되돌리고 수를 준다
   */
  function canvasCounter() {
    const protos = [
      globalThis.CanvasRenderingContext2D?.prototype,
      globalThis.OffscreenCanvasRenderingContext2D?.prototype,
    ].filter(Boolean);
    const canvas = globalThis.HTMLCanvasElement?.prototype;
    const savedMeasure = protos.map((p) => p.measureText);
    const savedContext = canvas?.getContext;
    const out = { measureText: 0, getContext: 0 };
    const perCanvas = new Map();
    protos.forEach((p, i) => {
      p.measureText = function (...args) {
        out.measureText += 1;
        const at = perCanvas.get(this) ?? { n: 0, sample: String(args[0]).slice(0, 40) };
        at.n += 1;
        perCanvas.set(this, at);
        return savedMeasure[i].apply(this, args);
      };
    });
    if (canvas) {
      canvas.getContext = function (...args) {
        out.getContext += 1;
        return savedContext.apply(this, args);
      };
    }
    return {
      stop() {
        protos.forEach((p, i) => {
          p.measureText = savedMeasure[i];
        });
        if (canvas) canvas.getContext = savedContext;
        // 같은 트리는 효과가 돌 때마다 새 캔버스를 쓰지만 처음 재는 글자(첫 행)가 같다 — 표본으로 묶는다
        const byTree = {};
        for (const { n, sample } of perCanvas.values()) {
          byTree[sample] ??= { measureText: 0, canvases: 0 };
          byTree[sample].measureText += n;
          byTree[sample].canvases += 1;
        }
        return { ...out, byTree };
      },
    };
  }

  /**
   * 동작 하나의 비용: 시간(`time()`), IPC(`ipcWindow`), canvas 측정 수, (렌더 계수기를 걸었으면) 영역별 렌더. `settle` ms 를 더
   * 기다려 동작 뒤에 따라붙는 호출까지 센다 (시간은 끝 조건까지만)
   */
  async function cost(action, { until, timeout, settle = 0 } = {}) {
    const w = ipcWindow();
    const c = canvasCounter();
    if (renders.installed) renders.start();
    const timing = await time(action, until, timeout);
    if (settle > 0) await pause(settle);
    await afterPaint();
    const out = { ...timing, ...c.stop(), ipc: w.stop() };
    if (renders.installed) out.renders = renders.stop();
    return out;
  }

  /** 렌더 결과를 영역 → 컴포넌트 수로 줄인다 (표에 적기 좋게) */
  const regionComponents = (r) =>
    r
      ? Object.fromEntries(
          Object.entries(r.regions)
            .map(([k, v]) => [k, v.components])
            .filter(([, n]) => n > 0)
            .sort((a, b) => b[1] - a[1]),
        )
      : null;

  /**
   * 프로젝트 트리에서 폴더 기준 상대 경로가 그것인 행 (화면에 그려진 행 중에서). 이름 칸 `span[title]` 의 첫 줄이 경로다(둘째
   * 줄부터는 "안에 변경된 파일이 있습니다." 같은 안내)
   */
  const projectPath = (path) =>
    qa('[data-panel="project"] [role="treeitem"]').find((r) =>
      qa('span[title]', r).some((s) => (s.getAttribute('title') ?? '').split('\n')[0] === path),
    );

  /** 경로의 조상 디렉터리(첫 칸은 저장소 행)를 차례로 펼쳐 그 파일 행이 보이게 한다 */
  async function revealProjectFile(path) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length && !projectPath(path); i += 1) {
      const dir = parts.slice(0, i).join('/');
      const row = await waitFor(() => (i === 1 ? projectRow(dir) : projectPath(dir)));
      if (row.getAttribute('aria-expanded') !== 'true') click(row);
      await waitFor(() => {
        const at = i === 1 ? projectRow(dir) : projectPath(dir);
        return at?.getAttribute('aria-expanded') === 'true';
      });
      await afterPaint();
    }
    const row = await waitFor(() => projectPath(path));
    row.scrollIntoView({ block: 'center' });
    await afterPaint();
    return projectPath(path);
  }

  /** 편집기 본문 (CodeMirror 의 편집 가능한 요소) */
  const editorContent = () => q('[data-panel="editor"] [data-testid="file-editor"] .cm-content');

  /** 프로젝트 트리에서 파일을 눌러 편집기로 연다. 열린 뒤 `settle` ms(첫 주기 검사·주석 조회가 지나가도록) 기다린다 */
  async function openEditorFile(path, { settle = 2500 } = {}) {
    click(await revealProjectFile(path));
    await waitFor(editorContent, 30_000);
    await pause(settle);
    return editorContent();
  }

  /** 편집기에 글자를 넣는다 (포커스한 편집 영역에 `insertText` — 실제 입력처럼 beforeinput·input 을 거친다) */
  function insertText(text) {
    const content = editorContent();
    content.focus();
    document.execCommand('insertText', false, text);
  }

  /** 행의 우클릭 메뉴를 열어 그 글자의 항목을 준다 */
  async function contextItem(row, label) {
    const box = row.getBoundingClientRect();
    row.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: box.x + 20,
        clientY: box.y + 5,
      }),
    );
    const item = await waitFor(() =>
      qa('[role="menuitem"]').find((m) => m.textContent.trim().startsWith(label)),
    );
    await afterPaint();
    return item;
  }

  /**
   * 비교 화면(편집기 고정 탭)의 뿌리. 머리의 기준 칸이 옛 입력칸(`input[aria-label="기준 (A)"]`)이거나 ref 선택 칸(F4 — 접근성
   * 이름이 "기준 (A): …" 인 단추)이다
   */
  const comparisonRoot = () =>
    (
      q('input[aria-label="기준 (A)"]') ??
      qa('button[aria-haspopup="dialog"]').find((b) =>
        (b.getAttribute('aria-label') ?? '').startsWith('기준 (A):'),
      )
    )?.closest('section') ?? null;
  /** 요소 아래에 그 글자가 화면에 보이게 있는지 (접힌 `<details>` 안처럼 그려지지 않은 글자는 뺀다) */
  function visibleText(root, text) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      // 접힌 <details> 의 내용은 Chromium 에서 사각형은 있지만 보이지 않는다 — checkVisibility 로 가린다
      if (
        node.nodeValue.includes(text) &&
        el?.getClientRects().length &&
        (el.checkVisibility?.({ contentVisibilityAuto: true }) ?? true)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * 비교 화면에 파일 목록과 diff 칸이 그려졌는지: 파일 트리 행이 있고, diff 칸(`diff-scroller`)이 붙었고, 보이는
   * "불러오는 중…" 이 없다 (diff 칸의 행은 가상 스크롤이라 칸이 낮으면 그려지지 않을 수 있어 보지 않는다)
   */
  const comparisonShown = () => {
    const root = comparisonRoot();
    return (
      root &&
      q('[role="tree"] [role="treeitem"]', root) &&
      q('[data-testid="diff-scroller"]', root) &&
      !visibleText(root, '불러오는 중…')
    );
  };

  /**
   * 요소 아래의 DOM 변화를 센다: `busy()` 가 거짓 → 참으로 바뀐 횟수(로딩 표시가 켜진 횟수)와 변화 기록 수(노드 추가·삭제,
   * 속성 이름별 변경, 글자 변경 `#text` — 다시 그려 깜빡였는지). `stop()` 이 수를 준다
   */
  function domWatch(root, busy) {
    let was = Boolean(busy());
    const out = { loadingShown: 0, mutations: 0, addedNodes: 0, removedNodes: 0, attributes: {} };
    const observer = new MutationObserver((records) => {
      out.mutations += records.length;
      for (const rec of records) {
        out.addedNodes += rec.addedNodes.length;
        out.removedNodes += rec.removedNodes.length;
        if (rec.type === 'attributes')
          out.attributes[rec.attributeName] = (out.attributes[rec.attributeName] ?? 0) + 1;
        else if (rec.type === 'characterData')
          out.attributes['#text'] = (out.attributes['#text'] ?? 0) + 1;
      }
      const now = Boolean(busy());
      if (now && !was) out.loadingShown += 1;
      was = now;
    });
    observer.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    return {
      stop() {
        observer.disconnect();
        return { ...out };
      },
    };
  }

  /** 구간 동안 아무것도 하지 않고 기다린다 (IPC·canvas·렌더·DOM 변화를 센다) */
  async function idle(ms, { watchRoot, busy } = {}) {
    const dom = watchRoot ? domWatch(watchRoot, busy ?? (() => false)) : null;
    const out = await cost(() => pause(ms));
    if (dom) out.dom = dom.stop();
    delete out.longTasks;
    delete out.longest;
    return out;
  }

  /** Project 트리의 최상위 디렉터리들을 펼친다 (이미 펼쳤으면 그대로). 펼친 뒤 0.5초 쉰다 */
  async function expandProjectDirs(dirs) {
    for (const dir of dirs) {
      const row = projectRow(dir);
      if (row && row.getAttribute('aria-expanded') !== 'true') {
        click(row);
        await waitFor(() => projectRow(dir)?.getAttribute('aria-expanded') === 'true');
        await afterPaint();
      }
    }
    if (dirs.length > 0) await pause(500);
  }

  /**
   * 편집기에 파일 하나를 연 채 `wait` ms 대기 (R1: 2초 주기 검사가 전역 버전을 올려 다시 그리는지). `expand` 의 최상위
   * 디렉터리를 먼저 펼친다
   */
  async function editorIdle({ file = 'api-gateway/README.md', wait = 6000, expand = [] } = {}) {
    await expandProjectDirs(expand);
    await openEditorFile(file);
    const out = await idle(wait);
    out.renderRegions = regionComponents(out.renders);
    return out;
  }

  /**
   * 편집기에 글자 하나씩 `n` 번 (R1·R4): 입력 → 다음 그리기, 입력마다 영역별 렌더·canvas 측정·IPC. 입력 사이에 `gap` ms
   * 쉰다 (자동 저장은 마지막 입력 1초 뒤라 구간에 들지 않는다). `expand` 의 최상위 디렉터리를 먼저 펼친다(Project 트리 행 늘리기)
   */
  async function editorType({
    file = 'api-gateway/README.md',
    n = 10,
    char = 'x',
    gap = 100,
    expand = [],
  } = {}) {
    await expandProjectDirs(expand);
    await openEditorFile(file);
    const runs = [];
    for (let i = 0; i < n; i += 1) {
      runs.push(await cost(() => insertText(char)));
      await pause(gap);
    }
    const sum = (pick) => runs.reduce((s, r) => s + pick(r), 0);
    const regions = {};
    for (const r of runs) {
      for (const [k, v] of Object.entries(regionComponents(r.renders) ?? {})) {
        regions[k] = (regions[k] ?? 0) + v;
      }
    }
    const ipc = {};
    for (const r of runs) {
      for (const [k, v] of Object.entries(r.ipc.ipc)) ipc[k] = (ipc[k] ?? 0) + v;
    }
    return {
      ...summarizeRuns(runs),
      measureTextPerInput: stats(runs.map((r) => r.measureText)),
      getContextPerInput: stats(runs.map((r) => r.getContext)),
      byTreeLast: runs.at(-1)?.byTree,
      commitsPerInput: renders.installed ? stats(runs.map((r) => r.renders.commits)) : null,
      renderRegionsTotal: renders.installed ? regions : null,
      ipcTotal: ipc,
      ipcPerInput: stats(runs.map((r) => r.ipc.total ?? 0)),
      measureTextTotal: sum((r) => r.measureText),
    };
  }

  /**
   * 글자 하나 입력 → 자동 저장이 끝날 때까지 (R6): 저장(`fsSaveFile`) 뒤 `quiet` ms 동안 새 IPC 가 없으면 끝. 저장 한 번에
   * 따라붙는 IPC 수·종류·순서, 렌더, canvas 측정
   */
  async function editorSave({ file = 'api-gateway/README.md', char = 'x', quiet = 800 } = {}) {
    await openEditorFile(file);
    const P = window.__mgitPerf;
    if (!P) throw new Error('성능 기록기(__mgitPerf)가 없다 — mgit.perf 를 지웠는지 본다');
    const lastIpc = () =>
      P.entries().reduce((t, e) => (e.kind === 'ipc' ? Math.max(t, e.t + e.ms) : t), 0);
    const saved = () => P.entries().some((e) => e.kind === 'ipc' && e.name === 'fsSaveFile');
    const t0 = performance.now();
    const out = await cost(() => insertText(char), {
      until: () => saved() && performance.now() - Math.max(lastIpc(), t0) > quiet,
      timeout: 15_000,
    });
    out.untilQuietMs = out.ms;
    out.renderRegions = regionComponents(out.renders);
    return out;
  }

  /**
   * 파일의 "다른 브랜치/커밋과 이 파일 비교"(HEAD ↔ 로컬 내용)로 비교 창을 연 채 `wait` ms (R2). `withEditor` 면 먼저 그 파일을
   * 편집기에 연다(편집기 메뉴로 비교를 여는 실제 흐름 — 편집기 저장소의 주기 알림이 비교의 재조회 신호다). 열기 시간·IPC 와
   * 대기 구간의 IPC(`compareLocalFiles`·`compareLocalDocument`)·렌더·로딩 표시 횟수·DOM 변화. 기본 파일은 목 장면에서 작업
   * 트리 변경이 있는 파일이다. 목은 그 원문을 HEAD 와 같게 두므로 파일 하나만 비교하는 화면(F2 뒤)은 "차이 없음"이 된다 —
   * `edit` 면 먼저 한 글자 고쳐 자동 저장까지 기다려 내용 차이를 만든다(`withEditor` 가 아니면 그 뒤 편집기 탭을 닫는다)
   */
  async function compareLocalIdle({
    file = 'auth-service/src/main/resources/config/rate-limit.yaml',
    wait = 6000,
    withEditor = true,
    edit = false,
    settle = 2500,
  } = {}) {
    if (withEditor || edit) await openEditorFile(file);
    if (edit) {
      // 목은 작업 트리 변경의 원문을 HEAD 와 같게 두므로, 내용 차이를 만들려면 한 글자 고쳐 저장한다
      const t0 = performance.now();
      insertText('x');
      await waitSaved(t0);
      if (!withEditor) {
        const name = file.split('/').pop();
        click(need(`button[aria-label="${name} 닫기"]`));
        await waitFor(() => !editorContent());
        await afterPaint();
      }
    }
    if (!withEditor) await revealProjectFile(file);
    const item = await contextItem(projectPath(file), '다른 브랜치/커밋과 이 파일 비교');
    const open = await cost(() => click(item), { until: comparisonShown, timeout: 30_000 });
    await pause(settle);
    const root = comparisonRoot();
    const out = await idle(wait, {
      watchRoot: root,
      busy: () => visibleText(root, '불러오는 중…'),
    });
    out.renderRegions = regionComponents(out.renders);
    return {
      withEditor,
      edit,
      open: { ms: open.ms, longTasks: open.longTasks, ipc: open.ipc },
      idle: out,
    };
  }

  /**
   * 시각 `t0` 뒤 자동 저장(`fsSaveFile`)이 나가고 `quiet` ms 동안 새 IPC 가 없을 때까지 기다린다 (성능 기록기 필요)
   */
  async function waitSaved(t0, { quiet = 800, timeout = 15_000 } = {}) {
    const P = window.__mgitPerf;
    if (!P) throw new Error('성능 기록기(__mgitPerf)가 없다 — mgit.perf 를 지웠는지 본다');
    const ipc = () => P.entries().filter((e) => e.kind === 'ipc' && e.t >= t0 - 1);
    await waitFor(() => {
      const calls = ipc();
      if (!calls.some((e) => e.name === 'fsSaveFile')) return false;
      const last = calls.reduce((t, e) => Math.max(t, e.t + e.ms), 0);
      return performance.now() - last > quiet;
    }, timeout);
  }

  /**
   * 브랜치 ↔ 브랜치 비교 열기 (R7): 폴더 장면이면 프로젝트 트리의 저장소 행에서 저장소 탭을 열고, 브랜치 트리의 `branch` 잎
   * 우클릭 → "현재 브랜치와 … 비교…" → 파일 목록과 첫 diff 가 그려질 때까지. 시간, IPC 수·순서, 렌더
   */
  async function compareOpen({ repo = 'api-gateway', path, branch = 'main' } = {}) {
    const at = path ?? `/mock/acme-platform/${repo}`;
    if (!tabActive(at)) {
      if (!sessionTab(at)) {
        const item = await contextItem(projectRow(repo), '저장소 탭으로 열기');
        click(item);
      } else {
        click(sessionTab(at));
      }
      await waitFor(() => tabActive(at) && repoTabReady()(), 60_000);
      await waitFor(() => qa('[data-panel="git-branches"] [role="treeitem"]').length > 2);
      await pause(1500);
    }
    const leaves = qa('[data-panel="git-branches"] [role="treeitem"]').filter((r) =>
      (r.getAttribute('data-node-id') ?? '').startsWith('ref:refs/heads/'),
    );
    const leaf =
      (branch &&
        leaves.find((r) => r.getAttribute('data-node-id') === `ref:refs/heads/${branch}`)) ??
      leaves.find(
        (r) => !r.querySelector('[aria-label*="HEAD"]') && !r.textContent.includes('HEAD'),
      ) ??
      leaves[1];
    if (!leaf) throw new Error('비교할 로컬 브랜치 잎이 없다');
    const item = await contextItem(leaf, '현재 브랜치와');
    const label = item.textContent.trim();
    const out = await cost(() => click(item), {
      until: comparisonShown,
      timeout: 30_000,
      settle: 500,
    });
    out.menu = label;
    out.files = qa('[role="tree"] [role="treeitem"]', comparisonRoot()).length;
    out.renderRegions = regionComponents(out.renders);
    return out;
  }

  /**
   * Project 트리 폭 측정 (R4): `dirs` 를 펼쳐(기본 `logs` — 항목 `dirEntries`) 행을 늘린 뒤, 트리 밖 동작마다 canvas
   * 측정 수를 센다 — 로그 행 고르기 `n` 번, 창 포커스(전체 갱신) 한 번, (`file` 을 주면) 편집기 글자 하나. 행 수는 가상
   * 스크롤 높이 / 행 높이로 어림한다
   */
  async function projectTreeWidth({ n = 5, dirs = ['logs', 'api-gateway', 'docs'], file } = {}) {
    await expandProjectDirs(dirs);
    const tree = need('[data-panel="project"] [role="tree"]');
    const rowHeight =
      q('[data-panel="project"] [role="treeitem"]')?.getBoundingClientRect().height || 22;
    const out = { rows: Math.round(tree.scrollHeight / rowHeight), rowHeight: round(rowHeight) };
    const logRows = () => qa('[data-panel="git-log"] [data-oid]');
    const selects = [];
    for (let i = 0; i < n; i += 1) {
      const row = logRows()[2 + i];
      const oid = row.getAttribute('data-oid');
      selects.push(await cost(() => click(row), { until: () => detailShows(oid), settle: 300 }));
    }
    out.logSelect = {
      ...summarizeRuns(selects),
      measureText: stats(selects.map((r) => r.measureText)),
      getContext: stats(selects.map((r) => r.getContext)),
      byTreeLast: selects.at(-1)?.byTree,
      projectRenders: renders.installed
        ? stats(selects.map((r) => r.renders.regions.project?.components ?? 0))
        : null,
    };
    const focus = await cost(() => window.dispatchEvent(new Event('focus')), { settle: 1000 });
    out.windowFocus = {
      ms: focus.ms,
      measureText: focus.measureText,
      getContext: focus.getContext,
      byTree: focus.byTree,
      ipc: focus.ipc.ipc,
      renderRegions: regionComponents(focus.renders),
    };
    if (file) {
      await openEditorFile(file);
      const typed = await cost(() => insertText('x'));
      out.editorChar = {
        ms: typed.ms,
        measureText: typed.measureText,
        getContext: typed.getContext,
        byTree: typed.byTree,
        renderRegions: regionComponents(typed.renders),
      };
    }
    return out;
  }

  /**
   * Project 트리에서 ↓ 로 최상위 행을 옮기며 저장소 행을 지날 때 (범위 세션이 바뀐다): 루트에서 시작해 `n` 번, 키마다 시간·
   * 렌더·IPC·canvas 측정. 고른 행 이름을 함께 준다
   */
  async function projectRepoArrow({ n = 8, settle = 300 } = {}) {
    const tree = need('[data-panel="project"] [role="tree"]');
    tree.focus();
    key(tree, 'Home');
    await afterPaint();
    await pause(300);
    const selected = () =>
      q('[data-panel="project"] [role="treeitem"][aria-selected="true"] span[title]')
        ?.textContent ?? null;
    const runs = [];
    for (let i = 0; i < n; i += 1) {
      const r = await cost(() => key(tree, 'ArrowDown'), { settle });
      runs.push({
        to: selected(),
        ms: r.ms,
        longTasks: r.longTasks,
        measureText: r.measureText,
        ipc: r.ipc.total,
        ipcNames: r.ipc.ipc,
        renderRegions: regionComponents(r.renders),
      });
    }
    return runs;
  }

  /**
   * 상단 탭 전환 비용 (워크스페이스가 다시 붙는다): `to` ↔ `back` 을 `n` 번씩, 전환마다 시간·렌더·IPC·canvas 측정. 끝 조건은
   * `tabSwitch` 와 같은 `switchedTo`
   */
  async function tabSwitchCost({ to, toReady, back, backReady, n = 3, settle = 500 }) {
    const tab = (path) => {
      const el = sessionTab(path);
      if (!el) throw new Error(`탭 없음: ${path}`);
      return el;
    };
    const runs = { to: [], back: [] };
    for (let i = 0; i < n; i += 1) {
      for (const [dir, path, ready] of [
        ['to', to, toReady],
        ['back', back, backReady],
      ]) {
        const r = await cost(() => click(tab(path)), { until: switchedTo(path, ready), settle });
        runs[dir].push({
          ms: r.ms,
          longTasks: r.longTasks,
          measureText: r.measureText,
          ipc: r.ipc.ipc,
          renderRegions: regionComponents(r.renders),
        });
      }
    }
    return runs;
  }

  // ── 2라운드 재측정 (2026-11-27, G1·G2·G5) ─────────────────────────────────────────────────────────────

  /** 왼쪽 띠의 도구 창 단추 (접근성 이름이 그것인 첫 단추 — 프로젝트·커밋·Git·터미널) */
  const toolButton = (name) =>
    qa('button').find(
      (b) => b.getAttribute('aria-label') === name && b.getBoundingClientRect().left < 40,
    );

  /** 아래 Git 도구 창 닫기·열기 (`n` 번): 띠의 Git 단추로 토글하며 각각 시간·렌더·IPC */
  async function dockToggle({ n = 3, settle = 300 } = {}) {
    const runs = { close: [], open: [] };
    const shown = () => q('[data-panel="git-log"]');
    for (let i = 0; i < n; i += 1) {
      for (const [dir, until] of [
        ['close', () => !shown()],
        ['open', () => shown()],
      ]) {
        const r = await cost(() => click(toolButton('Git')), { until, settle });
        runs[dir].push({
          ms: r.ms,
          commits: r.renders?.commits,
          renderRegions: regionComponents(r.renders),
          ipc: r.ipc.ipc,
        });
      }
    }
    return runs;
  }

  /**
   * 비교 탭 → 다른 탭 → 비교 탭 복귀 (`n` 번, G5): 지금 활성인 비교 탭을 기준으로 편집기 탭 막대의 다른 탭을 눌렀다가
   * 돌아온다. 복귀의 시간·IPC·렌더 (고정 OID 비교는 복귀 때 다시 묻지 않는 것이 기대)
   */
  async function compareTabReturn({ n = 3, settle = 500 } = {}) {
    const tabs = () => qa('[data-panel="editor"] [role="tab"]');
    const compareTab = tabs().find((t) => t.getAttribute('aria-selected') === 'true');
    if (!compareTab || !comparisonRoot()) throw new Error('활성 비교 탭이 없다');
    const title = compareTab.textContent.trim();
    const other = tabs().find((t) => t !== compareTab);
    if (!other) throw new Error('돌아갈 다른 탭이 없다');
    const otherTitle = other.textContent.trim();
    const byTitle = (text) => tabs().find((t) => t.textContent.trim() === text);
    const runs = [];
    for (let i = 0; i < n; i += 1) {
      click(byTitle(otherTitle));
      await waitFor(() => !comparisonRoot());
      await pause(settle);
      const r = await cost(() => click(byTitle(title)), { until: comparisonShown, settle });
      runs.push({
        ms: r.ms,
        ipc: r.ipc.ipc,
        total: r.ipc.total,
        commits: r.renders?.commits,
        renderRegions: regionComponents(r.renders),
      });
    }
    return { title, other: otherTitle, runs };
  }

  /**
   * 저장소 탭의 쓰기 동작 한 번 (G2 다음 후보의 근거): Commit 도구 창의 "변경" 칸에서 파일 `path`(없으면 첫 파일) 하나를 골라 "스테이징" 을
   * 누른다. 누름부터 `settle` ms 까지의 렌더 커밋 수·영역별 수와 IPC, 커밋별 영역 (busy 시작·끝으로 전체가 두 번 그려지는지 본다)
   */
  async function repoStage({ path, settle = 1500 } = {}) {
    if (!q('[data-panel="commit"] section[data-area="unstaged"]')) {
      click(toolButton('커밋'));
      await waitFor(
        () => q('[data-panel="commit"] section[data-area="unstaged"] [data-path]'),
        20_000,
      );
      await pause(800);
    }
    const area = need('[data-panel="commit"] section[data-area="unstaged"]');
    const row = path ? q(`[data-path="${CSS.escape(path)}"]`, area) : q('li[data-path]', area);
    if (!row) throw new Error('stage 할 파일 행이 없다');
    const staged = row.dataset.path;
    // 행을 눌러 고른다 (체크칸 없이 `data-selected`)
    click(row);
    await waitFor(() => row.dataset.selected === 'true');
    await pause(300);
    const button = qa('button', area).find((b) => b.textContent.trim() === '스테이징');
    if (!button || button.disabled) throw new Error('"스테이징" 단추를 누를 수 없다');
    const r = await cost(() => click(button), { settle });
    return {
      path: staged,
      ms: r.ms,
      commits: r.renders?.commits,
      renderRegions: regionComponents(r.renders),
      ipc: r.ipc.ipc,
      perCommit: renders.installed
        ? M.commits.map((c) => regionComponents({ regions: c.regions }))
        : null,
    };
  }

  /**
   * 폴더 탭의 주기 요약 갱신 (G2): 폴더 설정의 자동 갱신 간격을 `secs` 초로 바꿔 저장한 뒤 `wait` ms 동안 렌더·IPC 를 센다.
   * 개요 탭이 열려 있어야 "폴더 설정…" 단추가 있다
   */
  async function folderAutoRefresh({ secs = 2, wait = 6000 } = {}) {
    const open = qa('button').find((b) => b.textContent.trim().startsWith('폴더 설정'));
    if (!open) throw new Error('"폴더 설정…" 단추가 없다 (개요 탭)');
    click(open);
    const input = await waitFor(() =>
      qa('input[type="number"]').find((i) => i.closest('label')?.textContent.includes('자동 갱신')),
    );
    // 저장·닫기 단추는 입력 칸을 품은 가장 가까운 상자에서 찾는다 (다른 화면의 "닫기" 와 섞이지 않게)
    let box = input.parentElement;
    while (box && !qa('button', box).some((b) => b.textContent.trim() === '저장')) {
      box = box.parentElement;
    }
    if (!box) throw new Error('"저장" 단추가 없다');
    type(input, String(secs));
    await afterPaint();
    click(qa('button', box).find((b) => b.textContent.trim() === '저장'));
    await waitFor(() =>
      qa('*', box).some((e) => e.childElementCount === 0 && e.textContent.trim() === '저장됨'),
    );
    const close = qa('button', box).find((b) => b.textContent.trim() === '닫기');
    if (close) click(close);
    await pause(secs * 1000 + 500);
    const out = await idle(wait);
    out.renderRegions = regionComponents(out.renders);
    return out;
  }

  // ── 3라운드 E: diff 화면 그리기 (2026-11-27) ──────────────────────────────────────────────────────────────

  /** rAF 간격을 모은다. 돌려준 함수를 부르면 멈추고 간격 목록(ms)을 준다 */
  function frameGaps() {
    const gaps = [];
    let last = 0;
    let on = true;
    const tick = (t) => {
      if (last) gaps.push(t - last);
      last = t;
      if (on) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      on = false;
      return gaps;
    };
  }

  /** 비교 화면의 diff 머리(옛·새 쪽 이름)의 글자 — 새 문서가 도착하면 바뀐다 */
  const diffLabels = (root) =>
    q('[class*="sideLabels"]', root ?? comparisonRoot() ?? document)?.textContent ?? '';

  /** 보이는 diff 행에 구문 강조 조각이 있는지 (`tok-*`) */
  const highlighted = (root) =>
    !!q('[data-testid="diff-scroller"] [class*="tok-"]', root ?? document);

  /**
   * 폴더 탭 Git 로그에서 `repo` 의 커밋 행 우클릭 → "현재 로컬 내용과 비교" (실제 앱 기록의 동작, E-1). 비교 화면에 첫 파일의
   * diff 가 그려질 때까지의 시간·50ms 넘는 프레임·렌더·IPC. 큰 문서는 조절값 `mgit.mock.diffLines` 로 켠다
   */
  async function compareOpenBig({ repo = 'auth-service', settle = 1500 } = {}) {
    // 저장소 이름은 그 저장소 묶음의 첫 행에만 보인다: 보일 때까지 로그를 내린다
    const found = () =>
      qa('[data-panel="git-log"] [data-oid]').find((r) => r.textContent.includes(repo));
    const logScroller = scrollerOf(need('[data-panel="git-log"] [data-oid]'));
    for (let i = 0; i < 200 && !found() && logScroller; i += 1) {
      logScroller.scrollTop += 400;
      await afterPaint();
    }
    const row = await waitFor(found, 20_000);
    row.scrollIntoView({ block: 'center' });
    await afterPaint();
    const item = await contextItem(row, '현재 로컬 내용과 비교');
    const stopGaps = frameGaps();
    const r = await cost(() => click(item), {
      until: () => comparisonShown() && diffLabels() !== '',
      timeout: 30_000,
      settle,
    });
    const gaps = stopGaps();
    return {
      ms: r.ms,
      longFrames: gaps.filter((g) => g > 50).map(round),
      longTasks: r.longTasks,
      longest: r.longest,
      commits: r.renders?.commits,
      renderRegions: regionComponents(r.renders),
      ipc: r.ipc.ipc,
      files: qa('[role="tree"] [role="treeitem"]', comparisonRoot()).length,
    };
  }

  /**
   * 비교 화면의 변경 파일 트리에서 파일 → 다음 파일로 ↓ 를 `n` 번 (E-1, 사이의 디렉터리 행은 재지 않고 건넌다): 키마다 입력 → 다음 그리기(`firstPaint`), 입력 → 새 문서가 그려질 때까지
   * (`ms`), 입력 → 강조가 붙을 때까지(`highlightMs`), 50ms 넘는 프레임(목록), 커밋 수·영역별 렌더·IPC. 열린 비교 화면에서 부른다
   */
  async function compareFileStep({ n = 8, settle = 600, timeout = 20_000 } = {}) {
    const root = comparisonRoot();
    if (!root) throw new Error('비교 화면이 없다');
    const tree = need('[role="tree"]', root);
    tree.focus();
    const runs = [];
    const items = () => qa('[role="treeitem"]', tree);
    for (let i = 0; i < n; i += 1) {
      // 다음 행이 디렉터리면 재지 않고 먼저 그 행으로 옮긴다 (재는 키는 늘 파일 → 파일)
      const list = items();
      const at = list.findIndex((r) => r.getAttribute('aria-selected') === 'true');
      if (list[at + 1]?.getAttribute('data-kind') === 'dir') {
        key(tree, 'ArrowDown');
        await pause(settle);
      }
      const before = diffLabels(root);
      const stopGaps = frameGaps();
      const t0 = performance.now();
      let firstPaint = null;
      void afterPaint().then(() => {
        firstPaint = round(performance.now() - t0);
      });
      let highlightMs = null;
      const r = await cost(() => key(tree, 'ArrowDown'), {
        until: () => {
          const now = diffLabels(root);
          return now !== '' && now !== before && !visibleText(root, '불러오는 중…');
        },
        timeout,
        settle: 0,
      });
      // 강조가 붙을 때까지 (그 뒤 settle 만큼 더 본다)
      await waitFor(() => highlighted(root), 5_000).catch(() => null);
      if (highlighted(root)) highlightMs = round(performance.now() - t0);
      await pause(settle);
      const gaps = stopGaps();
      runs.push({
        ms: r.ms,
        firstPaint,
        highlightMs,
        longFrames: gaps.filter((g) => g > 50).map(round),
        commits: r.renders?.commits,
        renderRegions: regionComponents(r.renders),
        ipc: r.ipc.ipc,
      });
    }
    const pick = (f) => stats(runs.map(f).filter((v) => v !== null));
    return {
      ms: pick((r) => r.ms),
      firstPaint: pick((r) => r.firstPaint),
      highlightMs: pick((r) => r.highlightMs),
      longFramesPerKey: stats(runs.map((r) => r.longFrames.length)),
      runs,
    };
  }

  /**
   * 보이는 diff 본문을 프레임마다 `step` px 씩 `frames` 번 스크롤 (E-1): rAF 간격 p50·p95·최대, 50ms 넘는 프레임, 커밋 수와
   * 커밋당 diff 본문 안에서 다시 그린 컴포넌트 수 (`M.split` 으로 본문을 가른다)
   */
  async function diffScroll({ frames = 60, step = 120, within } = {}) {
    const scroller = need('[data-testid="diff-scroller"]', within ?? comparisonRoot() ?? document);
    scroller.scrollTop = 0;
    await afterPaint();
    const split = M.split;
    M.split = ['[data-testid="diff-scroller"]'];
    if (renders.installed) renders.start();
    const out = await scroll(scroller, { step, frames });
    const r = renders.installed ? renders.stop() : null;
    M.split = split;
    const inBody = r
      ? Object.entries(r.regions)
          .filter(([k]) => k.endsWith('[data-testid="diff-scroller"]'))
          .reduce((n, [, v]) => n + v.components, 0)
      : null;
    return {
      ...out,
      commits: r?.commits ?? null,
      bodyComponentsPerCommit: r?.commits ? round(inBody / r.commits) : null,
      renderRegions: regionComponents(r),
    };
  }

  // ── 3라운드 F: diff 휠 (2026-11-27) ──────────────────────────────────────────────────────────────────────

  /**
   * diff 본문 휠 측정 시작 (F-1). 휠 입력은 밖(Playwright `page.mouse.wheel` — CDP 의 실제 입력 경로)에서 보낸다 — `scrollTop`
   * 을 바꾸는 `diffScroll` 과 달리 휠 리스너가 돈다. 프레임 간격, 휠 이벤트 수·가로 성분이 있는 수·기본 동작을 취소한 수,
   * 이벤트당 처리 시간(창 capture → 창 bubble), 세로·가로 이동 거리를 모은다. 휠을 보낼 화면 좌표를 돌려준다 (`side`: 좌우
   * 보기의 어느 쪽 코드 위인지)
   */
  function diffWheelStart({ within, side = 'right' } = {}) {
    const scroller = need('[data-testid="diff-scroller"]', within ?? comparisonRoot() ?? document);
    const view = scroller.closest('[style*="--diff-split"]') ?? scroller.parentElement;
    const state = {
      scroller,
      view,
      top0: scroller.scrollTop,
      events: 0,
      withX: 0,
      prevented: 0,
      handle: [],
      start: 0,
      longTasks0: M.longTasks.length,
    };
    const onCapture = () => {
      state.start = performance.now();
    };
    const onBubble = (event) => {
      state.events += 1;
      if (event.deltaX) state.withX += 1;
      if (event.defaultPrevented) state.prevented += 1;
      state.handle.push(performance.now() - state.start);
    };
    window.addEventListener('wheel', onCapture, { capture: true, passive: true });
    window.addEventListener('wheel', onBubble, { passive: true });
    const stopGaps = frameGaps();
    state.finish = () => {
      window.removeEventListener('wheel', onCapture, { capture: true });
      window.removeEventListener('wheel', onBubble);
      return stopGaps();
    };
    M.wheelRun = state;
    const code = qa(`[data-side="${side}"]`, scroller)[3] ?? scroller;
    const r = code.getBoundingClientRect();
    return { x: Math.round(r.left + Math.min(r.width / 2, 200)), y: Math.round(r.top + 4) };
  }

  /** diff 본문 휠 측정 끝 (F-1): `diffWheelStart` 뒤 모은 값 */
  async function diffWheelStop() {
    const state = M.wheelRun;
    if (!state) throw new Error('diffWheelStart 를 먼저 부른다');
    await afterPaint();
    const gaps = state.finish();
    M.wheelRun = null;
    const g = stats(gaps);
    const h = stats(state.handle);
    const css = (name) => getComputedStyle(state.view).getPropertyValue(name).trim();
    return {
      frames: gaps.length,
      p50: g.median,
      p95: g.p95,
      max: g.max,
      over50: gaps.filter((x) => x > 50).length,
      events: state.events,
      withX: state.withX,
      prevented: state.prevented,
      handleP50: h.median,
      handleP95: h.p95,
      handleMax: h.max,
      movedY: round(state.scroller.scrollTop - state.top0),
      leftScroll: css('--diff-left-scroll'),
      rightScroll: css('--diff-right-scroll'),
      longTasks: M.longTasks.length - state.longTasks0,
    };
  }

  M.scenarios = {
    // 2026-11-27 반응성 기준선 (M3)
    editorIdle,
    editorType,
    editorSave,
    compareLocalIdle,
    compareOpen,
    projectTreeWidth,
    projectRepoArrow,
    tabSwitchCost,
    // 2라운드 재측정 (G1·G2·G5)
    dockToggle,
    compareTabReturn,
    repoStage,
    folderAutoRefresh,
    // 3라운드 E (diff 화면 그리기)
    compareOpenBig,
    compareFileStep,
    diffScroll,
    // 3라운드 F (diff 휠 — 입력은 Playwright 가 보낸다)
    diffWheelStart,
    diffWheelStop,
    remountLog,
    branchTree,
    changedFiles,
    projectTree,
    commitTree,
    filterDropdown,
    timeline,
    repoGraph,
    tabSwitch,
    repoTabReady,
    folderTabReady,
    openRepoTab,
    fileView,
    // W29
    openRepo,
    repoLeftTools,
    logTextFilter,
  };

  // ── 문서 시작 때 할 일 ─────────────────────────────────────────────────────────

  try {
    const mode = localStorage.getItem('mgit.measure.renders');
    if (mode === '1' || mode === 'boot') {
      renders.installed = installRenderHook();
      // 'boot': 문서 시작부터 기록 (첫 표시 동안의 영역별 렌더, W29)
      M.recording = renders.installed && mode === 'boot';
    }
  } catch {
    // 저장소를 못 읽으면 계수기를 놓지 않는다
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        M.longTasks.push({ start: round(e.startTime), duration: round(e.duration) });
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // longtask 를 모르는 브라우저
  }
  // 첫 표시 표식: 그래프 행(폴더 로그·저장소 탭 공용), 브랜치 트리 행, 프로젝트 트리 행, 개요 표의 행
  watch('graphRow', '[data-testid="graph-scroller"] [data-oid]');
  watch('branchRow', '[data-panel="git-branches"] [role="treeitem"]');
  watch('projectRow', '[data-panel="project"] [role="treeitem"]');
  watch('overviewRow', '[data-panel="editor"] table tbody tr');

  Object.assign(M, {
    q,
    qa,
    need,
    raf,
    afterPaint,
    waitFor,
    time,
    repeat,
    stats,
    round,
    click,
    key,
    type,
    scrollerOf,
    domCount,
    scroll,
    watch,
    renders,
    longTasksSince,
    pause,
    tabNamed,
    buttonNamed,
    projectRow,
    detailShows,
    summarizeRuns,
    // W29
    tabActive,
    leaving,
    switchedTo,
    stripeButton,
    regionSizes,
    // 2026-11-27 반응성 기준선 (M3)
    ipcWindow,
    canvasCounter,
    cost,
    idle,
    domWatch,
    regionComponents,
    projectPath,
    revealProjectFile,
    expandProjectDirs,
    openEditorFile,
    insertText,
    waitSaved,
    contextItem,
    comparisonRoot,
    comparisonShown,
    visibleText,
  });
  window.__mgitMeasure = M;
})();
