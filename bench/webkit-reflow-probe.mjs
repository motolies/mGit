// 반응성 슬라이스 I: 화면 안의 흐름 속 요소를 건드린 뒤 `offsetHeight` 읽기까지의 강제 배치 시간을 위치별로 재고(diff 도구 모음
// 글자·diff 본문 안쪽 높이 1px·Git 로그 목록과 Project 트리에 상자 넣고 빼기·상태 막대 글자·포커스 이동·문서 루트 사용자 정의
// 속성), 배치 경계 후보에 `contain: layout size` 를 넣었을 때(쌓아 가며 / 하나씩)를 견준다. 배치 지문(주요 상자)도 함께 적는다.
// 준비·실행은 `webkit-layout-probe.mjs` 와 같다:
//   PLAYWRIGHT_MODULE=<스크래치>/node_modules/playwright/index.mjs node bench/webkit-reflow-probe.mjs <webkit|chromium> [--no-diff]
import { readFileSync } from 'node:fs';

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const [engine = 'webkit', ...flags] = process.argv.slice(2);
const browser = await (engine === 'chromium' ? chromium : webkit).launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 3360, height: 1828 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
  locale: 'ko-KR',
});
await context.addInitScript({
  content: readFileSync(new URL('./frontend-measure.js', import.meta.url), 'utf8'),
});
const page = await context.newPage();
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.goto(process.env.MGIT_PREVIEW_URL ?? 'http://127.0.0.1:4317/');
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem('mgit.mock.diffLines', '3000');
  localStorage.setItem('mgit.mock.diffHunks', '40');
  localStorage.setItem('mgit.mock.worktreeChanges', '20');
  localStorage.setItem('mgit.language', 'ko');
});
await page.reload();
await page.waitForSelector('[data-panel="git-log"] [data-oid]', { timeout: 30_000 });
await page.waitForTimeout(1500);
if (!flags.includes('--no-diff')) {
  await page.evaluate(() => window.__mgitMeasure.scenarios.compareOpenBig({}));
  await page.waitForSelector('[data-testid="diff-scroller"] [data-index]', { timeout: 30_000 });
  await page.waitForTimeout(1500);
}

// 배치 경계 후보: 이름 → 선택자 (실험실에서만 contain 을 붙인다)
const BOUNDARIES = [
  [
    'panel areas [data-panel=project|editor|git-log|git-branches|git-detail]',
    '[data-panel="project"], [data-panel="editor"], [data-panel="git-log"], [data-panel="git-branches"], [data-panel="git-detail"]',
  ],
  ['resizable panels [data-panel=true]', '[data-panel="true"]'],
  ['diff scroller', '[data-testid="diff-scroller"]'],
  ['graph scroller', '[data-testid="graph-scroller"]'],
  ['tree scrollers [role=tree]', '[role="tree"]'],
];

const result = await page.evaluate(
  async ({ boundaries }) => {
    const q = (s) => document.querySelector(s);
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    /** 위치별 건드리기: 바꾸고(i 짝수) 되돌린다(i 홀수) */
    const textToggle = (el) => {
      if (!el) return null;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let node = null;
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        if (n.textContent.trim().length > 1) {
          node = n;
          break;
        }
      if (!node) return null;
      const original = node.textContent;
      return (i) => {
        node.textContent = i % 2 ? original : `${original}·`;
      };
    };
    const heightToggle = (el) =>
      el
        ? (i) => {
            el.style.minHeight = i % 2 ? '' : `${el.offsetHeight + 1}px`;
          }
        : null;
    const boxToggle = (parent) =>
      parent
        ? (i) => {
            if (i % 2) parent.querySelector(':scope > .mgit-probe-box')?.remove();
            else {
              const box = document.createElement('div');
              box.className = 'mgit-probe-box';
              box.style.height = '1px';
              parent.append(box);
            }
          }
        : null;
    const diffToolbar = q('[data-testid="diff-scroller"]')?.closest(
      '[style*="--diff-split"]',
    )?.firstElementChild;
    const touches = {
      'diff toolbar text': textToggle(diffToolbar),
      'diff body inner +1px': heightToggle(q('[data-testid="diff-scroller"]')?.firstElementChild),
      'git log row in/out': boxToggle(q('[data-testid="graph-scroller"]')?.firstElementChild),
      'project tree row in/out': boxToggle(q('[data-panel="project"] [role="tree"]')),
      'status bar text': textToggle(q('footer')),
      'focus diff<->log': (() => {
        const a = q('[data-testid="diff-scroller"]');
        const b = q('[data-panel="git-log"] [role="grid"]') ?? q('[data-testid="graph-scroller"]');
        return a && b ? (i) => (i % 2 ? b : a).focus({ preventScroll: true }) : null;
      })(),
      'root --x (style a)': (i) =>
        document.documentElement.style.setProperty('--mgit-x', String(i)),
    };
    /** 건드린 뒤 offsetHeight 읽기까지 (12번 중앙값) */
    const time = (touch) => {
      const xs = [];
      touch(-1);
      void document.body.offsetHeight;
      for (let i = 0; i < 12; i += 1) {
        const t0 = performance.now();
        touch(i);
        void document.body.offsetHeight;
        xs.push(performance.now() - t0);
      }
      return +median(xs).toFixed(1);
    };
    const all = () =>
      Object.fromEntries(
        Object.entries(touches).map(([name, touch]) => [name, touch ? time(touch) : null]),
      );
    /** 배치 지문 (경계를 넣어도 모양이 같은지) */
    const shape = () =>
      [
        '[data-testid="diff-scroller"]',
        '[data-testid="graph-scroller"]',
        '[data-panel="project"] [role="tree"]',
        'footer',
      ]
        .map((s) => {
          const b = q(s)?.getBoundingClientRect();
          return b
            ? `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.width)}x${Math.round(b.height)}`
            : '-';
        })
        .join(' | ');
    const out = [{ step: 'as is', ...all(), shape: shape() }];
    const style = document.createElement('style');
    document.head.append(style);
    let css = '';
    for (const [name, selector] of boundaries) {
      css += `${selector} { contain: layout size; }\n`;
      style.textContent = css;
      void document.body.offsetHeight;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 300)));
      out.push({ step: `+ contain:layout size on ${name}`, ...all(), shape: shape() });
    }
    // 하나씩만 (누적 아님)
    for (const [name, selector] of boundaries) {
      style.textContent = `${selector} { contain: layout size; }`;
      void document.body.offsetHeight;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 300)));
      out.push({ step: `only ${name}`, ...all(), shape: shape() });
    }
    style.remove();
    return out;
  },
  { boundaries: BOUNDARIES },
);
const names = Object.keys(result[0]).filter((k) => k !== 'step' && k !== 'shape');
console.log(`${engine} | step | ${names.join(' | ')} | shape`);
for (const r of result)
  console.log(`${engine} | ${r.step} | ${names.map((n) => r[n]).join(' | ')} | ${r.shape}`);
await browser.close();
