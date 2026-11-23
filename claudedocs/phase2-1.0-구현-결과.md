# Phase 2 (1.0) 구현 결과

작성일: 2026-10-29. 명세(`mgit-기능-명세.md`) 5절 Phase 2 = **모든 P1(76개)** 를 4 트랙 13 슬라이스(A1~A4 → B1·B2 → C1~C3 → D1~D3 → E1)로 구현했다. 계획: `~/.claude/plans/lucky-tumbling-leaf.md`. Phase 1 결과는 `phase1-mvp-구현-결과.md`.

## 1. 한눈에

| 항목 | 결과 |
|---|---|
| 커밋 | 기능 11개 + 문서 1개 (`8f9c1e0` ~ 이 커밋), master, push 안 함 |
| Rust 테스트 | 236개 통과 (`cargo test --workspace`), `clippy --all-targets -D warnings`·`fmt --check` 통과 |
| 프런트 테스트 | 121개 통과 (31 파일, `pnpm check` = biome + tsc + vitest) |
| 앱 스모크 | 슬라이스마다 `pnpm dev` 기동 → HTTP 200·프로세스 1·로그 오류 0 |
| 변경 규모 | 235 파일, +32,531 / −334 줄 (`59f2862..7f8bcf1`) |
| 새 crate / 패키지 | `mgit-hosting`, `mgit-syntax` / `@mgit/terminal` |
| 새 의존성 | reqwest 0.13(rustls), httpmock(dev), sha2, imara-diff 0.2, tree-sitter 0.27 + 문법 8종, portable-pty 0.9, tauri-plugin-notification 2, @xterm/xterm 6 + addon-fit |
| 릴리스 빌드 | `pnpm build` 성공: `mGit.app` 44.2 MiB, `mGit_0.1.0_aarch64.dmg` 12.0 MiB (ad-hoc 서명, 공증 생략) — 6절 |
| 실기기 미확인 | 호스팅 OAuth·PR(B), 통합 터미널(D3), 서명·fsmonitor(A4), LFS 잠금(원격 필요), Phase 1 PoC-3·4·5 — 4.2 절차대로 사용자 확인 필요 |

## 2. 슬라이스별 산출물

