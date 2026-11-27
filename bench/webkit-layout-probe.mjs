// 반응성 슬라이스 I·K: 목 프로덕션 화면을 WebKit·Chromium 에서 열어 "영역 안의 흐름 속 상자 하나를 넣은 뒤 강제 배치"
// 시간을 화면·영역별로 재고(`cost`), 배치 전후 모양이 같은지 보도록 모든 요소의 상자를 떠서(`shape`) 두 결과를 견준다(`compare`).
// 실제 앱(WKWebView)에서 배치 한 번이 약 0.1초였던 원인(세로 flex 안 `height:100%` 겹마다 하위 트리를 다시 배치)을 재고
// 고친 뒤를 확인하는 도구다. 자세한 절차·읽는 법·한계는 bench/README.md "WebKit 배치 실험실".
//
// 준비: `VITE_MGIT_MOCK=2000 VITE_MGIT_MOCK_SCENE=folder pnpm -F @mgit/desktop build:web` →
// `pnpm -F @mgit/desktop preview --port 4317 --strictPort`. playwright 는 저장소 의존성이 아니다 — 스크래치 폴더에
// `npm i playwright && npx playwright install webkit chromium` 한 뒤 그 모듈 경로를 넘긴다:
//
//   PLAYWRIGHT_MODULE=<스크래치>/node_modules/playwright/index.mjs node bench/webkit-layout-probe.mjs cost <webkit|chromium> [선택]
//   … shape <webkit|chromium> --out <결과.json> [--shots <폴더>] [선택]
//   … audit <webkit|chromium> [선택]   (문서 전체에서 부모가 flex 인 백분율 높이 요소 목록)
//   node bench/webkit-layout-probe.mjs compare <전.json> <후.json>
//
// 선택: `--url <주소>`(기본 http://127.0.0.1:4317/ 또는 MGIT_PREVIEW_URL), `--scenes a,b`(기본 전부, 아래 SCENES),
// `--size 3360x1828`(기본), `--dpr 2`, `--theme dark|light`(기본 dark), `--variants plain,moved,no-left,no-dock`
// (shape 기본 전부, cost 기본 plain), `--runs 15`(cost 반복 수), `--inject <js>`(실험용: 화면을 연 뒤 재기 전에 페이지에서 돌릴
// 함수 본문 — 스타일을 덮어써 고칠 곳을 미리 견줄 때)
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const [mode = 'cost', ...rest] = process.argv.slice(2);
const REPO = fileURLToPath(new URL('..', import.meta.url));

/** `--이름 값` 꼴의 선택 */
function option(name, fallback) {
  const at = rest.indexOf(`--${name}`);
  return at >= 0 && at + 1 < rest.length ? rest[at + 1] : fallback;
}

// ── compare: 두 shape 결과의 상자 차이 ────────────────────────────────────────────

if (mode === 'compare') {
  const [a, b] = rest.map((p) => JSON.parse(readFileSync(p, 'utf8')));
  let differing = 0;
  let total = 0;
  for (const [key, before] of Object.entries(a.shapes)) {
    const after = b.shapes[key];
    if (!after) {
      console.log(`${key}: 뒤 결과에 없음`);
      differing += 1;
      continue;
    }
    const diffs = [];
    const paths = new Set([...Object.keys(before.boxes), ...Object.keys(after.boxes)]);
    for (const path of paths) {
      const x = before.boxes[path];
      const y = after.boxes[path];
      total += 1;
      if (!x || !y || x.r.some((v, i) => Math.abs(v - y.r[i]) > 0.01))
        diffs.push({ path, label: (x ?? y).label, before: x?.r ?? null, after: y?.r ?? null });
    }
    console.log(`${key}: 요소 ${paths.size}개, 다른 상자 ${diffs.length}개`);
    for (const d of diffs.slice(0, 12))
      console.log(
        `  ${d.label} ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}  (${d.path})`,
      );
    if (diffs.length > 12) console.log(`  … ${diffs.length - 12}개 더`);
    differing += diffs.length;
  }
  console.log(`합계: 상자 ${total}개 중 다른 것 ${differing}개`);
  process.exit(differing ? 1 : 0);
}

// ── 화면 준비 ──────────────────────────────────────────────────────────────────

