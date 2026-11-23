# Phase 1 (MVP) 구현 결과

작성일: 2026-10-28. 명세(`mgit-기능-명세.md`) 5절 Phase 1 = **모든 P0** 를 7개 슬라이스로 구현했다. 계획: `~/.claude/plans/lucky-tumbling-leaf.md`.

## 1. 한눈에

| 항목 | 결과 |
|---|---|
| 커밋 | 9개 (슬라이스 7 + 버그 수정 2), master, push 안 함 |
| Rust 테스트 | 174개 통과 (`cargo test --workspace`), `clippy -D warnings`·`fmt --check` 통과 |
| 프런트 테스트 | 80개 통과 (18 파일, `pnpm check` = biome + tsc + vitest) |
| 앱 스모크 | 슬라이스마다 `pnpm dev` 기동 → HTTP 200·프로세스 1·로그 오류 0 |
| 새 crate / 패키지 | `mgit-watch`, `mgit-store`, `mgit-merge`, `mgit-helper` / `@mgit/diff-view`, `@mgit/merge-editor` |
| 실기기 미확인 | PoC-3(편집기 반응·undo)·PoC-4(한글 IME)·PoC-5(인증·취소) — 3절 절차대로 사용자 확인 필요 |

## 2. 슬라이스별 산출물

| 슬라이스 | 커밋 | 기능 ID | 핵심 |
|---|---|---|---|
| S1 코어 기반 | `da4a8c8` | SF-01, RM-05 기반 | notify 감시(디바운스 150ms, 폴링 폴백) → 종류별 재조회 → 그림자 재로드; `common_dir` 쓰기 큐·`index.lock` 재시도·stderr 힌트 분류; 취소(SIGTERM→2s→SIGKILL); 명령 로그(가림); SQLite(WAL) 저장소; `Watcher`·`Store` 포트 주입 |
| S2 변경·커밋·diff | `dc6c368`, `59b7c90` | GRAPH-03, CHG-01~06, DIFF-01·02 | unified diff 파서, 부분 패치(`apply --recount`), discard 백업·복원, `commit -F -` + hook 출력 스트리밍 + 마커 검사, WIP 행, `@mgit/diff-view`(unified/split, 구문·단어 강조, 줄 선택) |
| S3 그래프·브랜치·병합 | `24f698e`, `0627e03` | GRAPH-04·05·06, BR-01~07, MRG-01~05, SF-02, AD-03 | 자식 색인, 커밋 상세, 검색, checkout(더티 → stash 후 전환), branch/tag CRUD, merge 4종·rebase·cherry-pick·revert·reset 3종, continue/skip/abort, commit-graph 제안; Radix 컨텍스트 메뉴, 사이드바, 빠른 전환, 힌트 대화상자. 그래프 `finish()` 마지막 행 엣지 버그 수정 |
| S4 원격·스태시·워크트리 | `276b744` | RM-01~06, ST-01·03·04, WT-01~05 | remote CRUD, fetch/pull(4 모드)/push(-u 자동·force-with-lease), `--progress` 파서(단계 가중 퍼센트), 자동 fetch 5분, stash push/apply/pop/drop·파일·출처, worktree add/검사/remove/prune, non-fast-forward 대화상자 |
| S5 저장소 관리·멀티·서브모듈 | `24da518` | REPO-01·02·04·05·06, MR-01~04, SUB-01~03 | 폴더 스캔(깊이 3, 종류 판별), 폴더 세션(`.git` 감시 → 대시보드 요약 동시 8개), clone(진행률·취소)·init(템플릿 6종), 최근 목록·고정, 탭 저장·복원, single-instance·window-state·DnD·CLI 인자, 서브모듈 목록/update --init, superproject 링크 |
| S6 충돌 해결 | `38dbdab` | MRG-06, CF-06~13·23·24·26 | `mgit-merge` 파서·렌더(proptest), 충돌 목록·쪽 라벨·3-way 자료·resolve_file/side/delete·unresolve 2종, `@mgit/merge-editor`(CodeMirror StateField 블록 추적, 블록 위젯, undo 1단계, F8, ⌘S, 스크롤 동기, base 숨기기), 이어서/처음부터 |
| S7 셸·UX·인증 | (이 커밋) | UX-02·03·07, AU-01·02·03, CI | askpass 본체 모드 + 로컬 소켓 + 키체인(keyring 4), 로그인 셸 PATH, 커맨드 팔레트(cmdk)·동작 레지스트리·단축키, 외부 앱(opener·프리셋), 자격 증명 대화상자, CI/빌드 워크플로, 문서 |

## 3. 수용 기준·검증

### 3.1 자동 검증 (완료)

