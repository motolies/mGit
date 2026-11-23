# Phase 0 PoC 결과 — 첫 구현 반복 (2026-10-28)

명세 5절 Phase 0 가운데 **프로젝트 골격 + 커밋 그래프 수직 슬라이스**를 구현하고 PoC-1·PoC-2를 측정한 기록이다. PoC-3(3-way 편집기)·PoC-4(한글 입력)·PoC-5(프로세스·인증)는 다음 반복에서 한다.

## 환경

| 항목 | 값 |
|---|---|
| 기기 | macOS (Apple Silicon), Darwin 27.0 |
| git | 2.54.0 (Apple Git-157), `/usr/bin/git` 은 xcrun 실경로로 치환 |
| Rust | stable 1.97.1 (edition 2024), MSRV 1.90 |
| Node / pnpm | 24.16.0 / 11.20.0 |
| 주요 버전 | tauri 2.12.x, tauri-specta 2.0.0-rc.26 (+ specta rc.26, specta-typescript 0.0.13 `=` 핀), React 19.3.1, Vite 8.3.5, TypeScript 7.0.2, Biome 2.6.3, Vitest 5.0.5, Zustand 5.0.16, @tanstack/react-virtual 3.14.23, react-resizable-panels 4.15.0 |

## 구현 범위

```
저장소 열기(dialog) → git rev-parse 판별 → HEAD·for-each-ref 로드
  → git log --all --topo-order -z 스트리밍 → mgit-graph 레인 배정(조기 합류, O(n+e))
  → graph_window(session, start, count) 로 보이는 범위만 IPC → 캐시(청크 500, LRU 64)
  → Canvas 2D 레인·곡선·노드 + DOM 텍스트 열(react-virtual) + ref 배지
```

| 영역 | 산출물 | 테스트 |
|---|---|---|
| `crates/mgit-model` | Oid, CommitRecord, RefLabel/HeadState, GitVersion, EnvProfile, `GitRunner`/`GitStream` 포트, NulFramer | 11 |
| `crates/mgit-graph` | `GraphLayout`(push/finish/window), 레인 구간 + 256행 청크 인덱스, 불변식 검사기 | 10 + proptest 4 |
| `crates/mgit-git` | git 탐색, 환경 변수 정책, `TokioGitRunner`(세마포어 8, 프로세스 그룹 kill), log/refs 파서, discover/head/refs/log 명령 | 23 (+1 ignored) |
| `crates/mgit-testkit` | 결정적 저장소 생성기(7개 시나리오) | 7 |
| `crates/mgit-core` | `Core`(open_repo/graph_window/close_repo), CommitTable(컬럼형), 로드 파이프라인, `EventSink` | 10 |
| `apps/desktop/src-tauri` | 커맨드 4개, Channel 싱크, DTO·From 변환, specta → `bindings.ts` | 4 (실제 저장소 열기 포함) |
| `packages/ipc` | IpcClient, GraphRangeCache, GraphSource, 목 클라이언트·합성 그래프 | 10 |
| `packages/graph-view` | GraphView, draw-list(순수), paint, palette, useFrameStats | 12 |
| `apps/desktop/src` | 3단 레이아웃(패널 폭 저장), 툴바, 상태 바, 테마(라이트·다크·시스템), Zustand store | 9 |
| `bench/` | `setup.sh`, `mgit-bench` 하네스 | — |

합계: Rust 69, Vitest 35. `cargo clippy --workspace --all-targets -- -D warnings`, `pnpm check` 통과.

## PoC-1 대형 저장소 그래프 — **통과**

측정: `cargo run --release -p mgit-bench -- --repo bench/repos/git [--no-commit-graph]`, git/git 85,868 커밋, 3회 중 최솟값.

| 조건 | 첫 청크(500행) | 전체 로드 | RSS | 레인 | 구간 | 엣지 | `graph_window` |
|---|---|---|---|---|---|---|---|
| commit-graph 있음 | **72ms** (콜드 199ms) | 591ms | **34MB** | 157 | 13,738 | 35,370 | 50~80µs |
| commit-graph 없음 | 375ms | 510ms | 32MB | 157 | 13,738 | 35,370 | 50~80µs |

- 기준: commit-graph 있음 기준 10만 커밋 첫 화면 ≤ 1초, 메모리 ≤ 500MB → **둘 다 여유 있게 통과**.
- 레인 폭 157은 명세 2.3 사전 측정(git/git 157)과 일치한다. 구간 수 13,738은 명세 추정(8.6만)보다 훨씬 적다 — 조기 합류 규칙으로 레인이 바로 닫히기 때문이다.
- commit-graph 없음에서 첫 청크가 5배 느린 이유: 세대 번호가 없으면 `--topo-order` 가 전체 워크를 끝낸 뒤 출력한다. `GraphLoadFinished.commit_graph_suggested` 로 AD-03 제안에 연결했다.
- 미측정: rust-lang/rust·linux(`bench/setup.sh rust|linux` 로 추가 가능), Windows 수치, "외부 커밋 2초 안 반영"(파일 감시 `mgit-watch` 는 다음 반복).