| 슬라이스 | 커밋 | 기능 ID | 핵심 |
|---|---|---|---|
| A1 안전장치·이력 보호 | `8f9c1e0` | SF-03·04·05, AD-02, WT-08, ST-02, CHG-10, CHG-07 | 쓰기 전 ref 스냅샷 → Undo/Redo(`update-ref --stdin` 트랜잭션, ref 만 되돌림), 백업 ref `refs/mgit/backup/<branch>/<ts>`(30일 정리, 그래프에서 `--exclude='refs/mgit/*'`), 힌트별 해결 버튼(IndexLock·DetachedHead·NonFastForward·HookFailed…), reflog 복원, 워크트리 lock/unlock/prune 제안, `stash push --staged`, ignore 추가, 커밋 템플릿 |
| A2 이력 수정 | `b12e49a` | MRG-07·09, WT-06, GRAPH-09 | rebase 플랜(todo 를 코어가 만들어 `GIT_SEQUENCE_EDITOR=cp` 주입, reword 는 `exec git commit --amend -F`), 메시지 수정·아래 commit 과 합치기, 워크트리별 WIP 행, 브랜치 라벨 드래그앤드롭(merge/rebase/ff) |
| A3 diff·히스토리·그래프 | `53eb1c6` | DIFF-03~07, GRAPH-07·08·10·12 | diff 옵션(공백·문맥·줄바꿈·탭), blame(`--line-porcelain`) 거터, 파일 히스토리(`--follow`), ref 비교(`A..B`/`A...B`), difftool, 고급 검색(경로·`-S`/`-G`·날짜), 그래프 필터·경로 범위(`GraphQuery`, 그림자 재로드), ⇧클릭 범위 diff, 열 설정 |
| A4 UX·보안·설정 | `4300ec2` | UX-09·10·04, CHG-09·08, AD-07, REPO-07·03 | 토스트+OS 알림, ⌘1/2/3 패널 포커스·목록 ↑↓, 단축키 재지정(충돌 감지), 비밀 정보 스캔(gitleaks MIT 규칙 22개, `THIRD-PARTY-NOTICES.md`), 서명 커밋·`%G?` 배지, fsmonitor 제안(추적 2만 파일), 저장소 설정 대화상자, 경량 clone(`--depth`·blobless·single-branch, unshallow) |
| B1 계정·클라이언트 | `bd0c2a0` | AU-05·06·04, HO-01 | `crates/mgit-hosting`(reqwest, GitHub REST+GraphQL·GitLab REST, 디바이스 플로우·PAT, 오류 매핑, httpmock 테스트), 계정(토큰은 키체인 `hosting:<id>`), 프로필(user.name/email/signingkey 적용), SSH 키 생성·복사, 원격 저장소 탐색 → clone |
| B2 PR/MR | `7a86472` | HO-02·03·04, GRAPH-11 | PR/MR 목록(리뷰·체크·draft), 템플릿 읽기, 만들기, 체크아웃(`fetch +pull/<n>/head:refs/heads/pr/<n>`, GitLab `merge-requests/<iid>/head`), 아바타 열(Gravatar sha256·GitHub noreply id, `<data>/avatars` 캐시, data URI) |
| C1 멀티 저장소 일괄 | `9dcf19a` | MR-05~11 | 폴더 세션 일괄 fetch/pull/push/branch/worktree(동시 4, 더티·진행 중 제외, 결과 표), 통합 변경·일괄 commit, 저장소 간 검색, 루트 비재귀 감시(`FolderRescanned`), 폴더 설정 |
| C2 서브모듈 관리 | `fdf9c56` | SUB-04~11 | 포인터 변경 사이 commit 로그, 추가·채택·제거(deinit → rm → modules 삭제), 추적 branch·`update --remote`, `sync --recursive`, 일괄 fetch/pull/push, push 전 미푸시 검사, 포인터 충돌 양쪽 commit, `.git` 품은 미등록 폴더 stage 차단 |
| C3 빌드 멀티 모듈 + D1 충돌 예방 | `fae232f` | MOD-01~05, CF-01~05, MRG-08 | 모듈 감지(Gradle·Maven·npm/pnpm/yarn·Cargo·go.work, `*`/`**` 마커 파일 펼침)·수동 보정·범위 기억, 모듈별 변경 묶음; `merge-tree --write-tree` 미리보기(마커 포함 내용, WIP 는 임시 인덱스 commit), `-X` 옵션 시뮬레이터, 충돌 레이더(사이드바 배지), rebase 예측(commit 단위, 첫 충돌 뒤 근사), 격리 병합(임시 branch+워크트리 → `--ff-only` 반영/버리기) |
| D2 자동 결합·해결 보조 | `1ea5ffa` | CF-14~19·27·28·29 | 블록 분류 5종(imara-diff histogram)·자동 결합 제안, 줄 고르기, 이름 변경 충돌 묶기·한 경로로 모으기(`update-index --index-info`), 출처(`log --left-right`), 경로별 규칙(ours/theirs/union/명령), 외부 mergetool, 해결 리뷰(`merge-file --object-id` 재병합 vs 저장본, `--remerge-diff`), 해결 보관 `refs/mgit/conflict/*`·재적용·Abort 안내, rerere 가시화 |
| D3 검증·터미널·LFS | `7f8bcf1` | CF-25, UX-08, WT-07, AD-01 | `crates/mgit-syntax`(tree-sitter) 결과 vs 양쪽 오류 수 비교, 검증 명령(`sh -c`, rebase `--exec`), 통합 터미널(portable-pty + xterm 6, 탭, ⌘⇧J), 워크트리 초기화 명령(`$MGIT_WORKTREE`·`$MGIT_MAIN`), LFS(설치·추적·파일·잠금) |
| E1 마무리 | (이 커밋) | — | 이 문서, 명세 2.5·7.1·8절 갱신, 릴리스 빌드, 2주 체크리스트 |