const engine = rest[0] ?? 'webkit';
const url = option('url', process.env.MGIT_PREVIEW_URL ?? 'http://127.0.0.1:4317/');
const [width, height] = option('size', '3360x1828').split('x').map(Number);
const dpr = Number(option('dpr', '2'));
const theme = option('theme', 'dark');
const runs = Number(option('runs', '15'));
const measureScript = readFileSync(new URL('./frontend-measure.js', import.meta.url), 'utf8');

/**
 * 화면: 목 장면(`folder`·`repo`·`conflict`)과 그 위에서 할 일 (페이지 안에서 도는 함수 본문, `M` 은 측정 도우미).
 * 모든 화면은 Git 로그의 네 번째 행을 골라 상세에 변경 파일 트리가 보이게 한 뒤 시작한다
 */
const SCENES = {
  // 폴더 탭: 통합 타임라인 + 편집기의 개요 탭
  folder: { scene: 'folder', setup: '' },
  // 폴더 탭의 비교 diff (큰 diff 3,000줄 — 슬라이스 I 의 기준 화면)
  'folder-compare': {
    scene: 'folder',
    setup: `await M.scenarios.compareOpenBig({});
      await M.waitFor(() => M.q('[data-testid="diff-scroller"] [data-index]'), 30000);`,
  },
  // 폴더 탭의 파일 편집기 (CodeMirror)
  'folder-file': {
    scene: 'folder',
    setup: `await M.openEditorFile('api-gateway/README.md', { settle: 1500 });`,
  },
  // 편집기를 좌우 두 그룹으로 나눈 상태 (팔레트 "편집기: 오른쪽으로 분할")
  'folder-split': {
    scene: 'folder',
    setup: `await M.openEditorFile('api-gateway/README.md', { settle: 1000 });
      await window.__probeCommand('편집기: 오른쪽으로 분할');
      await M.waitFor(() => M.qa('[data-panel="editor"] [role="tablist"]').length >= 2, 10000);`,
  },
  // 폴더 탭의 마크다운 파일을 편집기 + 미리보기 분할로
  'folder-markdown': {
    scene: 'folder',
    setup: `await M.openEditorFile('api-gateway/README.md', { settle: 1000 });
      M.click(M.qa('[data-panel="editor"] button').find((b) => b.textContent.trim() === '분할'));
      await M.waitFor(() => M.q('[data-panel="editor"] [class*="_preview_"]'), 10000);
      await M.pause(1000);`,
  },
  // 저장소 탭
  repo: { scene: 'repo', setup: '' },
  // 저장소 탭: 커밋을 고르지 않은 상태(상세 칸은 작업 트리 요약, 편집기는 빈 상태)
  'repo-no-selection': { scene: 'repo', select: false, setup: '' },
  // 저장소 탭: Pull Requests 도구 창
  'repo-pr': {
    scene: 'repo',
    setup: `M.click(M.stripeButton('풀 리퀘스트'));
      await M.waitFor(() => M.q('[data-panel="pull-requests"]'), 10000);
      await M.pause(1500);`,
  },
  // 저장소 탭: 아래 Git 도크를 최대화
  'repo-dock-max': {
    scene: 'repo',
    setup: `M.click(M.qa('button').find((b) => b.getAttribute('aria-label') === '도구 창 최대화'));
      await M.pause(1000);`,
  },
  // 저장소 탭: Commit 도구 창 + 작업 트리 diff
  'repo-worktree-diff': {
    scene: 'repo',
    setup: `M.click(M.stripeButton('커밋'));
      const row = await M.waitFor(() => M.q('[data-panel="commit"] li[data-path]'), 20000);
      await M.pause(300);
      M.click(row);
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await M.waitFor(() => M.q('[data-panel="editor"] [data-testid="diff-scroller"] [data-index]'), 20000);`,
  },
  // 저장소 탭: 아래 도크의 Git 콘솔(명령 로그) 탭
  'repo-console': {
    scene: 'repo',
    setup: `M.click(M.qa('[role="tab"]').find((t) => t.textContent.trim().startsWith('콘솔')));
      await M.pause(500);`,
  },
  // 저장소 탭: 통합 터미널
  'repo-terminal': {
    scene: 'repo',
    setup: `M.click(M.stripeButton('터미널'));
      await M.pause(1500);`,
  },
  // 저장소 탭: 태그 관리 문서
  'repo-tags': {
    scene: 'repo',
    setup: `M.click(M.qa('button, a').find((b) => b.textContent.trim() === '태그 관리 열기'));
      await M.waitFor(() => M.q('[data-panel="editor"] [role="tab"][aria-selected="true"]'), 10000);
      await M.pause(800);`,
  },
  // 충돌 장면: Commit 도구 창의 삭제 충돌 파일 → 충돌 문서(어느 쪽을 남길지)
  conflict: {
    scene: 'conflict',
    setup: `const row = await M.waitFor(() => M.qa('[data-panel="commit"] li[data-path]').find((r) => r.textContent.includes('CardForm')), 20000);
      M.click(row);
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await M.pause(2000);`,
  },
  // 충돌 장면: 내용 충돌 파일 → 3단 머지 편집기
  'conflict-merge': {
    scene: 'conflict',
    setup: `const row = await M.waitFor(() => M.qa('[data-panel="commit"] li[data-path]').find((r) => r.textContent.includes('PaymentStep')), 20000);
      M.click(row);
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      await M.waitFor(() => M.q('[data-panel="editor"] .cm-editor'), 20000);
      await M.pause(1500);`,
  },
};