## PoC-2 그래프 렌더링 — **참고 측정 통과, WKWebView 실측 대기**

목 모드(`VITE_MGIT_MOCK=100000`) 10만 행, DPR 2, 뷰포트 1354px.

| 엔진 | 측정 | 결과 |
|---|---|---|
| Chromium (Playwright 헤드리스, 참고용) | 2.5초 연속 스크롤 + 무작위 점프 10회, 477프레임 | p50 8.3ms, **p95 10.1ms, p99 16.8ms**, max 33.1ms. DOM 행 65~74개로 일정, 스켈레톤 0행 |
| WKWebView (Safari / Tauri 창) | **사용자 실측 필요** | — |

기준: p95 ≤ 16.7ms, p99 ≤ 33ms. Chromium 수치는 통과이지만 macOS 배포 엔진은 WKWebView이므로 아래 절차로 실측해야 판정이 확정된다.

**WKWebView 측정 절차**
1. `VITE_MGIT_MOCK=100000 pnpm -F @mgit/desktop dev:web` → Safari에서 `http://localhost:1420` (Tauri 창은 `VITE_MGIT_MOCK=100000 pnpm dev`)
2. "저장소 열기" → 휠로 10초 연속 스크롤, 스크롤바 무작위 점프 10회
3. Web Inspector 콘솔의 `[frame-stats:graph-view] … p95=… p99=…` 확인 (스크롤이 멈추고 500ms 뒤 출력)
4. Retina 외장 모니터로 창을 옮겨 선이 번지지 않는지 확인 (`matchMedia(resolution)` 로 DPR 변경 감지)

## 계획과 달라진 점

| 항목 | 계획 | 실제 | 이유 |
|---|---|---|---|
| crate 의존 | `mgit-core` 는 `mgit-git` 을 모름 | `mgit-core → mgit-git → mgit-model` | 명령 조립·파서를 코어가 직접 쓴다. 러너는 여전히 주입. tauri 비의존은 유지 |
| 레인 배정 구조 | `LaneAssigner` + `GraphLayout` 분리 | `GraphLayout` 하나 | 윈도 조회가 둘을 동시에 참조해 소유권이 복잡해짐 |
| specta bigint | 전역 옵션 | DTO 필드별 `#[specta(type = Number)]`, `generation`·`elapsed_ms` 는 u32 | specta-typescript 0.0.13 은 전역 옵션이 없고 필드별 표시를 강제 |
| HEAD 브랜치명 | — | DTO 에서 `refs/heads/` 제거 | 상태 바에 짧은 이름 표시 |
| `rust-toolchain.toml` | `1.97.1` 고정 | `stable` (= 1.97.1) | 명명 툴체인은 별도 디렉터리로 재다운로드돼 로컬 보안 도구 예외 밖에서 SIGKILL |
| Canvas 그리기 시점 | scroll 리스너 + rAF | virtualizer 리렌더 후 effect | 가상 행과 같은 프레임에 그려져 어긋남이 없음 |

## 알려진 한계·다음 반복

- Windows 미컴파일 검증(`runner.rs` 의 `CreationFlags` 타입), `$SHELL -ilc env` PATH 확보 없음, SHA-256·bare 저장소 거부.
- 파일 감시·자동 재로드 없음(`reload_graph` 미구현, generation 배관만 존재).
- PoC-3·4·5 미착수. PoC-4(한글 IME)는 커밋 메시지 입력란이 생기는 CHG-05 와 함께 측정.
- 좌·우 패널은 placeholder. 커밋 선택·상세·diff 는 다음 반복.
- 하위 저장소를 품은 폴더(저장소 밖이거나, 저장소 안의 최상위가 아닌 폴더 — 예: gitignore 된 `bench/repos`)를 고르면 명세 3.2 의 대시보드 대신 `multiRepoFolder` 오류로 안내한다. 감지 로직(`find_child_repos`, 깊이 1)은 MR 반복에서 대시보드 입력으로 재사용한다.

## 사용자 테스트에서 발견한 버그 (2026-10-28, 수정 완료)

| 증상 | 원인 | 수정 |
|---|---|---|
| 작은 저장소를 처음 열면 스켈레톤 행만 보이고, 테마를 바꾸면 그제야 표시됨 | 첫 `graph_window` 요청이 나간 뒤 `graphLoadFinished` 가 도착해 `invalidateAll()` 로 세대가 바뀌면 응답을 "구세대"로 버리기만 하고 재요청이 없었다. 테마 변경 = 리렌더 → `ensureRange` 재실행으로 우연히 복구 | `GraphRangeCache.fetchChunk` 가 구세대 응답을 버린 직후 현재 세대로 자동 재요청 (`graph-cache.test.ts` 회귀 테스트) |
| `bench/repos` 를 열면 mGit 저장소가 열림 | `git rev-parse --show-toplevel` 이 상위 저장소를 찾는 게 git 의 정상 동작이고 명세 3.2 도 "그 저장소 + 하위 저장소 목록" 이지만 목록(MR)이 아직 없음 | 위 `multiRepoFolder` 안내 (`crates/mgit-core/tests/multi_repo.rs` 4개) |