## 3. 계획과 달라진 점

| 항목 | 계획(7.1·2절) | 구현 | 이유 |
|---|---|---|---|
| GitHub 클라이언트 | octocrab 0.54 디바이스 플로우 | **reqwest 직접 구현** (`mgit-hosting`): REST·GraphQL·디바이스 플로우·GitLab 모두 한 클라이언트 | octocrab 의 reqwest 버전·TLS 백엔드를 워크스페이스와 맞추기 어렵고, 필요한 호출이 10개 남짓이라 직접 쓰는 편이 가벼웠다 |
| 인터랙티브 rebase | 헬퍼 **editor 모드** | **todo 주입**: `GIT_SEQUENCE_EDITOR=cp '<todo>'`, reword 는 `exec git commit --amend -F` | git 이 편집기를 셸로 부르는 왕복이 필요 없고, `--fixup=reword:` 가 `-m/-F` 와 함께 안 되는 제약(2.54 실측)도 피한다 |
| 충돌 레이더 배치 | `merge-tree --stdin` 1회 | 후보마다 `merge-tree` 단건 반복 (상한 12) | `--stdin` 은 `--merge-base` 와 비호환이라 rebase 예측과 코드를 공유할 수 없었다. 후보 수가 작아 비용 차이는 없다 |
| 미리보기 WIP | `stash create` | 임시 `GIT_INDEX_FILE` 에 `add -A` → `write-tree` → `commit-tree` | `stash create` 는 untracked 를 담지 못해 add/add 충돌을 놓친다 |
| 이름 변경 충돌 (CF-16) | `ls-files -u` 경로 불일치 묶기 | base 만/ours 만/theirs 만 있는 항목을 내용 유사도 ≥0.5 로 짝짓고, 고른 경로에 `update-index --index-info` 로 3스테이지를 모은 뒤 `checkout -m` | 그 뒤는 보통의 양쪽 수정 충돌이라 기존 편집기를 그대로 쓴다 |
| 해결 보관 (CF-28) | `hash-object -w` + `update-ref` | 스테이지·결과 blob 을 `mktree` + `commit-tree`(메시지 JSON 메타) 로 묶어 `refs/mgit/conflict/<상대 commit>/<sha256(path)[..16]>` | ref 하나가 blob 4개를 살리고 메타까지 담는다. gc 안전 |
| 구문 검사 (CF-25) | tree-sitter 10 문법 + kotlin·c# | javascript·typescript·tsx·rust·python·java·go·json·yaml 8종, `mgit-core` feature `syntax-check`(기본 on) | 컴파일 시간 제한. 필요하면 문법 crate 만 추가 |
| 글로브 매처 | 새로 작성 | A4 의 `secrets::glob_match` 재사용 | 중복 제거 |
| rerere 학습 (`rerere-train`) | 선택 | **미구현** | 과거 머지 재생은 범위가 커서 보류. 설정·가시화·forget 만 |
| GitLab 리뷰 승인 상태 | 승인 API | 미구현 (`None`) | 인스턴스마다 승인 규칙이 달라 1.0 에선 제외 |
| 통합 터미널 단축키 | — | ⌘⇧J (⌘J 는 명령 로그가 쓰고 있었다) | 충돌 회피 |
| 앱 설정 저장 | — | `Store.setting`(JSON) 키: `secrets.ignore`, `hosting.accounts`·`hosting.oauth`, `profiles`, `folder:<path>`, `modules:<repo>`·`module-scope:<repo>`, `conflict-rules:<repo>`, `verify-command:<common dir>`·`worktree-init:<common dir>`, `mgit.diffOptions`·`mgit.shortcuts`(프런트 localStorage) | 명세 8.1 에 정리 |