/**
 * 모양 변형: 분할선을 옮긴 상태(`moved` — 보이는 분할선을 순서대로 40px 씩 끈다), 왼쪽 도구 창을 접은 상태(`no-left`),
 * 아래 Git 도크를 닫은 상태(`no-dock`)
 */
const VARIANTS = {
  plain: async () => {},
  moved: async (page) => {
    // 끌 때마다 자리를 다시 읽는다 — 앞의 분할선을 옮기면 뒤의 분할선 자리도 바뀐다(옛 자리를 끌면 글자 선택이 된다)
    for (let i = 0; i < 4; i += 1) {
      const h = await page.evaluate((at) => {
        const b = [...document.querySelectorAll('[role="separator"]')]
          .map((s) => s.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)[at];
        return b
          ? { x: b.x + b.width / 2, y: b.y + b.height / 2, vertical: b.height > b.width }
          : null;
      }, i);
      if (!h) break;
      await page.mouse.move(h.x, h.y);
      await page.mouse.down();
      await page.mouse.move(h.x + (h.vertical ? 40 : 0), h.y + (h.vertical ? 0 : -40), {
        steps: 4,
      });
      await page.mouse.up();
      await page.waitForTimeout(200);
    }
    const selected = await page.evaluate(() => String(getSelection()));
    if (selected) console.warn(`moved: 끄는 동안 글자가 선택됐다 (${selected.slice(0, 40)})`);
  },
  'no-left': async (page) => {
    await page.evaluate(() => {
      const M = window.__mgitMeasure;
      const on = M.qa('button', M.need('[role="toolbar"][aria-label="도구 창"]')).find(
        (b) => b.getAttribute('aria-pressed') === 'true',
      );
      if (on) M.click(on);
    });
  },
  'no-dock': async (page) => {
    await page.evaluate(() => {
      const M = window.__mgitMeasure;
      M.click(
        M.qa('button').find(
          (b) => b.getAttribute('aria-label') === 'Git' && b.getBoundingClientRect().left < 40,
        ),
      );
    });
  },
};

/** 화면 하나를 새 문맥에서 연다 */
async function openScene(browser, name) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: dpr,
    colorScheme: theme,
    locale: 'ko-KR',
  });
  await context.addInitScript({ content: measureScript });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  await page.goto(url);
  await page.evaluate((scene) => {
    localStorage.clear();
    localStorage.setItem('mgit.mock.scene', scene);
    localStorage.setItem('mgit.mock.diffLines', '3000');
    localStorage.setItem('mgit.mock.diffHunks', '40');
    localStorage.setItem('mgit.mock.worktreeChanges', '20');
    // 측정 도구의 메뉴 문구가 한국어다 (사용자 환경도 한국어)
    localStorage.setItem('mgit.language', 'ko');
  }, SCENES[name].scene);
  await page.reload();
  await page.waitForSelector('[data-panel="git-log"] [data-oid]', { timeout: 30_000 });
  await page.waitForTimeout(1000);
  await page.evaluate(PAGE_HELPERS);
  // 상세에 변경 파일 트리가 보이게 커밋 하나를 고른다
  if (SCENES[name].select !== false)
    await page.evaluate(async () => {
      const M = window.__mgitMeasure;
      const rows = M.qa('[data-panel="git-log"] [data-oid]');
      M.click(rows[3] ?? rows[0]);
      await M.waitFor(() => M.q('[data-panel="git-detail"] [role="treeitem"]'), 20000);
    });
  await page.evaluate(`(async () => { const M = window.__mgitMeasure; ${SCENES[name].setup} })()`);
  await page.waitForTimeout(1000);
  // 실험용: 재기 전에 페이지에서 돌릴 스크립트 (스타일을 덮어써 고칠 곳을 미리 견줄 때)
  const inject = option('inject', null);
  if (inject) {
    const r = await page.evaluate(
      `(async () => { const M = window.__mgitMeasure; ${readFileSync(inject, 'utf8')} })()`,
    );
    if (r !== undefined) console.log('inject', JSON.stringify(r));
    await page.waitForTimeout(500);
  }
  return { context, page };
}

