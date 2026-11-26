// 사용자 매뉴얼(docs/사용법.md·docs/사용법/)의 그림을 목 모드(합성 데이터)에서 찍는다. 앱 코드는 고치지 않는다.
// 실제 앱으로 찍으면 개인 저장소가 보일 수 있으므로 그림은 이 스크립트로만 만든다.
//
// 실행 방법
//   1. 목 모드 개발 서버를 띄운다. 장면 환경 변수(VITE_MGIT_MOCK_SCENE)는 주지 않는다 — 그림마다 환경별 설정
//      `mgit.mock.scene` 으로 장면을 고르고 새로 고침만 한다.
//        VITE_MGIT_MOCK=2000 pnpm -F @mgit/desktop dev:web          # 런처가 출력한 URL
//   2. Playwright MCP 의 browser_run_code_unsafe 를 `filename: "bench/docs-shots.js"`(저장소 루트 기준)로 부른다.
//      파일 내용을 `code` 에 그대로 붙여 넣어도 된다. MCP 는 내용을 `(내용)(page)` 로 감싸 부르므로 이 파일은
//      `async (page) => { … }` 식 하나여야 하고 끝에 `;` 가 없어야 한다 (그래서 아래 `biome-ignore format`).
//      MCP 실행 환경에는 process·require 가 없어 인자를 줄 수 없다. 일부만 찍으려면 아래 ONLY 에 이름을 적는다.
//   3. 결과: `docs/images/<name>.png`. 경로는 Playwright MCP 서버의 작업 디렉터리(저장소 루트) 기준 상대 경로이고
//      page.screenshot 이 바로 쓴다 (2026-11-20 확인). 쓰기가 막히는 환경이면 OUT_DIR 를 '.playwright-mcp' 로 바꿔
//      찍은 뒤 docs/images/ 로 옮긴다 (.playwright-mcp/ 는 gitignore 대상). 반환값은 그림별
//      { name, file, width, height, bytes } 와 실패한 그림의 { name, error } 다.
//      git 워크트리(`_worktrees/<이름>`)에서 찍을 때: MCP 의 상대 경로는 워크트리가 아니라 원본 저장소 루트 기준이라
//      그대로 부르면 원본 checkout 의 파일을 읽고 원본의 docs/images 에 쓴다. 이 파일에서 OUT_DIR 만 워크트리의
//      docs/images 절대 경로로 바꾼 사본을 원본 루트의 .playwright-mcp/ 에 두고 그 사본을 filename 으로 준다.
//      상태 바 왼쪽의 개발 실행 이름(`mGit Dev · <checkout>`)은 찍기 전에 숨긴다 (hideProfileLabel).
//   4. 끝나면 서버를 내린다: 서버 터미널에서 Ctrl+C
//
// 그림 더하기: 아래 SHOTS 에 항목을 더한다.
//   name     ASCII kebab (파일 이름이 된다)
//   scene    'folder' | 'repo' | 'conflict' | 'none'(장면 없이 시작 화면)
//   storage  더 넣을 환경별 설정 값 { 키: 값 } — 문자열이 아니면 JSON 으로 넣는다 (예: mgit.leftTool).
//            공통값 mgit.theme='dark'·mgit.language='ko'·mgit.mock.gitVersion=GIT_VERSION 이 먼저 들어간다
//            (언어를 정하지 않으면 목 모드는 브라우저 언어를 따른다 — 영어 브라우저면 영어로 찍힌다)
//   ready    (선택) 장면 준비 조건을 바꾸는 페이지 안 함수. 기본은 READY[scene] (예: 로그 칸을 숨긴 그림)
//   steps    async (page, h) => { … } — 장면 준비를 기다린 뒤 부른다. h 는 아래 helper 묶음
//   clip     null(창 전체) | CSS 선택자(그 요소 영역) | { selector, pad }. selector 를 배열로 주면 그 요소들을 모두
//            덮는 사각형(합집합)이다 (예: 툴바 단추와 그 아래 열린 메뉴). 선택자는 Playwright 의 것이라
//            `button:has-text("Fetch")` 도 쓸 수 있다
//   markers  [{ n, target, at, dx, dy }] — 번호 표식 ①~⑨. n 은 1~9, target 은 CSS 선택자 또는
//            { css, text }(글자가 text 인 요소), at 은 'tl'·'tr'·'bl'·'br'·'c'(요소 안쪽) 또는 'l'·'r'·'t'·'b'(바깥),
//            기본 'tl'. dx·dy 로 더 옮긴다. 대상이 없으면 그 그림은 실패로 남는다
//   rest     (선택) 찍기 전 마우스를 둘 곳. 기본은 툴바 왼쪽 빈자리(REST). { menuItem: '글자' } 면 열린 메뉴의 그 항목
//            위 — 빈 곳으로 옮기면 닫히는 하위 메뉴를 펼친 채 찍을 때
// 목이 보여 주지 못하는 상태(충돌이 있는 병합 미리보기 등)는 steps 에서 h.sessionValue·h.patchSession 으로 지금 탭의
// 세션 상태를 읽고 덮어쓴다 (페이지가 쓰는 같은 모듈 인스턴스 — 소스를 고쳐 HMR 이 돈 뒤에는 서버를 다시 띄울 것)
//
// 매 그림: 환경별 설정 초기화 → 공통값·scene·storage → 새로 고침 → 장면 준비 → steps → 마우스를 빈 곳으로 →
// 표식을 페이지 위에 겹쳐 그림(앱 DOM 밖의 fixed 레이어) → 찍기 → 표식 지우기.
// 창 1400×900, 다크, PNG. MCP 브라우저는 deviceScaleFactor 1 이고, 찍을 때 scale: 'css' 로 CSS 픽셀 크기를 고정한다.