## 4. 수용 기준·검증

### 4.1 자동 검증 (완료)

| 영역 | 테스트 |
|---|---|
| Undo/Redo·백업 ref·reflog | `crates/mgit-core/tests/safety.rs` |
| rebase 플랜(순서·squash·drop·reword·exec)·빠른 수정 | `tests/rebase_plan.rs`, `rebase_plan.rs` 단위 |
| blame·파일 히스토리·비교·고급 검색·그래프 필터 | `tests/history.rs`, `mgit-git` 파서 단위 |
| 비밀 스캔·서명·설정·경량 clone | `tests/secrets.rs`, `tests/repo_settings.rs` |
| 호스팅(디바이스 플로우·목록·PR·오류) | `crates/mgit-hosting/tests/*` (httpmock), `tests/hosting.rs` |
| 폴더 일괄·루트 감시 | `tests/folder_batch.rs`, `mgit-watch` `dir_tests` |
| 서브모듈 | `tests/submodule_ops.rs` |
| 모듈 감지·보정·범위 | `tests/modules.rs`, `modules.rs` 단위(빌드 도구별 파서) |
| merge-tree 파서·미리보기·시뮬·레이더·rebase 예측·격리 병합 | `mgit-git/cmd/merge_tree.rs` 단위, `tests/preview.rs` |
| 블록 분류 5종·인접 결합·유사도 | `mgit-merge/src/classify.rs` 단위 |
| 규칙·보관·리뷰·재적용·rerere·이름 변경 충돌 | `tests/conflict_assist.rs` |
| 구문 검사·검증 명령·워크트리 초기화·LFS 왕복 | `mgit-syntax` 단위, `tests/verify_lfs.rs` (git-lfs 없으면 건너뜀) |
| 프런트 스토어 | `apps/desktop/src/__tests__/session-store-{a1…d3}.test.ts`, `folder-store-c1.test.ts`, `app-store*.test.ts`, `merge-editor` 편집기 테스트 |

### 4.2 실기기 확인 절차 (사용자)

**호스팅 (B1·B2)**
1. 설정 → 계정에서 GitHub PAT 로 연결(또는 OAuth App client_id 입력 후 디바이스 플로우: 코드 표시 → 브라우저 → 승인). 키체인에 `hosting:<id>` 항목이 생기는지.
2. "원격 저장소 탐색" 목록에서 하나 clone. 사이드바 PR 섹션에 열린 PR 이 리뷰·체크 상태와 함께 보이는지.
3. 현재 branch 를 push 한 뒤 "PR 만들기"(템플릿 자동 채움) → 목록에 나타나는지 → 다른 PR "체크아웃" → `pr/<n>` branch 가 생기는지.
4. GitLab 은 PAT(`api` 스코프)로 같은 절차. 그래프 아바타 열이 Gravatar/GitHub 로 채워지는지(오프라인은 이니셜).

**통합 터미널 (D3)** — ⌘⇧J 로 열고 `git status`, 한글 입력, 창 크기 변경(줄 바꿈 재배치), `exit` 뒤 탭에 "종료됨" 표시, 탭 2개 전환. Finder 로 실행한 앱에서 `node -v` 가 되는지(로그인 PATH).

**서명·fsmonitor (A4)** — `commit.gpgSign` 또는 ssh 서명 설정 뒤 커밋 → 상세 패널 `%G?` 배지. 추적 파일 2만 개 저장소에서 저장소 설정의 fsmonitor 제안 → 켠 뒤 `git fsmonitor--daemon status`.

**격리 병합·외부 도구 (D1·D2)** — 충돌 나는 branch 를 "격리 병합" → 새 탭이 열리고 메인 작업 트리는 그대로인지 → 해결·commit 뒤 "메인에 반영". `merge.tool` 설정 뒤 충돌 편집기의 "외부 도구로 열기".