- 외부 `git commit` → 2초 내 `GraphReloaded`: `crates/mgit-core/tests/watch.rs`.
- 쓰기 직렬화·취소 후 `index.lock` 없음: `tests/state_and_write.rs`.
- 부분 패치 왕복 == `git add`: `tests/changes.rs`.
- Ours/Theirs/둘 다 == `git merge-file --ours/--theirs/--union` (명세 3.9): `tests/conflict.rs`.
- fetch/pull/push 왕복·non-ff·진행률: `tests/sync.rs` (로컬 bare 원격, `file://`).
- 블록 선택 undo 1단계·범위 매핑·custom 전환: `packages/merge-editor/src/__tests__/editor.test.ts`.
- 그래프 불변식 I1~I10 proptest 256 케이스: `crates/mgit-graph/tests/invariants.rs`.

### 3.2 실기기 확인 절차 (사용자)

**PoC-3 충돌 편집기** — 테스트 저장소에서 `prepare_conflict` 와 같은 상황을 만든 뒤(같은 줄을 두 브랜치에서 다르게 수정, merge):
1. 우측 "충돌 N" 에서 파일 더블클릭 → 편집기. 블록 위젯 버튼(ours/theirs/둘 다)을 누르고 결과 열의 줄 경계가 어긋나지 않는지 확인(0줄 오차).
2. 버튼 → ⌘Z 한 번에 블록이 되돌아오는지, ⇧⌘Z 로 다시 적용되는지.
3. 5천 줄·충돌 40개 파일에서 버튼 반응이 50ms 안인지(체감), 스크롤이 네 열에서 같은 블록에 머무는지.
4. 저장(⌘S) 뒤 Staged 로 이동하고 Continue 가 가능한지. 마커를 손으로 남기고 저장하면 거부되는지.

**PoC-4 한글 IME** — 커밋 메시지 입력란·충돌 결과 편집기·커맨드 팔레트에서 한글·영문·숫자 혼합 200자 입력, 조합 중 Enter / ⌘↩ / Backspace / 방향키. 조합 중 ⌘↩ 로 커밋이 실행되지 않아야 한다(`isComposing`·`keyCode 229` 가드).

**PoC-5 프로세스·인증**
1. HTTPS 원격(토큰 필요)에 push → 자격 증명 대화상자 → "키체인에 저장" → 두 번째 push 는 묻지 않음. 키체인 앱에서 service `mGit` 항목 확인.
2. 암호 걸린 SSH 키로 fetch → "SSH 키 암호" 대화상자(`SSH_ASKPASS_REQUIRE=force`).
3. Finder 에서 실행한 앱에서 node 기반 pre-commit hook 이 도는지(로그인 셸 PATH).
4. 큰 저장소 clone 중 취소 → 대상 폴더가 남지 않고 `index.lock` 없음.
5. (Windows) 콘솔 창이 뜨지 않는지.

### 3.3 미측정

- 스크롤 60fps(WIP 행 추가 후)와 메모리 500MB 는 Phase 0 PoC 이후 다시 재지 않았다. `VITE_MGIT_MOCK=100000 pnpm dev` 로 `[frame-stats]` 확인 권장.

## 4. 알려진 한계·후속

| 항목 | 상태 |
|---|---|
| CI (`.github/workflows/ci.yml`, `build.yml`) | 구성만. 실행 미검증, `windows-11-arm` 러너 가용성 미확인 |
| MRG-07 (커밋 메시지·rebase todo 를 앱이 편집) | P1. 지금은 `GIT_EDITOR=true` |
| 스태시 워크트리 출처 | mGit 이 만든 것만 표시 (git 한계) |
| 팔레트 IME | `Command.Dialog` 의 onKeyDown 에서 조합 중 Enter 를 막았으나 실기기 확인 필요 |
| 폴더 대시보드 | 저장소 수백 개 규모 성능 미측정 (동시 8개 status) |
| keyring | macOS Keychain·Windows Credential Manager 는 실기기에서만 확인 가능 (테스트는 `MemoryVault`) |
| 충돌 편집기 "이어서" 모드 | 블록 추적 없이 텍스트만 편집 (버튼 없음). 처음부터 모드만 블록 위젯 제공 |
| `GIT_ASKPASS` 실행 | git 이 askpass 를 셸 없이 실행하므로 본체 경로에 공백이 있어도 된다. 환경 토큰이 있고 인자가 프롬프트 하나일 때만 askpass 모드로 들어간다 |
| 미구현 P1·P2 | 호스팅(PR·이슈), blame, 파일 히스토리, 대화형 rebase, 서명, LFS, AI 등 — 다음 계획 |

## 5. 다음 단계 제안

1. 사용자가 3.2 절차로 PoC-3·4·5 실기기 확인 → 결과를 `phase0-poc-결과.md` 형식으로 기록.
2. 실패 항목이 있으면 명세 2.1 전환 조건에 따라 대응(CodeMirror → 대안, 헬퍼 정책 수정).
3. P1 계획 수립: MRG-07(헬퍼 editor 모드), 호스팅 연동, blame/파일 히스토리, 대화형 rebase.