// biome-ignore format: MCP 가 파일 내용을 `(내용)(page)` 로 감싸 부르므로 끝에 `;` 가 붙으면 안 된다
async (page) => {
  // ── 설정 ──────────────────────────────────────────────────────────────────────
  const BASE = new URL('/', page.url()).href;
  if (!BASE.startsWith('http://127.0.0.1:')) throw new Error('먼저 런처가 출력한 웹 주소를 여세요.');
  const OUT_DIR = 'docs/images';
  const VIEW = { width: 1400, height: 900 };
  /** 상태 바에 보일 git 버전 (목 기본값 `2.54.0 (mock)` 대신) */
  const GIT_VERSION = '2.54.0';
  /** 비어 있으면 전부, 이름을 적으면 그 그림만 찍는다 */
  const ONLY = [];
  /** 찍기 전에 마우스를 둘 곳 (툴바 왼쪽 빈자리 — 단추 hover 가 그림에 남지 않게) */
  const REST = { x: 20, y: 20 };

  /** 왼쪽 도구 창 띠 */
  const STRIPE = '[role="toolbar"][aria-label="도구 창"]';
  /** 툴바 왼쪽 끝의 앱 이름 (표식 ① 자리) */
  const BRAND = { css: 'header span', text: 'mGit' };
  /** 툴바의 열린 탭 하나 (이름과 닫기 단추를 묶은 칸) */
  const TAB = '[role="tablist"][aria-label="열린 탭"] [data-session-tab]';
  /** 툴바 아래 작업 진행 띠 */
  const OP_BAND = '[aria-label="진행 중인 작업"]';
  /** 로그 칸의 그래프 행 */
  const LOG_ROW = '[data-panel="git-log"] [data-testid="graph-scroller"] [data-oid]';
  /** 복제 대화상자에 넣을 예시 주소 */
  const EXAMPLE_URL = 'https://git.example.com/acme/storefront-web.git';
  /** 커맨드 팔레트 단축키 (기본 키 `mod+shift+a`) */
  const PALETTE_KEY = 'Meta+Shift+A';

  // ── 그림 목록 ──────────────────────────────────────────────────────────────────
  const SHOTS = [
    {
      name: 'start-screen',
      scene: 'none',
      clip: null,
    },
    {
      name: 'folder-tab',
      scene: 'folder',
      clip: null,
      // 사용법 3.1 의 범례와 번호가 같다. 글자를 가리지 않게 각 영역 머리줄의 빈자리에 둔다
      // (① 은 툴바의 앱 이름 위, ② 는 탭의 닫기 단추 오른쪽, ⑤ 는 머리줄에 단추가 차 있어 트리 오른쪽 아래 끝,
      // ⑦ 은 Git 도구 창 탭들의 오른쪽)
      markers: [
        { n: 1, target: BRAND, at: 'c' },
        { n: 2, target: TAB, at: 'r', dx: 4 },
        { n: 3, target: OP_BAND, at: 'c' },
        { n: 4, target: STRIPE, at: 'c' },
        { n: 5, target: '[data-panel="project"]', at: 'br' },
        { n: 6, target: '[data-panel="editor"]', at: 'tl', dx: 68, dy: 1 },
        { n: 7, target: '[role="tablist"][aria-label="Git"] > [role="tab"]:last-child', at: 'r', dx: 8 },
        { n: 8, target: 'footer', at: 'c' },
      ],
    },
    {
      name: 'repo-tab',
      scene: 'repo',
      clip: null,
      // 그래프를 다 읽은 뒤 로그의 셋째 행(커밋)을 골라 상세 칸을 채운다. 사용법 3.1 의 범례와 번호가 같다.
      // ④ 는 머리줄에 단추가 차 있어 트리 오른쪽 아래 끝, ⑥⑦⑧ 은 Git 도구 창 머리줄에서 각 칸(브랜치·로그·상세)의 바로 위
      steps: async (page, h) => {
        await h.waitFor(() => !document.querySelector('footer')?.textContent.includes('로드 중'));
        await page.locator(LOG_ROW).nth(2).click();
        await waitDetailLoaded(h);
      },
      markers: [
        { n: 1, target: BRAND, at: 'c' },
        { n: 2, target: TAB, at: 'r', dx: 4 },
        { n: 3, target: STRIPE, at: 'c' },
        { n: 4, target: '[data-panel="project"]', at: 'br' },
        { n: 5, target: '[data-panel="editor"]', at: 'tl', dx: 8, dy: 8 },
        { n: 6, target: '[data-panel="git-branches"]', at: 't' },
        { n: 7, target: '[data-panel="git-log"]', at: 't' },
        { n: 8, target: '[data-panel="git-detail"]', at: 't' },
        { n: 9, target: 'footer', at: 'c' },
      ],
    },
    {
      name: 'clone-dialog',
      scene: 'none',
      // 첫 단계(주소·옵션). 주소 칸에 예시 주소를 넣는다
      steps: async (page, h) => {
        await h.click(h.button('복제…'));
        await h.visible('dialog[open] input');
        await page.locator('dialog[open] input').first().fill(EXAMPLE_URL);
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'new-repo-dialog',
      scene: 'none',
      // 목은 폴더 선택 창 없이 상위 폴더(`/mock/repo-N`)를 바로 돌려주므로 이름 칸 대화상자가 곧 뜬다
      steps: async (page, h) => {
        await h.click(h.button('새 저장소…'));
        await h.visible('dialog[open] input');
        await page.locator('dialog[open] input').first().fill('acme-notes');
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'project-tree',
      scene: 'repo',
      // 아래 도구 창을 숨기고 상태 문자(M·A·R·?)가 든 폴더를 펼친다. 행은 가로 스크롤이라 도구 창이 좁으면 행 끝의 상태
      // 문자가 창 밖에 놓이므로, 날짜·크기까지 다 들어가게 왼쪽 도구 창을 넓힌다
      storage: {
        'mgit.bottomDock': { tool: null },
        'react-resizable-panels:workspace': { 'ws-left': 40, 'ws-editor': 60 },
      },
      ready: () => document.querySelector('[data-panel="project"] [role="treeitem"]'),
      steps: async (_page, h) => {
        for (const name of ['docs', 'adr', 'scripts', 'dev', 'src', 'features', 'cart', 'hooks']) {
          await h.click(h.projectRow(name));
          await h.afterPaint();
        }
        await h.click(h.projectRow('CartSummary.tsx'));
        await h.afterPaint();
      },
      clip: '[data-panel="project"]',
    },
    {
      name: 'overview',
      scene: 'folder',
      // 폴더 탭을 열면 기본으로 열려 있는 개요 탭 (편집기 영역만)
      clip: '[data-panel="editor"]',
    },
    {
      name: 'command-palette',
      scene: 'repo',
      steps: async (_page, h) => {
        await h.press(PALETTE_KEY);
        await h.visible('[cmdk-dialog] [cmdk-item]');
      },
      clip: { selector: '[cmdk-dialog]', pad: 8 },
    },
    {
      name: 'editor-tabs',
      scene: 'repo',
      // 고정 탭(package.json, 더블클릭) · 커밋 파일 diff 탭(상세의 변경 파일, 더블클릭으로 고정) · 미리보기 탭(README.md,
      // 한 번 클릭 — 기울임). 커밋 파일 diff 도 한 번 클릭은 미리보기라 고정하지 않으면 README.md 가 그 자리를 차지한다
      steps: async (page, h) => {
        await h.waitFor(() => !document.querySelector('footer')?.textContent.includes('로드 중'));
        await page.locator('[data-panel="project"] [role="tree"]').evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await h.afterPaint();
        await h.projectRow('package.json').dblclick();
        await page.locator(LOG_ROW).nth(2).click();
        await page
          .locator('[data-panel="git-detail"]')
          .getByText('CartSummary.tsx', { exact: true })
          .dblclick();
        await h.waitFor(() => document.querySelectorAll('[data-panel="editor"] [role="tab"]').length === 2);
        await h.click(h.projectRow('README.md'));
        await h.waitFor(() =>
          document.querySelector('[data-panel="editor"] [role="tabpanel"]')?.textContent.includes('storefront-web'),
        );
      },
      clip: '[data-panel="editor"]',
    },
    {
      name: 'repo-commit-tool',
      scene: 'repo',
      // 아래 Git 도구 창을 숨겨 Commit 도구 창이 창 높이를 다 쓰게 한다 (변경 목록이 더 보이게).
      // 로그 칸이 없으므로 장면 준비 조건을 Project 트리 행으로 바꾼다
      storage: { 'mgit.bottomDock': { tool: null } },
      ready: () => document.querySelector('[data-panel="project"] [role="treeitem"]'),
      steps: async (_page, h) => {
        await h.stripe('커밋').click();
        await h.waitFor(
          () => document.querySelectorAll('[data-panel="commit"] [role="tabpanel"] ul li').length > 3,
        );
      },
      clip: '[data-panel="commit"]',
    },
    // ── 4장 일상 작업 (U2) ──
    {
      name: 'folder-commit-tool',
      scene: 'folder',
      // 폴더 탭 Commit 도구 창: 체크 트리(일부만 stage 된 저장소·충돌 파일·커밋되지 않을 저장소 포함)와 커밋 칸.
      // 아래 도구 창을 숨기고 왼쪽 도구 창을 넓혀 트리가 더 보이게 한다. 메시지를 적어 단추가 켜진 모습으로
      storage: {
        'mgit.leftTool': { tool: 'commit' },
        'mgit.bottomDock': { tool: null },
        'react-resizable-panels:workspace': { 'ws-left': 30, 'ws-editor': 70 },
      },
      ready: () => document.querySelector('[data-panel="commit"] [role="treeitem"]'),
      steps: async (page, h) => {
        await page.locator('[data-panel="commit"] textarea').fill('feat: 로그인 시도 횟수 제한');
        await h.afterPaint();
      },
      clip: '[data-panel="commit"]',
    },
    {
      name: 'worktree-diff',
      scene: 'folder',
      // 폴더 탭 Commit 도구 창에서 일부만 stage 된 파일을 눌러 연 작업 트리 diff 탭. 선택 단위를 행으로 바꾸고 바뀐 줄
      // 두 개를 골라 "선택 변경 스테이징·되돌리기" 단추와 구간 단추, 작업 트리·스테이징됨 전환이 함께 보이게 한다
      storage: { 'mgit.leftTool': { tool: 'commit' } },
      ready: () => document.querySelector('[data-panel="commit"] [role="treeitem"]'),
      steps: async (page, h) => {
        await page
          .locator('[data-panel="commit"] [role="treeitem"]')
          .filter({ hasText: 'LoginController.java' })
          .first()
          .click();
        const unit = page.locator('[data-panel="editor"] select[aria-label="선택 단위"]');
        await unit.waitFor({ state: 'visible', timeout: 20_000 });
        await unit.selectOption('line');
        const lines = page.locator('[data-panel="editor"] [aria-label="줄 선택"]');
        await lines.first().waitFor({ state: 'visible', timeout: 20_000 });
        await lines.nth(0).click();
        await lines.nth(1).click();
        await h.afterPaint();
      },
      clip: '[data-panel="editor"]',
    },
    {
      name: 'folder-push-dialog',
      scene: 'folder',
      // 폴더 탭 툴바 Push 의 저장소 체크 목록 (보낼 commit 이 있는 저장소만 체크할 수 있다)
      steps: async (_page, h) => {
        await h.click(h.button('Push', 'header'));
        await h.visible('dialog[open] input[type="checkbox"]');
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'repo-push-menu',
      scene: 'repo',
      // 저장소 탭 툴바의 Push 옆 ⌄ (push 대상 선택) 메뉴. 툴바의 Fetch 부터 메뉴까지를 함께 찍는다
      steps: async (_page, h) => {
        await h.click(h.button('푸시 대상 선택', 'header'));
        await h.visible('[role="menu"]');
      },
      // 여백을 좁게 둔다 (넓으면 왼쪽의 새로고침 단추가 조금 걸린다)
      clip: { selector: ['header button:has-text("Fetch")', '[role="menu"]'], pad: 4 },
    },
    {
      name: 'checkout-dialog-folder',
      scene: 'folder',
      // 폴더 탭 브랜치 칸에서 development 우클릭 → 브랜치 전환… 체크 목록 (이미 그 브랜치인 저장소는 체크가 빠져 있다).
      // 더블클릭은 로그 거르기다
      steps: async (page, h) => {
        await page
          .locator('[data-panel="git-branches"] [role="treeitem"]')
          .filter({ hasText: /^development/ })
          .first()
          .click({ button: 'right' });
        await h.click(h.menuItem('브랜치 전환…'));
        await h.visible('dialog[open] input[type="checkbox"]');
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'branch-pane-repo',
      scene: 'repo',
      // 저장소 탭 브랜치 칸 전체: 아래 도구 창을 최대화하고 접힌 태그·백업 묶음을 펼친다 (충돌 레이더 배지·원격 삭제됨·
      // 워크트리 꼬리표가 함께 보인다). 원격 tag 를 확인해 태그 묶음 요약과 행 표시(push 안 됨·다름)도 보인다 — 요약이
      // 잘리지 않게 왼쪽 칸을 넓힌다 (사용법 4.4)
      storage: { 'react-resizable-panels:git-log': { 'gitlog-branches': 30, 'gitlog-commits': 70 } },
      steps: async (page, h) => {
        await h.click(h.button('도구 창 최대화'));
        await h.afterPaint();
        await showTreeTagStatus(page, h, { expand: false });
        for (const group of ['태그', '백업']) {
          await page
            .locator('[data-panel="git-branches"] [role="treeitem"]')
            .filter({ hasText: new RegExp(`^${group}\\d`) })
            .first()
            .click();
          await h.afterPaint();
        }
        // 마지막으로 누른 묶음 행의 포커스 테두리가 그림에 남지 않게 한다
        await page.evaluate(() => document.activeElement?.blur());
        await h.afterPaint();
      },
      clip: '[data-panel="git-branches"]',
    },
    {
      name: 'filter-bar',
      scene: 'repo',
      // 저장소 탭 로그의 필터 바: 텍스트 칸에 글자를 적고 Enter 를 누르기 전(적용 전 표시), 작성자 드롭다운을 열어 한 명을 체크
      steps: async (page, h) => {
        await page.locator('[data-panel="git-log"] [data-filter-text]').fill('장바구니');
        await h.click(h.button('작성자', '[data-panel="git-log"] [data-filter-bar]'));
        const pop = page.locator('[role="dialog"][aria-label="작성자"]');
        await pop.waitFor({ state: 'visible' });
        await pop.locator('[role="option"]').filter({ hasText: '이서연' }).first().click();
        await h.afterPaint();
      },
      clip: {
        selector: ['[data-panel="git-log"] [data-filter-bar]', '[role="dialog"][aria-label="작성자"]'],
        pad: 6,
      },
    },
    {
      name: 'view-options',
      scene: 'repo',
      // 저장소 탭 필터 바의 보기 옵션 메뉴
      steps: async (_page, h) => {
        await h.click('[data-panel="git-log"] [data-filter-bar] button[aria-label^="보기 옵션"]');
        await h.visible('[role="menu"]');
      },
      // 메뉴 바로 왼쪽에 편집기 안내 글자가 붙어 있어 여백 없이 메뉴 상자만 찍는다
      clip: '[role="menu"]',
    },
    {
      name: 'commit-detail',
      scene: 'repo',
      // 저장소 탭 상세 칸: 로그의 셋째 행(부모·자식·포함 브랜치·변경 파일이 있는 커밋)을 고른다. 변경 파일 트리와 메시지·
      // 부모·자식이 다 보이게 아래 도구 창을 높인다
      storage: { 'react-resizable-panels:bottom-dock': { 'shell-body': 25, 'shell-dock': 75 } },
      steps: async (page, h) => {
        await h.waitFor(() => !document.querySelector('footer')?.textContent.includes('로드 중'));
        await page.locator(LOG_ROW).nth(2).click();
        await waitDetailLoaded(h);
      },
      clip: '[data-panel="git-detail"]',
    },
    {
      name: 'file-history',
      scene: 'repo',
      // Project 트리에서 package.json 을 우클릭 → 파일 히스토리… 대화상자
      steps: async (page, h) => {
        await page.locator('[data-panel="project"] [role="tree"]').evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await h.afterPaint();
        await h.rightClick(h.projectRow('package.json'));
        await h.click(h.menuItem('파일 이력…'));
        await h.visible('dialog[open] li');
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'blame',
      scene: 'repo',
      // package.json 을 파일 보기로 열고 위 줄의 Blame 단추 → 작업 트리 기준 blame 대화상자
      steps: async (page, h) => {
        await page.locator('[data-panel="project"] [role="tree"]').evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await h.afterPaint();
        await h.projectRow('package.json').dblclick();
        await h.click(h.button('줄별 수정 이력', '[data-panel="editor"]'));
        await h.waitFor(() => {
          const d = document.querySelector('dialog[open]');
          return d && !d.textContent.includes('불러오는 중');
        });
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'stash-tab',
      scene: 'repo',
      // 저장소 탭 Commit 도구 창의 Stash 탭: 첫 stash 를 골라 아래에 상세가 보이게 한다. 도구 창을 넓혀 이름이 덜
      // 잘리게 하고, 도구 창 머리부터 상세의 마지막 파일까지만 찍는다 (아래는 빈 칸)
      storage: {
        'mgit.leftTool': { tool: 'commit' },
        'mgit.bottomDock': { tool: null },
        'react-resizable-panels:workspace': { 'ws-left': 30, 'ws-editor': 70 },
      },
      ready: () => document.querySelector('[data-panel="commit"] [role="tab"]'),
      steps: async (page, h) => {
        await h.click(h.tab('스태시', '[data-panel="commit"]'));
        const rows = page.locator('[data-panel="commit"] [role="option"]');
        await rows.first().waitFor({ state: 'visible', timeout: 20_000 });
        await rows.first().click();
        await h.waitFor(() => document.querySelector('[data-panel="commit"]')?.textContent.includes('바뀐 파일'));
      },
      clip: {
        selector: ['[data-panel="commit"] header', '[data-panel="commit"] section [role="treeitem"] >> nth=-1'],
        pad: 4,
      },
    },
    // ── 5장 가끔 하는 작업 (U3) ──
    {
      name: 'log-row-menu',
      scene: 'repo',
      // 저장소 탭 로그 행 우클릭 메뉴: 로컬 branch(development) 라벨이 있는 행이라 merge 하위 메뉴가 생긴다. 그 하위 메뉴를
      // 펼친 채 두 메뉴를 함께 찍는다
      steps: async (page, h) => {
        await h.waitFor(() => !document.querySelector('footer')?.textContent.includes('로드 중'));
        await page.locator(LOG_ROW).nth(6).click({ button: 'right', position: { x: 240, y: 10 } });
        await h.visible('[role="menu"]');
        await page.locator('[role="menuitem"]').filter({ hasText: '현재 브랜치 병합' }).first().hover();
        await h.visible('[role="menu"] >> nth=1');
        await h.afterPaint();
      },
      // 마우스를 빈 곳으로 옮기면 하위 메뉴가 닫히므로 하위 메뉴 항목 위에 둔다
      rest: { menuItem: '병합' },
      clip: { selector: ['[role="menu"] >> nth=0', '[role="menu"] >> nth=1'], pad: 6 },
    },
    {
      name: 'branch-menu-repo',
      scene: 'repo',
      // 저장소 탭 브랜치 칸에서 로컬 branch(development) 우클릭. merge 하위 메뉴를 펼친다
      steps: async (page, h) => {
        await page
          .locator('[data-panel="git-branches"] [role="treeitem"]')
          .filter({ hasText: /^development/ })
          .first()
          .click({ button: 'right' });
        await h.visible('[role="menu"]');
        await page.locator('[role="menuitem"]').filter({ hasText: '현재 브랜치 병합' }).first().hover();
        await h.visible('[role="menu"] >> nth=1');
        await h.afterPaint();
      },
      rest: { menuItem: '병합 (--no-ff)' },
      clip: { selector: ['[role="menu"] >> nth=0', '[role="menu"] >> nth=1'], pad: 6 },
    },
    {
      name: 'branch-pane-tag-status',
      scene: 'repo',
      // 사용법 3.8: 브랜치 칸 태그 묶음만. 원격 tag 를 확인해 묶음 행의 요약·행 끝 단추 둘(tag 관리 열기·원격 tag 확인)과
      // tag 행의 push 안 됨·⚠ 다름이 보이게 한다. 요약이 잘리지 않게 왼쪽 칸을 넓히고 로컬·원격 묶음을 접는다
      storage: {
        'react-resizable-panels:git-log': { 'gitlog-branches': 32, 'gitlog-commits': 68 },
        'react-resizable-panels:bottom-dock': { 'shell-body': 40, 'shell-dock': 60 },
      },
      steps: async (page, h) => {
        await showTreeTagStatus(page, h, { collapse: ['로컬', '원격'] });
        await page.evaluate(() => document.activeElement?.blur());
        await h.afterPaint();
      },
      clip: {
        selector: [
          '[data-panel="git-branches"] [data-node-id="group:tags"]',
          '[data-panel="git-branches"] [data-node-id="ref:refs/tags/v2.2.0"]',
        ],
        // 위아래 행이 비치지 않게 여백을 작게
        pad: 2,
      },
    },
    {
      name: 'tag-menu-tree',
      scene: 'repo',
      // 사용법 5.4 tag push 하기: 브랜치 칸 태그 묶음. 원격 tag 를 확인해 묶음 머리 요약과 행 표시(push 안 됨·다름)를 켠 뒤
      // 다름 행(v2.3.1)의 오른쪽 끝을 우클릭해 push 하위 메뉴를 펼친다 (메뉴가 아래 tag 행을 덮지 않게). 왼쪽 칸을 넓히고
      // Git 도구 창을 높이고 로컬·원격 묶음을 접어 태그 묶음이 다 보이게 한다
      storage: {
        'react-resizable-panels:git-log': { 'gitlog-branches': 32, 'gitlog-commits': 68 },
        'react-resizable-panels:bottom-dock': { 'shell-body': 40, 'shell-dock': 60 },
      },
      steps: async (page, h) => {
        await showTreeTagStatus(page, h, { collapse: ['로컬', '원격'] });
        const row = page.locator('[data-panel="git-branches"] [role="treeitem"][data-node-id="ref:refs/tags/v2.3.1"]');
        const box = await row.boundingBox();
        await page.mouse.click(box.x + box.width - 12, box.y + box.height / 2, { button: 'right' });
        await h.visible('[role="menu"]');
        await page.locator('[role="menuitem"][aria-haspopup="menu"]').filter({ hasText: prefix('푸시') }).first().hover();
        await h.visible('[role="menu"] >> nth=1');
        await h.afterPaint();
      },
      rest: { menuItem: 'origin' },
      clip: {
        selector: ['[data-panel="git-branches"]', '[role="menu"] >> nth=0', '[role="menu"] >> nth=1'],
        pad: 6,
      },
    },
    {
      name: 'tags-doc',
      scene: 'repo',
      // 사용법 5.4 태그 문서: 모든 원격을 확인하고 문서를 연 뒤 두 줄(로컬에만 v2.4.0, 원격에만 v2.5.0-rc.1)을 골라
      // 필터 단추의 개수와 일괄 단추의 해당 개수가 보이게 한다. 편집기 영역만 찍는다
      steps: async (page, h) => {
        await openCheckedTagsDoc(page, h);
        await pickTags(page, ['v2.4.0', 'v2.5.0-rc.1']);
        await h.afterPaint();
      },
      clip: '[data-panel="editor"]',
    },
    {
      name: 'tag-delete-dialog',
      scene: 'repo',
      // 사용법 5.4 tag 지우기: 모든 원격을 확인한 태그 문서에서 v2.4.0(어느 원격에도 없음)과 v2.3.0(두 원격에 있음)을
      // 골라 삭제… → 지울 곳 대화상자. 칸마다 해당 개수가, 아래에 다시 생길 수 있음·push 하지 않은 tag 경고가 보인다
      // (push 하지 않은 tag 경고는 모든 원격을 확인했을 때만 나온다)
      steps: async (page, h) => {
        await openCheckedTagsDoc(page, h);
        await pickTags(page, ['v2.4.0', 'v2.3.0']);
        await h.click(page.locator('[data-panel="editor"] button').filter({ hasText: prefix('삭제… (') }).first());
        await h.visible('dialog[open] [role="status"]');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'tag-differs-confirm',
      scene: 'repo',
      // 사용법 5.4 원격 tag 가 로컬과 다를 때: 태그 문서에서 v2.3.1(origin 과 다름)과 v2.3.0(같음)을 골라 origin 과 로컬에서
      // 지우기 → 목의 origin 이 다름을 돌려주어 세 갈래 확인창(취소·건너뛰고 삭제·그래도 삭제)이 뜬다. 찍은 뒤 새로 고치므로
      // 지우지 않는다
      steps: async (page, h) => {
        await openCheckedTagsDoc(page, h);
        await pickTags(page, ['v2.3.1', 'v2.3.0']);
        await h.click(page.locator('[data-panel="editor"] button').filter({ hasText: prefix('삭제… (') }).first());
        await h.visible('dialog[open] #pf-remote0');
        await page.locator('dialog[open] #pf-remote0').check();
        await h.click(h.button('삭제', 'dialog[open]'));
        await h.visible('dialog[open]:has-text("로컬과 다릅니다")');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'reset-hard-confirm',
      scene: 'repo',
      // 로그 행 우클릭 → reset ▸ hard 의 확인창
      steps: async (page, h) => {
        await h.waitFor(() => !document.querySelector('footer')?.textContent.includes('로드 중'));
        await page.locator(LOG_ROW).nth(3).click({ button: 'right' });
        await page.locator('[role="menuitem"]').filter({ hasText: /^커밋 위치 변경/ }).first().hover();
        await h.visible('[role="menu"] >> nth=1');
        await page.locator('[role="menu"] >> nth=1').locator('[role="menuitem"]').filter({ hasText: 'hard' }).click();
        await h.visible('dialog[open]');
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'drag-merge-dialog',
      scene: 'repo',
      // 로그의 development 라벨을 다른 행에 끌어다 놓은 대화상자. 브라우저 자동화의 끌기는 HTML 드래그를 일으키지 못해
      // 같은 DataTransfer 로 dragstart → dragover → drop 을 직접 보낸다 (앱이 받는 이벤트는 실제 끌기와 같다)
      steps: async (page, h) => {
        await h.waitFor(() => !document.querySelector('footer')?.textContent.includes('로드 중'));
        await page.evaluate((sel) => {
          const rows = document.querySelectorAll(sel);
          const label = rows[6]?.querySelector('[draggable="true"]');
          const target = rows[2];
          if (!label || !target) {
            throw new Error('끌 라벨이나 놓을 행이 없다');
          }
          const dt = new DataTransfer();
          const fire = (el, type) =>
            el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
          fire(label, 'dragstart');
          fire(target, 'dragenter');
          fire(target, 'dragover');
          fire(target, 'drop');
          fire(label, 'dragend');
        }, LOG_ROW);
        await h.visible('dialog[open] select');
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'merge-preview',
      scene: 'repo',
      // 브랜치 칸 → feature/checkout-redesign merge 미리보기…. 목은 늘 "충돌 없음"이라, 충돌 레이더가 알리는 그 branch 의
      // 충돌(파일 2개)·옵션 비교 결과·고른 파일의 마커 포함 결과를 세션 상태에 넣어 보인다
      steps: async (page, h) => {
        await page
          .locator('[data-panel="git-branches"] [role="treeitem"]')
          .filter({ hasText: /^feature\/checkout-redesign/ })
          .first()
          .click({ button: 'right' });
        await h.click(h.menuItem('feature/checkout-redesign 병합 미리보기…'));
        await h.visible('dialog[open]');
        const a = 'src/features/checkout/steps/PaymentStep.tsx';
        const b = 'src/features/checkout/legacy/CardForm.tsx';
        await h.patchSession({
          preview: {
            reference: 'feature/checkout-redesign',
            includeWip: false,
            loading: false,
            result: {
              ours: 'HEAD',
              theirs: 'feature/checkout-redesign',
              clean: false,
              conflicts: [a, b],
              tree: '0000000000000000000000000000000000000000',
              messages: [],
              strategy: [],
              wipIncluded: false,
            },
            simulate: [
              { strategy: [], clean: false, conflicts: [a, b] },
              { strategy: ['ignore-space-change'], clean: false, conflicts: [a, b] },
              { strategy: ['ignore-all-space'], clean: false, conflicts: [a] },
              { strategy: ['patience'], clean: false, conflicts: [a, b] },
              { strategy: ['ours'], clean: true, conflicts: [] },
              { strategy: ['theirs'], clean: true, conflicts: [] },
            ],
            simulating: false,
            file: {
              path: a,
              content: [
                "import { useState } from 'react';",
                '',
                'export function PaymentStep({ order }: PaymentStepProps) {',
                '  const [method, setMethod] = useState(order.defaultMethod);',
                '<<<<<<< HEAD',
                '  const total = roundHalfEven(order.subtotal + order.shipping);',
                '=======',
                '  const total = order.subtotal + order.shipping - order.discount;',
                '>>>>>>> feature/checkout-redesign',
                '  const label = formatMoney(total, order.currency);',
                '',
              ].join('\n'),
            },
            error: null,
          },
        });
        await h.visible('dialog[open] table');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'rebase-plan',
      scene: 'repo',
      // 로그 행(development) 우클릭 → 여기서 HEAD 까지 인터랙티브 rebase…. 목은 commit 0개라, 그 위 여섯 commit 을 세션
      // 상태에 넣고 검증 명령을 정한 모양(--exec 옵션이 보인다)으로 둔다. 동작은 둘째 reword·넷째 fixup·다섯째 drop
      steps: async (page, h) => {
        await h.waitFor(() => !document.querySelector('footer')?.textContent.includes('로드 중'));
        // 로그 맨 위 여섯 행 (todo 순서는 오래된 것 먼저라 뒤집는다): 해시·제목·작성자
        const commits = await page.evaluate((sel) => {
          const rows = [...document.querySelectorAll(sel)].slice(0, 6);
          return rows.reverse().map((r) => ({
            oid: r.getAttribute('data-oid'),
            subject: r.querySelector('span[title][class*="subject"]')?.getAttribute('title') ?? '',
            authorName: r.querySelector('[class*="author"]')?.textContent ?? '',
          }));
        }, LOG_ROW);
        await page.locator(LOG_ROW).nth(6).click({ button: 'right' });
        await h.click(h.menuItem('여기서 HEAD까지 인터랙티브 리베이스…'));
        await h.visible('dialog[open]');
        const plan = await h.sessionValue('rebasePlan');
        await h.patchSession({
          verifyCommand: 'pnpm test',
          rebasePlan: { onto: plan?.onto ?? null, hasMerges: false, commits },
        });
        const selects = page.locator('dialog[open] select');
        await selects.nth(5).waitFor({ state: 'visible' });
        await selects.nth(1).selectOption('reword');
        await selects.nth(3).selectOption('fixup');
        await selects.nth(4).selectOption('drop');
        await h.waitFor(() => !document.querySelector('dialog[open] textarea[disabled]'));
        // reword 줄의 새 메시지 (목은 메시지 전체를 빈 글자로 돌려준다)
        await page.locator('dialog[open] textarea').fill('test: 결제 단계 E2E 테스트 추가');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'op-band',
      scene: 'folder',
      // 폴더 탭의 작업 진행 띠: 조절값으로 진행 중 작업을 더해 여러 줄(revert·merge·rebase·cherry-pick)이 보이게 한다.
      // 툴바와 함께 찍는다
      storage: { 'mgit.mock.folderOps': '3' },
      ready: () =>
        document.querySelector('[data-panel="project"] [role="treeitem"]') &&
        document.querySelectorAll('[aria-label="진행 중인 작업"] [data-op-row]').length >= 3,
      clip: { selector: ['header', OP_BAND], pad: 0 },
    },
    {
      name: 'merge-editor',
      scene: 'conflict',
      // 충돌 장면: Commit 도구 창의 충돌 영역에서 PaymentStep.tsx 를 열어 3-way 충돌 편집기를 띄운다. 아래 도구 창을 숨겨
      // 편집기를 크게 보인다. 사용법 5.6 의 범례와 번호가 같다
      storage: { 'mgit.bottomDock': { tool: null }, 'mgit.leftTool': { tool: 'commit' } },
      ready: () => document.querySelector('[data-panel="commit"] [data-path]'),
      steps: async (page, h) => {
        await page.locator('[data-panel="commit"]').getByText('PaymentStep.tsx', { exact: true }).first().dblclick();
        await h.visible('[data-panel="editor"] .cm-mg-pick');
        await h.afterPaint();
      },
      clip: '[data-panel="editor"]',
      // 칸 제목 줄은 낮아서 표식을 그 줄 오른쪽 끝에 둔다 (첫 줄 코드의 오른쪽 빈자리에 조금 걸친다)
      markers: [
        { n: 1, target: { css: '[data-panel="editor"] span', text: '양쪽 수정' }, at: 'l' },
        { n: 2, target: { css: '[data-panel="editor"] label', text: '기준 내용 숨기기' }, at: 'r', dx: 8 },
        { n: 3, target: { css: '[data-panel="editor"] div', text: 'main' }, at: 'tr', dy: -4 },
        { n: 4, target: { css: '[data-panel="editor"] div', text: 'base' }, at: 'tr', dy: -4 },
        { n: 5, target: { css: '[data-panel="editor"] div', text: 'feature/checkout-redesign' }, at: 'tr', dy: -4 },
        { n: 6, target: { css: '[data-panel="editor"] div', text: '결과' }, at: 'tr', dy: -4 },
        { n: 7, target: '[data-panel="editor"] .cm-mg-pick', at: 'tr', dx: -4 },
      ],
    },
    {
      name: 'delete-conflict',
      scene: 'conflict',
      // 충돌 장면의 CardForm.tsx: 한쪽에서 지운 파일의 남기기·지우기 선택
      storage: { 'mgit.bottomDock': { tool: null }, 'mgit.leftTool': { tool: 'commit' } },
      ready: () => document.querySelector('[data-panel="commit"] [data-path]'),
      steps: async (page, h) => {
        await page.locator('[data-panel="commit"]').getByText('CardForm.tsx', { exact: true }).first().dblclick();
        await h.visible('[data-panel="editor"] pre');
        await h.afterPaint();
      },
      clip: { selector: ['[data-panel="editor"] header', '[data-panel="editor"] pre'], pad: 8 },
    },
    {
      name: 'structure-menu',
      scene: 'repo',
      // 저장소 탭 Project 도구 창 머리의 ⋮ (모듈·서브모듈·하위 저장소) 메뉴
      steps: async (_page, h) => {
        await h.click('[data-panel="project"] button[title^="모듈·서브모듈·하위 저장소"]');
        await h.visible('[role="menu"]');
        await h.afterPaint();
      },
      // 메뉴가 단추 왼쪽으로 펼쳐져 단추까지 함께 찍으면 머리줄의 제목이 반쯤 걸리므로 메뉴 상자만 찍는다
      clip: '[role="menu"]',
    },
    {
      name: 'pr-list',
      scene: 'repo',
      // 저장소 탭 Pull Requests 도구 창: 배지가 모두 나오는 목록과 한 행의 우클릭 메뉴
      storage: {
        'mgit.leftTool': { tool: 'pullRequests' },
        'react-resizable-panels:workspace': { 'ws-left': 30, 'ws-editor': 70 },
      },
      ready: () => document.querySelector('[data-panel="pull-requests"] [role="option"]'),
      steps: async (page, h) => {
        await page
          .locator('[data-panel="pull-requests"] [role="option"]')
          .nth(2)
          .click({ button: 'right', position: { x: 200, y: 12 } });
        await h.visible('[role="menu"]');
        await h.afterPaint();
      },
      rest: { menuItem: '브라우저에서 열기' },
      clip: {
        selector: [
          '[data-panel="pull-requests"] header',
          '[data-panel="pull-requests"] [role="option"]:last-child',
          '[role="menu"]',
        ],
        pad: 2,
      },
    },
    {
      name: 'pr-create',
      scene: 'repo',
      // Pull Requests 도구 창 머리의 만들기… → PR/MR 만들기 대화상자 (템플릿이 하나라 본문에 바로 채워진다)
      storage: { 'mgit.leftTool': { tool: 'pullRequests' } },
      ready: () => document.querySelector('[data-panel="pull-requests"] [role="option"]'),
      steps: async (page, h) => {
        await h.click('[data-panel="pull-requests"] button[aria-label="만들기…"]');
        await h.visible('dialog[open] textarea');
        // 본문 템플릿이 들어올 때까지 기다린다. 14bacde(입력 대화상자가 열린 첫 화면부터 처음 값) 이후로는 필요 없다 — 그
        // 전에는 처음 값을 다음 렌더에서 채워, 그 사이에 들어온 head 입력이 본문을 지웠다. 해가 없어 남겨 둔다
        await h.waitFor(() => document.querySelector('dialog[open] textarea')?.value.includes('변경 내용'));
        const fields = page.locator('dialog[open] input:not([type="checkbox"])');
        await fields.nth(0).fill('feature/search-filters');
        await page.locator('dialog[open] select').first().selectOption('development');
        await fields.nth(1).fill('검색 필터를 URL 쿼리로 동기화');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    // ── 6장 실수했을 때 · 8장 설정 (U4a) ──
    {
      name: 'backup-group',
      scene: 'repo',
      // 저장소 탭 브랜치 칸의 백업 묶음을 펼치고 main 백업을 우클릭한 메뉴. 아래 도구 창을 최대화해 묶음 아래에 메뉴가
      // 들어갈 자리를 둔다
      steps: async (page, h) => {
        await h.click(h.button('도구 창 최대화'));
        await h.afterPaint();
        await page
          .locator('[data-panel="git-branches"] [role="treeitem"]')
          .filter({ hasText: /^백업\d/ })
          .first()
          .click();
        await h.afterPaint();
        await page.evaluate(() => document.activeElement?.blur());
        // 행의 오른쪽 끝을 우클릭해 메뉴가 백업 행의 글자를 가리지 않게 한다 (메뉴는 누른 자리에서 열린다). 행은 가장 넓은
        // 행만큼 넓어 칸 밖까지 이어지므로, 행 끝을 누르면 칸이 가로로 스크롤된다 — 칸 안쪽 오른쪽 끝을 마우스로 누른다
        const row = page
          .locator('[data-panel="git-branches"] [data-node-id^="backup:refs/mgit/backup/main/"]')
          .first();
        const box = await row.boundingBox();
        const pane = await page.locator('[data-panel="git-branches"]').boundingBox();
        const x = Math.min(box.x + box.width, pane.x + pane.width) - 12;
        await page.mouse.click(x, box.y + box.height / 2, { button: 'right' });
        await h.visible('[role="menu"]');
        await h.afterPaint();
      },
      clip: {
        selector: ['[data-panel="git-branches"] [data-node-id="group:backups"]', '[role="menu"]'],
        pad: 4,
      },
    },
    {
      name: 'console-failed-push',
      scene: 'repo',
      // Git 도구 창 콘솔 탭: 목의 기록 8줄 가운데 거부된 push 줄을 눌러 오류 출력을 펼친다 (실패한 명령은 빨간 글자)
      storage: { 'mgit.bottomDock': { tool: 'git', gitTab: 'console' } },
      ready: () => document.querySelectorAll('section[aria-label="명령 로그"] li').length >= 8,
      steps: async (page, h) => {
        await page
          .locator('section[aria-label="명령 로그"] li button')
          .filter({ hasText: 'git push --porcelain' })
          .first()
          .click();
        await h.visible('section[aria-label="명령 로그"] pre');
        await page.evaluate(() => document.activeElement?.blur());
        await h.afterPaint();
      },
      // 여백을 두면 위쪽 Project 트리의 마지막 행이 조금 걸린다
      clip: {
        selector: ['[role="tablist"][aria-label="Git"]', 'section[aria-label="명령 로그"] li:last-child'],
        pad: 0,
      },
    },
    {
      name: 'file-backups',
      scene: 'repo',
      // 팔레트 → 폐기 백업…. 목은 늘 빈 목록이라, 버리기·hunk 되돌리기로 생긴 사본 세 개를 세션 상태에 넣어 보인다
      // (이유 칸의 discard·discard-lines 는 앱이 그대로 보이는 값)
      steps: async (page, h) => {
        await h.press(PALETTE_KEY);
        await h.visible('[cmdk-dialog] [cmdk-item]');
        await h.type('폐기 백업');
        await h.click(page.locator('[cmdk-item]').filter({ hasText: '폐기 백업…' }).first());
        await h.visible('dialog[open]');
        const at = Date.parse('2025-10-28T06:40:00+09:00');
        await h.patchSession({
          fileBackups: [
            { id: 3, relPath: 'src/features/cart/CartSummary.tsx', savedAt: at, reason: 'discard-lines' },
            { id: 2, relPath: 'src/lib/money/round.ts', savedAt: at - 18 * 60_000, reason: 'discard' },
            { id: 1, relPath: 'docs/adr/0007-checkout-flow.md', savedAt: at - 95 * 60_000, reason: 'discard' },
          ],
        });
        await h.visible('dialog[open] li');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'reflog',
      scene: 'repo',
      // 팔레트 → Reflog…. 목은 늘 빈 목록이라, 로그 맨 위 commit 들로 reset 뒤에 commit 을 되찾는 모양의 HEAD reflog 를
      // 세션 상태에 넣는다 (메시지는 git 이 reflog 에 남기는 꼴)
      steps: async (page, h) => {
        await h.waitFor(() => !document.querySelector('footer')?.textContent.includes('로드 중'));
        const oids = await page.evaluate(
          (sel) => [...document.querySelectorAll(sel)].slice(0, 4).map((r) => r.getAttribute('data-oid')),
          LOG_ROW,
        );
        await h.press(PALETTE_KEY);
        await h.visible('[cmdk-dialog] [cmdk-item]');
        await h.type('Reflog');
        await h.click(page.locator('[cmdk-item]').filter({ hasText: 'Reflog…' }).first());
        await h.visible('dialog[open]');
        const at = Date.parse('2025-10-28T06:40:00+09:00') / 1000;
        await h.patchSession({
          reflog: [
            { selector: 'HEAD@{0}', oid: oids[2], subject: 'reset: moving to HEAD~2', time: at },
            {
              selector: 'HEAD@{1}',
              oid: oids[0],
              subject: 'commit: feat: 상품 상세에 재고 배지 표시 (#2000)',
              time: at - 6 * 60,
            },
            {
              selector: 'HEAD@{2}',
              oid: oids[1],
              subject: 'commit: feat: 주문 내역 페이지 초안 (#1999)',
              time: at - 31 * 60,
            },
            { selector: 'HEAD@{3}', oid: oids[2], subject: 'pull --progress --no-edit: Fast-forward', time: at - 74 * 60 },
            {
              selector: 'HEAD@{4}',
              oid: oids[3],
              subject: 'checkout: moving from development to main',
              time: at - 80 * 60,
            },
          ],
        });
        await h.visible('dialog[open] li');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'external-apps',
      scene: 'repo',
      // ⌘, → 설정 대화상자: 맨 위 언어(공통값 ko), 그 아래 외부 앱 (처음 값: 둘 다 자동)
      steps: async (_page, h) => {
        await h.press('Meta+,');
        await h.visible('dialog[open] select');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'hosting-accounts',
      scene: 'repo',
      // 팔레트 → 호스팅 계정…. 목은 계정이 없어 빈 목록이지만 계정 추가·OAuth App·저장된 자격 증명 구역이 모두 보인다
      steps: async (page, h) => {
        await h.press(PALETTE_KEY);
        await h.visible('[cmdk-dialog] [cmdk-item]');
        await h.type('호스팅 계정');
        await h.click(page.locator('[cmdk-item]').filter({ hasText: '호스팅 계정…' }).first());
        await h.visible('dialog[open] select');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'author-profiles',
      scene: 'repo',
      // 팔레트 → 작성자 프로필…. 목은 프로필이 없어, 저장된 프로필 두 개를 앱 상태에 넣어 표 모양을 보인다
      steps: async (page, h) => {
        await h.press(PALETTE_KEY);
        await h.visible('[cmdk-dialog] [cmdk-item]');
        await h.type('작성자 프로필');
        await h.click(page.locator('[cmdk-item]').filter({ hasText: '작성자 프로필…' }).first());
        await h.visible('dialog[open]');
        await h.afterPaint();
        await page.evaluate(async () => {
          const app = await window.__mgitModule('/src/store/app-store-instance.ts');
          app.useAppStore.setState({
            profiles: [
              {
                id: 'p1',
                name: '회사',
                userName: 'Dev Kim',
                userEmail: 'dev.kim@example.com',
                signingKey: '~/.ssh/id_ed25519.pub',
                hostingAccount: null,
              },
              {
                id: 'p2',
                name: '개인',
                userName: 'devkim',
                userEmail: 'devkim@example.com',
                signingKey: null,
                hostingAccount: null,
              },
            ],
          });
        });
        await h.visible('dialog[open] input');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'ssh-keys',
      scene: 'repo',
      // 팔레트 → SSH 키…. 목은 ~/.ssh 가 비어 있어 키 목록 대신 안내가 보이고, 키 만들기·호스팅 등록 구역이 보인다
      steps: async (page, h) => {
        await h.press(PALETTE_KEY);
        await h.visible('[cmdk-dialog] [cmdk-item]');
        await h.type('SSH 키');
        await h.click(page.locator('[cmdk-item]').filter({ hasText: 'SSH 키…' }).first());
        await h.visible('dialog[open] input');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'folder-settings',
      scene: 'folder',
      // 폴더 탭 Project 머리의 폴더 설정… → 폴더 설정 대화상자. 일괄 작업에서 뺄 저장소에 예를 하나 적는다
      steps: async (page, h) => {
        await h.click('[data-panel="project"] button[title="폴더 설정…"]');
        await h.visible('dialog[open] input');
        await page.locator('dialog[open] input').first().fill('infra-scripts');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    // ── 편집기·여러 저장소 개선에서 생긴 화면 ──
    {
      name: 'home-lists',
      scene: 'folder',
      // 사용법 1.4: 시작 화면의 그룹·즐겨찾기·최근 묶음. 툴바의 저장소 열기로 시작 화면을 연다. 폴더 장면에는 그룹 하나
      // (사라진 멤버 포함)가 있고, 목의 최근 목록은 늘 비어 있어 폴더 하나(즐겨찾기)와 저장소 셋을 앱 상태에 넣는다
      steps: async (page, h) => {
        await h.click(h.button('저장소 열기', 'header'));
        await h.visible('section[aria-label="그룹"] li');
        const at = Date.parse('2025-10-28T06:20:00+09:00');
        await page.evaluate(async (t) => {
          const app = await window.__mgitModule('/src/store/app-store-instance.ts');
          const entry = (path, kind, pinned, ago) => ({
            path,
            kind,
            name: path.slice(path.lastIndexOf('/') + 1),
            pinned,
            lastOpenedAt: t - ago,
          });
          app.useAppStore.setState({
            recent: [
              entry('/mock/acme-platform', 'folder', true, 0),
              entry('/mock/storefront-web', 'repo', false, 40 * 60_000),
              entry('/mock/tools/release-scripts', 'repo', false, 26 * 3_600_000),
              entry('/mock/oss/markdown-lint', 'repo', false, 3 * 86_400_000),
            ],
          });
        }, at);
        await h.visible('section[aria-label="최근"] li');
        await h.afterPaint();
      },
      clip: { selector: ['h1:has-text("시작")', 'section[aria-label="최근"]'], pad: 12 },
    },
    {
      name: 'group-dialog',
      scene: 'folder',
      // 사용법 2.9 별칭·그룹 편집: 시작 화면 그룹 줄의 ✎ → 그룹 편집 대화상자. 저장소 줄 맨 앞이 별칭 칸이고, 사라진 멤버는
      // 경로 뒤에 찾을 수 없음이 붙는다
      steps: async (_page, h) => {
        await h.click(h.button('저장소 열기', 'header'));
        await h.click('button[aria-label="그룹 편집: Platform core"]');
        await h.visible('dialog[open] input');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'group-tab',
      scene: 'folder',
      // 사용법 2.9 그룹 열기·찾을 수 없는 저장소: 시작 화면에서 Platform core 그룹을 연 그룹 탭. ◈ 탭, Project 트리의 별칭
      // 행(legacy-tools 에 찾을 수 없음), 개요 탭의 찾을 수 없는 저장소 줄이 보이게 툴바부터 편집기 영역까지 찍는다
      steps: async (page, h) => {
        await h.click(h.button('저장소 열기', 'header'));
        await h.click(page.locator('section[aria-label="그룹"] button').filter({ hasText: 'Platform core' }).first());
        await h.waitFor(() => document.querySelector('[data-panel="editor"]')?.textContent.includes('찾을 수 없는 저장소'));
        await h.waitFor(() => /갱신 \d/.test(document.querySelector('[data-panel="editor"]')?.textContent ?? ''));
        await h.visible('[data-panel="project"] [role="treeitem"]:has-text("legacy-tools")');
        await h.afterPaint();
      },
      clip: { selector: ['header', '[data-panel="project"]', '[data-panel="editor"]'], pad: 0 },
    },
    {
      name: 'clone-many-dialog',
      scene: 'none',
      // 사용법 2.4 여러 저장소 한꺼번에 clone: 시작 화면의 여러 저장소 복제… 첫 단계. 폴더 이름을 붙인 줄과 주석 줄을 섞어
      // 적는다 (주석 줄은 세지 않아 저장소 4개)
      steps: async (page, h) => {
        await h.click(h.button('여러 저장소 복제…'));
        await h.visible('dialog[open] textarea');
        await page
          .locator('dialog[open] textarea')
          .fill(
            [
              'https://git.example.com/acme/storefront-web.git',
              'https://git.example.com/acme/checkout-service.git',
              'git@git.example.com:acme/design-system.git ds',
              '# 문서는 나중에',
              'https://git.example.com/acme/docs.git',
            ].join('\n'),
          );
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'project-tree-filter',
      scene: 'repo',
      // 사용법 3.4 이름 필터: 이름으로 거르기 칸에 cart 를 적어 이름이 맞는 파일·폴더와 그 상위 폴더만 남긴다 (맞은 글자는
      // 굵은 밑줄). Project 도구 창 머리줄부터 마지막 행까지만 찍는다 — 행이 도구 창보다 넓으면 오른쪽 편집기 영역이 찍히고
      // 행 끝 상태 문자가 창 밖에 놓이므로 도구 창을 넓힌다
      storage: { 'react-resizable-panels:workspace': { 'ws-left': 40, 'ws-editor': 60 } },
      steps: async (page, h) => {
        await page.locator('[data-panel="project"] input[aria-label="이름으로 거르기"]').fill('cart');
        await h.visible('[data-panel="project"] [role="treeitem"]:has-text("CartSummary.tsx")');
        await page.evaluate(() => document.activeElement?.blur());
        await h.afterPaint();
      },
      clip: {
        selector: ['[role="toolbar"][aria-label="프로젝트"]', '[data-panel="project"] [role="treeitem"] >> nth=-1'],
        pad: 0,
      },
    },
    {
      name: 'editor-split',
      scene: 'repo',
      // 사용법 3.5 편집기 나누기: package.json·README.md 를 고정 탭으로 연 뒤 README.md 탭 우클릭 → 오른쪽 그룹으로 옮기기.
      // 오른쪽이 지금 그룹이라 그 탭 막대에 강조색 선이 보인다
      steps: async (page, h) => {
        await page.locator('[data-panel="project"] [role="tree"]').evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await h.afterPaint();
        await h.projectRow('package.json').dblclick();
        await h.projectRow('README.md').dblclick();
        await h.waitFor(() => document.querySelectorAll('[data-panel="editor"] [role="tab"]').length === 2);
        await page
          .locator('[data-panel="editor"] [role="tab"]')
          .filter({ hasText: 'README.md' })
          .first()
          .click({ button: 'right' });
        await h.click(h.menuItem('오른쪽 그룹으로 옮기기'));
        await h.waitFor(() => document.querySelectorAll('[data-panel="editor"] [role="tablist"]').length === 2);
        await h.afterPaint();
      },
      clip: '[data-panel="editor"]',
    },
    {
      name: 'editor-encoding-menu',
      scene: 'repo',
      // 사용법 3.5 UTF-8 이 아닌 파일: package.json 을 고정 탭으로 열고 위 줄의 인코딩 단추(UTF-8)를 눌러 다른 인코딩으로
      // 다시 열기 메뉴를 펼친다. 편집기 탭 막대부터 메뉴 아래까지 찍는다
      steps: async (page, h) => {
        await page.locator('[data-panel="project"] [role="tree"]').evaluate((el) => {
          el.scrollTop = el.scrollHeight;
        });
        await h.afterPaint();
        await h.projectRow('package.json').dblclick();
        await h.click('[data-panel="editor"] button[aria-label^="인코딩"]');
        await h.visible('[role="menu"]');
        await h.afterPaint();
      },
      // 여백을 두면 왼쪽 Project 도구 창 경계가 걸린다
      clip: { selector: ['[data-panel="editor"] [role="tablist"]', '[role="menu"]'], pad: 0 },
    },
    {
      name: 'mixed-eol',
      scene: 'folder',
      // 사용법 3.5 줄 끝이 섞인 파일: 폴더 장면의 samples/legacy-build.bat (CRLF 4줄·LF 2줄)을 열면 읽기 전용 내용과 위 줄
      // 아래의 띠(LF로 통일해 편집·CRLF로 통일해 편집)가 보인다
      steps: async (_page, h) => {
        await h.click(h.projectRow('samples'));
        await h.click(h.projectRow('legacy-build.bat'));
        await h.visible('[data-panel="editor"] button:has-text("LF로 통일해 편집")');
        await h.afterPaint();
      },
      clip: '[data-panel="editor"]',
    },
    {
      name: 'folder-commit-messages',
      scene: 'folder',
      // 사용법 4.2 저장소마다 다른 메시지로 commit 하기: 폴더 탭 Commit 도구 창에 공통 메시지를 적고 대상 줄(저장소 N개 ·
      // 파일 M개)을 눌러 저장소별 커밋 메시지 창을 연다. web-console 에만 따로 메시지를 적는다
      storage: {
        'mgit.leftTool': { tool: 'commit' },
        'mgit.bottomDock': { tool: null },
        'react-resizable-panels:workspace': { 'ws-left': 30, 'ws-editor': 70 },
      },
      ready: () => document.querySelector('[data-panel="commit"] [role="treeitem"]'),
      steps: async (page, h) => {
        const pop = '[role="dialog"][aria-label="저장소별 커밋 메시지"]';
        await page.locator('[data-panel="commit"] textarea').fill('feat: 로그인 시도 횟수 제한');
        await h.click(
          page
            .locator('[data-panel="commit"] button')
            .filter({ hasText: /^\s*저장소 \d+개 · 파일 \d+개/ })
            .first(),
        );
        await h.visible(`${pop} textarea`);
        await page.locator(`${pop} textarea`).nth(1).fill('feat(web): 로그인 제한 안내 문구 추가');
        await h.afterPaint();
      },
      clip: {
        selector: ['[role="dialog"][aria-label="저장소별 커밋 메시지"]', '[data-panel="commit"] button:has-text("커밋 후 푸시…")'],
        // 위쪽 여백을 두면 창 뒤에 가려진 공통 메시지 칸 글자가 반쯤 찍힌다
        pad: 0,
      },
    },
    {
      name: 'folder-stash-save',
      scene: 'folder',
      // 사용법 4.7 폴더 탭에서 한꺼번에 stash 하기 — 저장: 개요 탭 일괄 줄의 스태시 저장… 대화상자에 메시지를 적는다
      steps: async (page, h) => {
        await openOverviewDialog(page, h, '스태시 저장…');
        await page.locator('dialog[open] input:not([type="checkbox"])').first().fill('로그인 제한 작업 잠시 치우기');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'folder-stash-pop',
      scene: 'folder',
      // 사용법 4.7 — 꺼내기: 목에는 묶음 stash 가 없어 먼저 스태시 저장… 으로 한 묶음을 실제로 저장한 뒤(변경이 있는 목
      // 저장소 셋이 저장된다) 스태시 꺼내기… 의 체크 목록을 연다. 저장 결과 알림은 닫는다
      steps: async (page, h) => {
        await openOverviewDialog(page, h, '스태시 저장…');
        await page.locator('dialog[open] input:not([type="checkbox"])').first().fill('로그인 제한 작업 잠시 치우기');
        await h.click(h.button('저장', 'dialog[open]'));
        await h.waitFor(() => document.querySelector('[role="status"]')?.textContent.includes('스태시 일괄 저장'));
        await clearToasts(page);
        await openOverviewDialog(page, h, '스태시 꺼내기…');
        await h.visible('dialog[open] input[type="checkbox"]');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'run-command-dialog',
      scene: 'folder',
      // 사용법 5.10 여러 저장소에서 git 명령 실행하기: 개요 탭 일괄 줄의 명령 실행… → git 명령 실행 창 (대상 전체)
      steps: async (page, h) => {
        await openOverviewDialog(page, h, '명령 실행…');
        await page.locator('dialog[open] input').first().fill('status -sb');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open]', pad: 8 },
    },
    {
      name: 'task-history-command',
      scene: 'folder',
      // 사용법 5.10 결과 보기: 명령 실행… 으로 status -sb 를 전체 저장소에 돌린 뒤 열리는 Git 도구 창 작업 기록 탭. 맨 위 줄이
      // 펼쳐져 저장소마다 종료 코드·표준 출력이 보인다. 결과 알림은 닫는다
      steps: async (page, h) => {
        await openOverviewDialog(page, h, '명령 실행…');
        await page.locator('dialog[open] input').first().fill('status -sb');
        await h.click(h.button('실행', 'dialog[open]'));
        await h.waitFor(() => document.querySelector('[role="status"]')?.textContent.includes('명령 실행'));
        await clearToasts(page);
        await h.visible('section[aria-label="작업 기록"] button:has-text("모든 저장소 출력 복사")');
        await h.afterPaint();
      },
      clip: { selector: ['[role="tablist"][aria-label="Git"]', 'section[aria-label="작업 기록"]'], pad: 0 },
    },
    {
      name: 'replace-preview',
      scene: 'repo',
      // 사용법 9.3 여러 파일 바꾸기: ⌘⌥F 내용 검색에서 Math.round 를 src/features/cart 경로로 좁혀 찾고 바꿀 내용
      // roundHalfEven 을 적어 바꾸기… → 여러 파일 바꾸기 미리보기 창 (파일 3개·일치 3개)
      steps: async (page, h) => {
        await h.press('Meta+Alt+F');
        await h.visible('input[aria-label="검색어"]');
        await page.locator('input[aria-label="검색어"]').fill('Math.round');
        await page.locator('input[aria-label="경로 필터"]').fill('src/features/cart');
        await h.waitFor(() => document.body.textContent.includes('3개 결과'));
        await page.locator('input[aria-label="바꿀 내용"]').fill('roundHalfEven');
        await h.click(h.button('바꾸기…'));
        await h.visible('dialog[open][aria-label="여러 파일 바꾸기"] input[type="checkbox"]');
        await h.afterPaint();
      },
      clip: { selector: 'dialog[open][aria-label="여러 파일 바꾸기"]', pad: 8 },
    },
  ];

  // ── 장면 준비 ──────────────────────────────────────────────────────────────────

  /** 저장소 탭이 그려졌는지 (로그 칸의 첫 그래프 행) */
  const repoReady = () =>
    document.querySelector('[data-panel="git-log"] [data-testid="graph-scroller"] [data-oid]');
  /** 장면별로 첫 화면이 다 그려졌는지 묻는 페이지 안 조건 */
  const READY = {
    none: () =>
      !document.querySelector('[data-session-tab]') &&
      [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '복제…'),
    folder: () =>
      document.querySelector('[data-panel="project"] [role="treeitem"]') &&
      document.querySelector('[data-panel="git-log"] [data-testid="graph-scroller"] [data-oid]'),
    repo: repoReady,
    conflict: repoReady,
  };

  // ── helper (bench/frontend-measure.js 의 것을 Playwright 쪽으로 옮긴 것) ──────────────────────

  /** 정규식 특수 문자를 글자 그대로로 */
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  /** 앞뒤 공백을 빼고 글자가 꼭 그것인지 보는 정규식 */
  const exact = (s) => new RegExp(`^\\s*${escapeRe(s)}\\s*$`);
  /** 앞뒤 공백을 빼고 그 글자로 시작하는지 보는 정규식 (뒤에 개수 배지가 붙는 탭 등) */
  const prefix = (s) => new RegExp(`^\\s*${escapeRe(s)}`);

  /** 대상(선택자 문자열 · { css, text } · Locator)을 Locator 로 */
  function locatorOf(target) {
    if (typeof target === 'string') {
      return page.locator(target).first();
    }
    if (target && typeof target === 'object' && 'css' in target) {
      return page.locator(target.css).filter({ hasText: exact(target.text) }).first();
    }
    return target;
  }

  /** steps 에 넘기는 helper 묶음 */
  const h = {
    /** 잠깐 쉰다 (기다릴 조건이 없을 때만) */
    pause: (ms) => page.waitForTimeout(ms),
    /** 지금 걸린 그리기가 화면에 나간 뒤 (두 번째 rAF) */
    afterPaint: () =>
      page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      ),
    /** 페이지 안 조건이 참이 될 때까지 기다린다 */
    waitFor: (pred, arg, timeout = 20_000) => page.waitForFunction(pred, arg, { timeout }),
    /** 선택자 요소가 보일 때까지 기다린다 */
    visible: (selector, timeout = 20_000) =>
      page.locator(selector).first().waitFor({ state: 'visible', timeout }),
    /** 대상을 누른다 (실제 마우스 이벤트 — 보이게 스크롤하고 누를 수 있을 때까지 기다린다) */
    click: (target) => locatorOf(target).click(),
    /** 대상을 우클릭한다 (맥락 메뉴) */
    rightClick: (target) => locatorOf(target).click({ button: 'right' }),
    /** 단축키 (예: PALETTE_KEY 커맨드 팔레트, 'Meta+B' 브랜치 전환) */
    press: (keys) => page.keyboard.press(keys),
    /** 지금 초점에 글자를 친다 */
    type: (text) => page.keyboard.type(text),
    /** 왼쪽 도구 창 띠의 단추 (Project·Commit·Pull Requests) */
    stripe: (name) =>
      page.locator(`${STRIPE} button[aria-label="${name}"], ${STRIPE} button[title="${name}"]`).first(),
    /** 접근성 이름(aria-label·title) 또는 글자가 그것인 단추 */
    button: (name, within = 'body') =>
      page
        .locator(`${within} button[aria-label="${name}"], ${within} button[title="${name}"]`)
        .or(page.locator(`${within} button`).filter({ hasText: exact(name) }))
        .first(),
    /** 그 글자로 시작하는 탭 (Git 도구 창의 로그·콘솔, Commit 도구 창의 변경·Stash 등) */
    tab: (name, within = 'body') =>
      page.locator(`${within} [role="tab"]`).filter({ hasText: prefix(name) }).first(),
    /** 열린 메뉴의 그 글자 항목 */
    menuItem: (name) => page.locator('[role="menuitem"]').filter({ hasText: exact(name) }).first(),
    /** Project 트리의 그 이름 행 (이름 칸 글자가 같은 것, 그려진 행 중에서) */
    projectRow: (name) =>
      page
        .locator('[data-panel="project"] [role="treeitem"]')
        .filter({ has: page.locator('span[title]', { hasText: exact(name) }) })
        .first(),
    /** 대상(선택자 · { css, text } · Locator)의 Locator */
    locatorOf,
    /** 지금 탭 세션 상태의 값 하나 (페이지 안 스토어에서 읽는다). 세션이 없으면 null */
    sessionValue: (key) =>
      page.evaluate(async (k) => {
        const registry = await window.__mgitModule('/src/store/session-registry.ts');
        const app = await window.__mgitModule('/src/store/app-store-instance.ts');
        const store = registry.getSessionStore(app.useAppStore.getState().activeSessionId);
        return store ? (store.getState()[k] ?? null) : null;
      }, key),
    /** 지금 탭의 세션 상태를 덮어쓴다 (setState — 목이 못 보이는 상태를 그림에 넣을 때). 세션이 없으면 던진다 */
    patchSession: (patch) =>
      page.evaluate(async (p) => {
        const registry = await window.__mgitModule('/src/store/session-registry.ts');
        const app = await window.__mgitModule('/src/store/app-store-instance.ts');
        const store = registry.getSessionStore(app.useAppStore.getState().activeSessionId);
        if (!store) {
          throw new Error('지금 탭의 세션이 없다');
        }
        store.setState(p);
      }, patch),
  };

  /**
   * 브랜치 칸에서 원격 tag 상태를 켠다 (사용법 3.8·4.4·5.4 그림): `collapse` 묶음을 접고, 태그 묶음 행 끝의 원격 tag 확인을
   * 눌러 묶음 요약이 나올 때까지 기다린 뒤, `expand` 가 false 가 아니면 태그 묶음을 펼친다
   */
  async function showTreeTagStatus(page, h, { collapse = [], expand = true } = {}) {
    const pane = '[data-panel="git-branches"]';
    const group = (name) =>
      page.locator(`${pane} [role="treeitem"][aria-level="1"]`).filter({ hasText: prefix(name) }).first();
    for (const name of collapse) {
      if ((await group(name).getAttribute('aria-expanded')) === 'true') {
        await group(name).click();
      }
    }
    await h.click(`${pane} button[aria-label="원격 태그 확인"]`);
    await h.waitFor(() => {
      const row = [...document.querySelectorAll('[data-panel="git-branches"] [role="treeitem"]')].find((t) =>
        t.textContent.trim().startsWith('태그'),
      );
      return row?.textContent.includes('원격에만') && !row.textContent.includes('확인 중');
    });
    if (expand && (await group('태그').getAttribute('aria-expanded')) !== 'true') {
      await group('태그').click();
    }
  }

  /** 상세 칸이 고른 커밋의 변경 파일과 "브랜치 N개에 포함" 줄까지 다 읽을 때까지 기다린다 */
  async function waitDetailLoaded(h) {
    await h.waitFor(() => {
      const text = document.querySelector('[data-panel="git-detail"]')?.textContent ?? '';
      return text.includes('변경 파일') && !text.includes('읽는 중') && !text.includes('불러오는 중');
    });
  }

  /**
   * 페이지 안 앱 모듈 도우미 (페이지 함수 — 문서를 열 때마다 init 스크립트로 심는다). `window.__mgitModule(경로 끝)` 은 그
   * 모듈을 앱이 실제로 실은 주소(리소스 목록에서 경로가 그것으로 끝나는 마지막 것)로 가져온다. 개발 서버가 떠 있는 동안
   * 소스가 HMR 되면 앱은 모듈을 `?t=…` 가 붙은 주소로 싣는다 — 맨 경로(`/src/store/app-store-instance.ts`)로 가져오면 따로
   * 실린 다른 인스턴스(빈 스토어)라 상태 읽기·쓰기, 설정 저장 비우기, 알림 닫기가 조용히 헛돈다. 앱이 실은 적이 없으면
   * `fallback` 이 true 일 때만 그 경로 그대로 가져오고 아니면 null. 리소스 목록은 기본 250개에서 차 뒤에 실린 모듈이 빠지므로
   * 크기를 늘린다 (페이지 스크립트보다 먼저 도는 init 스크립트에서)
   */
  function installModuleHelper() {
    performance.setResourceTimingBufferSize(20_000);
    window.__mgitModule = (suffix, fallback = true) => {
      const loaded = performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => new URL(name).pathname.endsWith(suffix))
        .at(-1);
      if (loaded) return import(loaded);
      return fallback ? import(suffix) : Promise.resolve(null);
    };
  }

  /** 떠 있는 알림(토스트)을 모두 닫는다 — 일괄 작업을 실제로 돌린 그림에서 결과 알림이 내용을 가리지 않게 */
  async function clearToasts(page) {
    await page.evaluate(async () => {
      const app = await window.__mgitModule('/src/store/app-store-instance.ts');
      for (const t of app.useAppStore.getState().toasts) {
        app.useAppStore.getState().dismissToast(t.id);
      }
    });
  }

  /**
   * 폴더 탭 개요 탭 일괄 줄의 단추를 눌러 그 대화상자를 연다. 개요가 다 읽은 뒤(머리줄의 갱신 시각) 누르고, 창이 안 뜨면 한 번
   * 더 누른다. 첫 클릭에 창이 안 뜬 것은 2026-11-27 전체 촬영에서 한 번 봤고 원인은 모른다 — 갱신 전 클릭·늦게 읽은 요약은
   * 목 화면에서 재현되지 않았다. 앱 쪽에서 같은 증상을 내던 분할 되살리기의 개요 재마운트는 고쳤다. 재시도는 그대로 둔다
   */
  async function openOverviewDialog(page, h, name) {
    await h.waitFor(() => /갱신 \d/.test(document.querySelector('[data-panel="editor"]')?.textContent ?? ''));
    for (let attempt = 0; attempt < 2; attempt++) {
      await h.click(h.button(name, '[data-panel="editor"]'));
      const opened = await page
        .locator('dialog[open]')
        .first()
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(
          () => true,
          () => false,
        );
      if (opened) {
        return;
      }
    }
    throw new Error(`${name} 창이 뜨지 않았다`);
  }

  /** 커맨드 팔레트에서 글자가 꼭 그것인 명령을 실행한다 */
  async function runPalette(page, h, name) {
    await h.press(PALETTE_KEY);
    await h.visible('[cmdk-input]');
    await h.type(name);
    await h.click(page.locator('[cmdk-item]').filter({ hasText: exact(name) }).first());
  }

  /**
   * 모든 원격의 tag 를 확인하고(팔레트 "원격 tag 확인") 태그 문서를 연다(팔레트 "tag 관리"). 필터 단추가 켜질 때까지
   * 기다린다 (사용법 5.4 그림들). 문서의 처음 원격은 origin 이다 (목 장면에 업스트림이 없다)
   */
  async function openCheckedTagsDoc(page, h) {
    await runPalette(page, h, '원격 태그 확인');
    for (;;) {
      const reports = await h.sessionValue('tagReports');
      const checking = await h.sessionValue('tagChecking');
      if (Object.keys(reports ?? {}).length === 2 && (checking ?? []).length === 0) {
        break;
      }
      await h.pause(100);
    }
    await runPalette(page, h, '태그 관리');
    await h.visible('[data-panel="editor"] [role="listbox"][aria-label="태그 목록"]');
    await h.waitFor(() =>
      [...document.querySelectorAll('[data-panel="editor"] button')].some(
        (b) => /^로컬에만 \d/.test(b.textContent.trim()) && !b.disabled,
      ),
    );
  }

  /** 태그 문서에서 이름이 그것인 줄들을 고른다 (첫 줄은 클릭, 나머지는 ⌘ 클릭) */
  async function pickTags(page, names) {
    for (const [i, name] of names.entries()) {
      await page
        .locator('[data-panel="editor"] [role="option"]')
        .filter({ hasText: prefix(name) })
        .first()
        .click(i === 0 ? {} : { modifiers: ['Meta'] });
    }
  }

  // ── 찍기 ──────────────────────────────────────────────────────────────────────

  /**
   * 지금 앱이 미뤄 둔 설정 저장(고정 파일 탭 복원 목록 등)을 끝낸다. 남겨 두면 새로 고칠 때 beforeunload 확인창이 뜨고,
   * 내리면서 보낸 저장이 아래 설정 초기화를 덮어 다음 그림에 앞 그림의 탭이 되살아난다. 앱이 실은 인스턴스(`__mgitModule`)를
   * 비워야 한다 — 다른 인스턴스를 비우면 아무 일도 하지 않는다. 앱이 저장 모듈을 싣지 않은 문서면 건너뛴다
   */
  async function settleApp() {
    await page.evaluate(async () => {
      const storage = await window.__mgitModule('/packages/storage/src/index.ts', false);
      if (!storage) {
        return;
      }
      const tabs = await window.__mgitModule('/src/store/editor-tabs-persist.ts');
      tabs.flushEditorTabSaves();
      await storage.flushSettings();
    });
  }

  /** 환경별 설정을 비우고 공통값·장면·그림별 값을 넣은 뒤 새로 고쳐 장면이 준비될 때까지 기다린다 */
  async function load(shot) {
    if (page.url().startsWith(BASE)) {
      await settleApp();
    } else {
      await page.goto(BASE);
    }
    const storage = {
      'mgit.theme': 'dark',
      'mgit.language': 'ko',
      'mgit.mock.gitVersion': GIT_VERSION,
      'mgit.mock.scene': shot.scene,
    };
    for (const [key, value] of Object.entries(shot.storage ?? {})) {
      storage[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    await page.evaluate(async (entries) => {
      const response = await fetch('/__mgit/settings');
      if (!response.ok) throw new Error('설정 조회 실패');
      const previous = await response.json();
      for (const key of new Set([...Object.keys(previous), ...Object.keys(entries)])) {
        const result = await fetch('/__mgit/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value: entries[key] ?? null }),
        });
        if (!result.ok) throw new Error('설정 저장 실패');
      }
    }, storage);
    await page.reload();
    const scene = await page.evaluate(async () => (await (await fetch('/__mgit/settings')).json())['mgit.mock.scene']);
    if (scene !== shot.scene) {
      throw new Error(`새로 고친 뒤 장면 값이 다르다: ${scene}`);
    }
    await page.waitForFunction(shot.ready ?? READY[shot.scene], null, { timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
  }

  /** 번호 표식을 페이지 위 fixed 레이어에 그린다 (앱 DOM 밖). 대상이 없으면 던진다 */
  async function drawMarkers(markers) {
    const missing = await page.evaluate((list) => {
      const SIZE = 24;
      const INSET = 4;
      const find = (t) =>
        typeof t === 'string'
          ? document.querySelector(t)
          : [...document.querySelectorAll(t.css)].find((e) => e.textContent.trim() === t.text);
      const layer = document.createElement('div');
      layer.id = '__docs-shots-markers';
      layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
      const lost = [];
      for (const m of list) {
        const el = find(m.target);
        if (!el) {
          lost.push(m.n);
          continue;
        }
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2 - SIZE / 2;
        const cy = r.top + r.height / 2 - SIZE / 2;
        const spots = {
          tl: [r.left + INSET, r.top + INSET],
          tr: [r.right - INSET - SIZE, r.top + INSET],
          bl: [r.left + INSET, r.bottom - INSET - SIZE],
          br: [r.right - INSET - SIZE, r.bottom - INSET - SIZE],
          c: [cx, cy],
          l: [r.left - INSET - SIZE, cy],
          r: [r.right + INSET, cy],
          t: [cx, r.top - INSET - SIZE],
          b: [cx, r.bottom + INSET],
        };
        const [x0, y0] = spots[m.at ?? 'tl'] ?? spots.tl;
        const x = Math.min(Math.max(0, x0 + (m.dx ?? 0)), innerWidth - SIZE);
        const y = Math.min(Math.max(0, y0 + (m.dy ?? 0)), innerHeight - SIZE);
        const dot = document.createElement('div');
        dot.textContent = String(m.n);
        dot.style.cssText = [
          'position:absolute',
          `left:${Math.round(x)}px`,
          `top:${Math.round(y)}px`,
          `width:${SIZE}px`,
          `height:${SIZE}px`,
          'box-sizing:border-box',
          'border-radius:50%',
          'border:2px solid #fff',
          'background:#e5484d',
          'color:#fff',
          'font:700 13px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
          'text-align:center',
          'box-shadow:0 1px 4px rgba(0,0,0,.6)',
        ].join(';');
        layer.append(dot);
      }
      document.body.append(layer);
      return lost;
    }, markers);
    if (missing.length > 0) {
      throw new Error(`표식 대상 없음: ${missing.join(', ')}`);
    }
  }

  /**
   * 상태 바 왼쪽 끝의 개발 실행 이름(`mGit Dev · <checkout>`)을 숨긴다 — 개발 서버에서만 보이는 글자라 사용자 화면과 다르다.
   * 그 칸은 창 제목과 글자가 같다 (앱 DOM 은 그대로 두고 그 요소만 가린다)
   */
  const hideProfileLabel = () =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll('footer span')) {
        if (el.textContent === document.title) {
          el.style.display = 'none';
        }
      }
    });

  /** 표식 레이어를 지운다 */
  const clearMarkers = () =>
    page.evaluate(() => document.getElementById('__docs-shots-markers')?.remove());

  /** clip 설정을 화면 좌표 사각형으로 (null 이면 창 전체). 선택자가 여럿이면 모두를 덮는 사각형 */
  async function clipOf(clip) {
    if (!clip) {
      return null;
    }
    const { selector, pad = 0 } = typeof clip === 'string' ? { selector: clip } : clip;
    const selectors = Array.isArray(selector) ? selector : [selector];
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (const sel of selectors) {
      const box = await page.locator(sel).first().boundingBox();
      if (!box) {
        throw new Error(`clip 대상 없음: ${sel}`);
      }
      left = Math.min(left, box.x);
      top = Math.min(top, box.y);
      right = Math.max(right, box.x + box.width);
      bottom = Math.max(bottom, box.y + box.height);
    }
    const x = Math.max(0, Math.floor(left - pad));
    const y = Math.max(0, Math.floor(top - pad));
    return {
      x,
      y,
      width: Math.min(VIEW.width, Math.ceil(right + pad)) - x,
      height: Math.min(VIEW.height, Math.ceil(bottom + pad)) - y,
    };
  }

  /** 그림 하나: 불러오기 → steps → 표식 → 찍기 */
  async function shoot(shot) {
    await load(shot);
    if (shot.steps) {
      await shot.steps(page, h);
    }
    if (shot.rest?.menuItem) {
      await h.menuItem(shot.rest.menuItem).hover();
    } else {
      await page.mouse.move(REST.x, REST.y);
    }
    await h.afterPaint();
    await hideProfileLabel();
    if (shot.markers?.length) {
      await drawMarkers(shot.markers);
    }
    try {
      const clip = await clipOf(shot.clip);
      const file = `${OUT_DIR}/${shot.name}.png`;
      const png = await page.screenshot({
        path: file,
        type: 'png',
        scale: 'css',
        animations: 'disabled',
        caret: 'hide',
        ...(clip ? { clip } : {}),
      });
      return {
        name: shot.name,
        file,
        width: clip?.width ?? VIEW.width,
        height: clip?.height ?? VIEW.height,
        bytes: png.length,
      };
    } finally {
      await clearMarkers();
    }
  }

  // ── 실행 ──────────────────────────────────────────────────────────────────────
  // 앱 모듈 도우미: 앞으로 열 문서마다(init 스크립트) + 지금 문서에 (`installModuleHelper`)
  await page.addInitScript(installModuleHelper);
  await page.evaluate(installModuleHelper);
  await page.setViewportSize(VIEW);
  await page.emulateMedia({ colorScheme: 'dark' });
  const done = [];
  const failed = [];
  for (const shot of SHOTS) {
    if (ONLY.length > 0 && !ONLY.includes(shot.name)) {
      continue;
    }
    try {
      done.push(await shoot(shot));
    } catch (e) {
      failed.push({ name: shot.name, error: String(e?.message ?? e).slice(0, 500) });
    }
  }
  // 촬영 마지막 설정은 해당 checkout의 웹 설정에만 남긴다.
  return { done, failed };
}