**LFS (D3)** — 원격이 있는 LFS 저장소에서 잠금 목록·잠금·해제(원격 없으면 "잠금 조회 실패" 가 정상).

**Phase 1 미확인 항목** — `phase1-mvp-구현-결과.md` 3.2 의 PoC-3(편집기)·PoC-4(한글 IME)·PoC-5(인증·취소) 절차를 함께 수행한다.

### 4.3 미측정

- MOD-03 "모듈 범위 그래프 500ms": 경로 범위는 `--full-history --parents` 로 부모를 재작성해 받지만 대형 저장소에서 측정하지 않았다.
- 충돌 레이더: 후보 12개 상한. 브랜치 수백 개 저장소에서 ref 변경마다 1.5초 디바운스로 도는 비용은 미측정.
- 터미널 출력 폭주(`yes` 같은 명령) 시 채널·xterm 의 처리량.

## 5. 2주 사용 테스트 체크리스트

완료 기준(명세 5절): **2주 동안 업무 저장소 작업을 mGit 으로 처리하면서 데이터 손실 0건**. 아래 20 시나리오를 업무 저장소에서 수행하고 결과를 적는다. "손실" = 커밋·스태시·작업 트리 변경이 사용자 의도 없이 사라진 경우.

| # | 시나리오 | 확인할 것 | 결과 |
|---|---|---|---|
| 1 | 아침 fetch → 뒤처진 branch pull(rebase 모드) | 자동 fetch 알림, pull 뒤 그래프 즉시 갱신 | |
| 2 | 새 branch 만들어 커밋 3개 → push -u | 커밋 서명·비밀 스캔 경고 없음, 업스트림 자동 설정 | |
| 3 | 커밋 메시지 오타 수정(HEAD 아님) | 빠른 이력 수정, 편집기 없이 완료, Undo 로 복귀 | |
| 4 | rebase 플랜: 순서 바꾸기·squash·drop + `--exec` 검증 명령 | 결과 이력, 검증 실패 시 멈춤 → continue/abort | |
| 5 | reset --hard 실수 → Undo | branch 가 되돌아오고 백업 ref 가 사이드바에 보임 | |
| 6 | 충돌 나는 merge 전에 "미리보기" → 옵션 비교 → 실행 | 충돌 파일·옵션별 수 일치 | |
| 7 | 충돌 해결: 자동 결합 → 줄 고르기 → 구문 검사 경고 → 저장 | 남은 충돌 0, 마커 없음, stage 됨 | |
| 8 | 해결 중 Abort → 같은 merge 재시작 → "재적용" | 보관 수 안내, 재적용된 파일이 stage 됨 | |
| 9 | 이름 변경 충돌(양쪽에서 다른 이름) | 묶음 표시 → 한 경로로 모아 편집기로 해결 | |
| 10 | 격리 병합 → 새 탭에서 해결 → 메인에 반영 | 메인 작업 트리 변경이 보존됨 | |
| 11 | 서브모듈 포인터 변경 → 상위 push 전 검사 | 미푸시 commit 경고 → 서브모듈 먼저 push | |
| 12 | 폴더 탭에서 저장소 5개 일괄 pull | 결과 표, 더티 저장소 제외 | |
| 13 | 모듈 선택(예: `apps/web`) → 그래프·변경 범위 | 범위가 유지되고 다시 열 때 기억됨 | |
| 14 | PR 만들기 → 리뷰 반영 커밋 → 체크 상태 확인 | 목록 갱신, 체크 결과 표시 | |
| 15 | blame → commit 이동 → 파일 히스토리 → ref 비교 | 세 화면 간 이동이 끊기지 않음 | |
| 16 | 워크트리 만들기(초기화 명령 포함) → 작업 → 삭제 | 초기화 명령 알림, 삭제 전 검사 | |
| 17 | 스태시(staged 만) → 다른 branch → pop | 변경 복원, 충돌 시 안내 | |
| 18 | 통합 터미널에서 `git` 외부 명령 실행 | 그래프·상태가 2초 안에 반영 | |
| 19 | 큰 파일을 LFS 추적 → 커밋 → push | 포인터 파일 확인, `lfs ls-files` 목록 | |
| 20 | 단축키 재지정·알림·키보드만으로 커밋 | 설정 저장, 충돌 감지 | |