/** 페이지 안 도우미: 팔레트 명령 실행, 영역 목록, 영역의 주 사슬 */
const PAGE_HELPERS = () => {
  const M = window.__mgitMeasure;
  /** 커맨드 팔레트(⌘⇧A)를 열어 그 이름의 명령을 실행한다 */
  window.__probeCommand = async (label) => {
    const target = M.q('[data-panel="editor"] [role="tab"][aria-selected="true"]') ?? document.body;
    target.focus();
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'A',
        code: 'KeyA',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    const input = await M.waitFor(() => M.q('[role="dialog"] input, [role="combobox"]'), 5000);
    M.type(input, label);
    await M.pause(300);
    const option = await M.waitFor(
      () => M.qa('[role="option"]').find((o) => o.textContent.includes(label)),
      5000,
    );
    M.click(option);
    await M.pause(800);
  };
  /** 보이는 영역들: 이름 → 뿌리 요소 (`data-panel` 영역, 아래 도크의 콘솔·터미널, 상태 막대) */
  window.__probeAreas = () => {
    const visible = (el) => {
      const b = el?.getBoundingClientRect();
      return b && b.width > 0 && b.height > 0;
    };
    const out = {};
    for (const el of M.qa('[data-panel]')) {
      const name = el.getAttribute('data-panel');
      if (name !== 'true' && visible(el)) out[name] = el;
    }
    const term = M.q('.xterm')?.parentElement;
    if (visible(term)) out.terminal = term;
    const consoleTab = M.qa('[role="tab"][aria-selected="true"]').find((t) =>
      t.textContent.trim().startsWith('콘솔'),
    );
    const consolePanel =
      consoleTab && M.q(`#${CSS.escape(consoleTab.getAttribute('aria-controls') ?? '')}`);
    if (visible(consolePanel)) out.console = consolePanel;
    if (visible(M.q('footer'))) out['status-bar'] = M.q('footer');
    return out;
  };
  /** 요소의 높이가 백분율로 선언됐는지 (인라인 또는 맞는 규칙) */
  const percentHeight = (el) => {
    if (el.style.height.endsWith('%')) return 'inline';
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      for (const rule of rules ?? [])
        if (rule.style?.height?.endsWith('%') && el.matches(rule.selectorText))
          return rule.selectorText;
    }
    return null;
  };
  /** 배치를 같게 보는 표시 이름: 태그·첫 클래스·data-panel/testid */
  const label = (el) => {
    const cls = el.classList[0] ?? '';
    const extra =
      el.getAttribute('data-panel') ??
      el.getAttribute('data-testid') ??
      el.getAttribute('role') ??
      '';
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${extra ? `[${extra}]` : ''}`;
  };
  window.__probeLabel = label;
  window.__probePercent = percentHeight;
  /**
   * 영역의 주 사슬: 뿌리에서 넓이가 가장 큰 자식으로 내려가며 스크롤 칸·편집 가능 요소·CodeMirror·xterm·svg·canvas
   * 에서 멈춘다. 멈춘 곳이 상자를 넣을 자리다 (스크롤 칸이면 그 안, 아니면 그 부모의 흐름 속)
   */
  window.__probeChain = (root) => {
    const chain = [root];
    let at = root;
    for (;;) {
      const cs = getComputedStyle(at);
      // 실제로 넘치는 스크롤 칸에서 멈춘다 (분할 패널 안쪽 div 처럼 overflow:auto 여도 넘치지 않으면 더 내려간다)
      if (
        at !== root &&
        /(auto|scroll)/.test(cs.overflowY) &&
        at.scrollHeight > at.clientHeight + 1
      )
        break;
      let best = null;
      let bestArea = 0;
      for (const child of at.children) {
        const ccs = getComputedStyle(child);
        if (ccs.position === 'absolute' || ccs.position === 'fixed' || ccs.display === 'none')
          continue;
        const b = child.getBoundingClientRect();
        if (b.width * b.height > bestArea) {
          best = child;
          bestArea = b.width * b.height;
        }
      }
      if (
        !best ||
        best.isContentEditable ||
        best.matches('.cm-editor, .xterm, svg, canvas, textarea, input')
      )
        break;
      chain.push(best);
      at = best;
    }
    return chain;
  };
  /** 사슬에서 부모가 flex·grid 인 백분율 높이 요소와 부모 배치 종류 (위에서부터, html 까지) */
  window.__probePercentChain = (target) => {
    const out = [];
    for (let el = target; el && el !== document.documentElement; el = el.parentElement) {
      const how = percentHeight(el);
      if (!how) continue;
      // 부모가 flex·grid 인 것만 (블록 부모 아래의 백분율 높이는 한 번에 풀린다)
      const p = getComputedStyle(el.parentElement);
      if (!/flex|grid/.test(p.display)) continue;
      const parent = p.display.includes('flex')
        ? `flex-${p.flexDirection.startsWith('column') ? 'col' : 'row'}`
        : p.display;
      out.unshift(`${label(el)}<${parent}>`);
    }
    return out;
  };
};

// ── cost: 영역별 강제 배치 시간 ─────────────────────────────────────────────────

/** 화면 하나의 영역별 비용과 사슬 */
async function costOf(page) {
  return page.evaluate(async (runs) => {
    const median = (xs) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.floor(s.length / 2)];
    };
    /** 바꾸고(i 짝수) 되돌리는(i 홀수) 변경 뒤 offsetHeight 까지 — 바꾸는 쪽만 센다 */
    const time = (touch) => {
      const xs = [];
      touch(-1);
      void document.body.offsetHeight;
      for (let i = 0; i < runs * 2; i += 1) {
        const t0 = performance.now();
        touch(i);
        void document.body.offsetHeight;
        if (i % 2 === 0) xs.push(performance.now() - t0);
      }
      return { ms: +median(xs).toFixed(1), max: +Math.max(...xs).toFixed(1) };
    };
    const out = {};
    for (const [name, root] of Object.entries(window.__probeAreas())) {
      const chain = window.__probeChain(root);
      const last = chain[chain.length - 1];
      // 스크롤 칸이면 그 안의 흐름 끝에, 아니면 그 요소 자체에 1px 상자를 넣는다
      const parent = last;
      let box = null;
      const r = time((i) => {
        if (i % 2) {
          box?.remove();
          box = null;
        } else {
          box = document.createElement('div');
          box.style.height = '1px';
          parent.append(box);
        }
      });
      out[name] = {
        ...r,
        at: window.__probeLabel(last),
        depth: chain.length,
        percent: window.__probePercentChain(last),
      };
    }
    out['root --x'] = time((i) =>
      document.documentElement.style.setProperty('--mgit-probe', String(i)),
    );
    document.documentElement.style.removeProperty('--mgit-probe');
    const diff = document.querySelector('[data-testid="diff-scroller"]');
    const log = document.querySelector('[data-testid="graph-scroller"]');
    if (log)
      out['focus log<->editor'] = time((i) =>
        (i % 2 ? log : (diff ?? document.querySelector('[data-panel="editor"]'))).focus({
          preventScroll: true,
        }),
      );
    out.elements = document.querySelectorAll('*').length;
    return out;
  }, runs);
}

// ── shape: 모든 요소의 상자 ────────────────────────────────────────────────────

/** 모든 요소의 상자 (경로 → 표시 이름·[x, y, 폭, 높이]). 터미널 안(글꼴 측정·커서)은 뺀다 */
async function shapeOf(page) {
  return page.evaluate(() => {
    const boxes = {};
    const walk = (el, path) => {
      if (el.matches('.xterm *')) return;
      const b = el.getBoundingClientRect();
      const round = (v) => Math.round(v * 100) / 100;
      boxes[path] = { label: window.__probeLabel(el), r: [b.x, b.y, b.width, b.height].map(round) };
      for (const [i, c] of [...el.children].entries()) walk(c, `${path}/${i}`);
    };
    walk(document.body, 'body');
    return boxes;
  });
}

/** CSS 모듈 이름(`_frame_13657_16`)을 원본 파일로: 같은 해시를 쓰는 지역 이름 묶음이 가장 많이 겹치는 `.module.css` */
function moduleNames() {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.module.css'))
        files.push({
          file: relative(REPO, p),
          locals: new Set(
            [...readFileSync(p, 'utf8').matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]),
          ),
        });
    }
  };
  walk(join(REPO, 'apps'));
  walk(join(REPO, 'packages'));
  return files;
}

/** 결과 글자 속 `_local_hash_n` 을 `파일:.local` 로 바꾼다 */
function readable(text, files, groups) {
  return text.replace(/_([A-Za-z][\w-]*?)_([0-9a-z]{5})_\d+/g, (all, local, hash) => {
    const locals = groups[hash];
    if (!locals) return all;
    let best = null;
    let score = 0;
    for (const f of files) {
      let hit = 0;
      for (const l of locals) if (f.locals.has(l)) hit += 1;
      const s = hit / Math.max(locals.size, f.locals.size);
      if (f.locals.has(local) && s > score) {
        best = f;
        score = s;
      }
    }
    return best ? `${best.file.split('/').pop().replace('.module.css', '')}.${local}` : all;
  });
}

// ── 실행 ──────────────────────────────────────────────────────────────────────

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true });
const sceneNames = option('scenes', Object.keys(SCENES).join(',')).split(',');
const variants = option(
  'variants',
  mode === 'shape' ? Object.keys(VARIANTS).join(',') : 'plain',
).split(',');
const shots = option('shots', null);
if (shots) mkdirSync(shots, { recursive: true });
const files = moduleNames();
const shapes = {};
for (const name of sceneNames) {
  for (const variant of variants) {
    const { context, page } = await openScene(browser, name);
    await VARIANTS[variant](page);
    await page.waitForTimeout(800);
    const key = `${engine} ${width}x${height} ${theme} ${name} ${variant}`;
    const groups = await page.evaluate(() => {
      const out = {};
      for (const el of document.querySelectorAll('[class]'))
        for (const c of el.classList) {
          const m = /^_([A-Za-z][\w-]*?)_([0-9a-z]{5})_\d+$/.exec(c);
          if (!m) continue;
          out[m[2]] ??= [];
          out[m[2]].push(m[1]);
        }
      return out;
    });
    const sets = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, new Set(v)]));
    if (shots) await page.screenshot({ path: join(shots, `${key.replaceAll(' ', '_')}.png`) });
    if (mode === 'shape') {
      shapes[key] = { boxes: await shapeOf(page) };
      console.log(key, Object.keys(shapes[key].boxes).length, 'boxes');
    } else if (mode === 'audit') {
      // 문서 전체에서 부모가 세로·가로 flex 인 백분율 높이 요소 (사슬 밖 포함)
      const found = await page.evaluate(() => {
        const out = {};
        for (const el of document.querySelectorAll('body *')) {
          const p = getComputedStyle(el.parentElement);
          if (!p.display.includes('flex') || !window.__probePercent(el)) continue;
          const b = el.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) continue;
          const k = `${p.flexDirection.startsWith('column') ? 'col' : 'row'} ${window.__probeLabel(el)}${el.style.height.endsWith('%') ? ' (인라인)' : ''} ← ${window.__probeLabel(el.parentElement)}`;
          out[k] = (out[k] ?? 0) + 1;
        }
        return out;
      });
      for (const [k, n] of Object.entries(found))
        console.log(`${key} | ${readable(k, files, sets)} ×${n}`);
    } else {
      const result = await costOf(page);
      for (const [area, r] of Object.entries(result)) {
        if (typeof r !== 'object') {
          console.log(`${key} | ${area} | ${r}`);
          continue;
        }
        const chain = r.percent ? readable(r.percent.join(' > '), files, sets) : '';
        const at = r.at ? readable(r.at, files, sets) : '';
        console.log(
          `${key} | ${area} | ${r.ms} (${r.max})${at ? ` | ${at} 깊이 ${r.depth}` : ''}${chain ? ` | % ${chain}` : ''}`,
        );
      }
    }
    await context.close();
  }
}
if (mode === 'shape') {
  const out = option('out', null);
  if (out) writeFileSync(out, JSON.stringify({ engine, width, height, theme, shapes }));
}
await browser.close();