기록 규칙: 실패·손실은 즉시 `claudedocs/phase2-사용-테스트-기록.md` 에 재현 절차와 함께 적고, 명령 로그 패널(⌘J)의 해당 명령줄을 붙인다.

## 6. 릴리스 빌드

`pnpm build` (= `pnpm -F @mgit/desktop tauri build`), 2026-10-29, macOS arm64:

| 항목 | 결과 |
|---|---|
| Rust release 컴파일 | 1분 26초 (증분, tree-sitter 문법 8종·portable-pty 포함) |
| 산출물 | `target/release/bundle/macos/mGit.app` (44.22 MiB), `target/release/bundle/dmg/mGit_0.1.0_aarch64.dmg` (12.00 MiB) |
| 서명 | ad-hoc (`-`). 공증은 `APPLE_ID`·`APPLE_PASSWORD`·`APPLE_TEAM_ID` 가 없어 생략 (경고만) |
| 미확인 | universal(x86_64 포함) 빌드, Windows 설치 파일 — CI 러너에서 확인 필요 |

배포용 서명·공증은 `apps/desktop/src-tauri/tauri.conf.json` 의 bundle 설정과 CI 비밀 변수로 넣는다.

## 7. 알려진 한계·후속

| 항목 | 상태 |
|---|---|
| GitLab 리뷰 승인 상태 | 미구현(`None`). 승인 규칙 API 는 인스턴스 설정에 따라 다름 |
| rerere 학습(`rerere-train`) | 미구현. 설정·자동 해결 표시·forget 만 |
| 충돌 레이더 후보 | 업스트림·기본 branch·워크트리 branch·로컬 branch 순 12개 상한 |
| rebase 예측 | 첫 충돌 뒤 단계는 "근사치" 표시 |
| 통합 터미널 | 스크롤백 5000줄, 로그인 셸 1개(`$SHELL -l`). 탭 복원 없음(앱 재시작 시 닫힘) |
| 구문 검사 문법 | 8종(js·ts·tsx·rust·python·java·go·json·yaml). 그 외 확장자는 검사하지 않음 |
| LFS 잠금 | 원격이 있어야 조회됨. 오프라인이면 "잠금 조회 실패" 표시 |
| 호스팅 캐시 | 메모리 TTL 없음(요청마다 호출). rate limit 은 헤더 기반 대기만 |
| 모듈 감지 | 설정 파일 변경 시 자동 재감지 없음("다시 감지" 버튼) |
| CI | `.github/workflows` 는 Phase 1 구성 그대로. tree-sitter·portable-pty 가 추가돼 러너에 C 컴파일러 필요 |
| 빌드 환경(macOS) | biome·clippy-driver 바이너리가 SIGKILL 되는 로컬 이슈(코드 서명 캐시 추정)는 복사본 symlink 로 우회 중. 재부팅 뒤 `pnpm install --force`·`rustup component add clippy` 로 원복 |

## 8. 다음 단계 제안

1. 사용자가 4.2 실기기 절차와 5절 체크리스트를 수행하고 기록 → 실패 항목은 슬라이스 단위로 수정.
2. CI 워크플로에 Phase 2 의존성(C 컴파일러, git-lfs) 반영 후 실행 확인.
3. Phase 3(P2): AI 보조, 통합 타임라인, 가상 그룹, Stacked PR — 명세 3절 P2 항목으로 계획 수립.
