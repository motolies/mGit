# Phase 3 G1·G2 구현 결과 — 그래프 가독성·통합 타임라인

작성일: 2026-10-29. 릴리스 앱으로 업무 저장소를 연 첫 실기기 피드백(그래프가 IntelliJ 보다 복잡, 원격 숨기기가 안 되는 듯, 브랜치별 색, 필터 바를 못 찾음, IntelliJ 의 통합 로그·정렬 메뉴)에서 출발한 Phase 3 첫 슬라이스. 계획: `~/.claude/plans/lucky-tumbling-leaf.md`. 앞선 결과는 `phase2-1.0-구현-결과.md`.

## 1. 한눈에

| 항목 | 결과 |
|---|---|
| 커밋 | G1 `58cc2ef`, G2 (이 커밋 직전), 문서 1개. master, push 안 함 |
| Rust 테스트 | 267개 통과 (Phase 2 끝 236 → +31: `mgit-graph` 시나리오·proptest, 코어 `graph_window`·`folder_timeline`), clippy `-D warnings`·fmt 통과 |
| 프런트 테스트 | 132개 통과 (33 파일; +11: `session-store-g1`, `folder-store-g2`, `draw-list` 스텁, `columns` 저장소 열) |
| 앱 스모크 | 슬라이스마다 `pnpm dev` 기동 → HTTP 200·프로세스 1·로그 오류 0 |
| 새 의존성 | `@radix-ui/react-dropdown-menu` |
| 실기기 미확인 | 4절 절차대로 사용자 확인 필요 (업무 저장소의 실제 모양은 테스트 저장소와 다르다) |

## 2. G1 — 그래프 가독성 (단일 저장소 탭)

| 기능 | 구현 | 위치 |
|---|---|---|
| 브랜치별 색 | ref 팁 커밋이 기다리던 레인에 도착하면 그 행부터 레인 색을 바꾼다(이전 구간을 `r-1` 에서 닫고 같은 레인 이음선 엣지). 새 레인(팁·분기)은 기다릴 커밋의 ref 색을 미리 쓴다. 색 = 브랜치 이름 FNV-1a 해시 % 10 이라 커밋해도, 저장소가 달라도 같은 이름은 같은 색. `origin/x` 는 `x` 와 같은 키 | `mgit-graph` `LayoutOptions.ref_colors`, `branch_color`; 코어 `load.rs::layout_options` |
| 기본 브랜치 레인 0 고정 (GRAPH-13) | 레인 0 을 HEAD 브랜치 팁을 기다리는 **가상 레인**으로 심어 두면 기존 합류 경로가 "레인 0 으로 옮기기"를 대신한다. 고정 체인의 첫 부모를 다른 레인이 기다리면 그 레인을 레인 0 으로 합류시킨다(steal). 고정은 HEAD 브랜치가 질의에 확실히 포함될 때만(전체, 또는 그 이름을 고른 경우; 경로 범위·머지 제외는 제외) | `LayoutOptions.pin`, `Lane.pinned`, `UNSET` |
| 긴 엣지 접기 | 부모가 40행(`CoreConfig.graph_long_edge_rows`)보다 아래면 레인을 잡지 않고 자식 행에 ↓ 스텁, 부모 행에 ↑ 스텁만 둔다. 스트리밍 중에도 알 수 있게 **N행 선행 버퍼**: `push` 는 큐에 넣고 N 을 넘으면 맨 앞을 배정. `len()` 은 배정된 행 수라 코어의 행 수·`total_rows` 도 이것을 쓴다(아니면 캐시가 마지막 N행을 부분 청크로 보고 재요청 루프). 고정 체인의 첫 부모는 접지 않는다 | `LayoutOptions.collapse_long_edges`, `Stub`/`WindowStub`, 프런트 `draw-list.ts`·`paint.ts`(화살촉) |
| 원격 숨기기 = 배지도 숨김 | `graph_window` 가 `hide_remotes` 면 `RemoteBranch` 라벨을 뺀다(모드 무관). solo 모드에서 `--exclude` 가 무의미했던 문제의 실제 원인 | `core.rs::graph_window` |
| 현재 브랜치 밖 흐리게 | 스트리밍 중 HEAD 에서 부모를 따라 `pending` 집합으로 도달성을 판정(`HeadReach`), `GraphRow.in_head`. 프런트 보기 설정 `dimOffHead`(기본 켬)로 `data-dim` 행 글자를 흐리게. 머지 제외 모드에선 도달성이 끊기므로 끈다 | `CommitTable.in_head`, `GraphRow.tsx` |
| 정렬·첫 부모·머지 제외 | `GraphQuery{sort: topo\|date, first_parent, no_merges}` → `--topo-order\|--date-order`, `--first-parent`(레이아웃은 첫 부모만), `--no-merges`(레이아웃은 부모 없이 목록 모드: 전부 레인 0, 엣지 없음 — 끊긴 DAG 의 dangling 긴 선을 피한다) | `mgit-model/history.rs`, `cmd/log.rs`, `load.rs::layout_parents` |
| 레이아웃 설정 | `GraphLayoutPrefs{pin_head, ref_colors, collapse_long_edges}`(기본 모두 켬)은 세션 단위. 바꾸면 `relayout_graph` 가 **테이블을 그대로 두고 레이아웃만** 다시 만들어 세대를 올린다(git 재실행 없음, O(n)). 로드·재로드 중이면 재로드로 대신. 프런트 localStorage `mgit.graphLayout`, 기본값이 아니면 세션을 만들 때 코어에 알린다 | `history.rs::relayout_graph`, `session-store.ts` |
| 그래프 머리글 | 항상 보이는 줄: 🔍 검색, ▾ 필터(토글), 현재 조건 요약(`development 만 · 원격 숨김 · 날짜순 · 첫 부모만` + ×), 옵션 드롭다운(IntelliJ 와 같은 그룹: 정렬 ○토폴로지/●날짜순, 옵션 ☐첫 부모만 ☐머지 제외, 보기 ☑긴 엣지 접기 ☑기본 브랜치 고정 ☑브랜치별 색 ☑현재 브랜치 밖 흐리게, 열 설정…). 필터 바는 토글했을 때만 | `features/graph/GraphHeader.tsx`, `components/DropdownMenu.tsx` |

레이아웃 불변식(`mgit-graph/src/check.rs`)에 추가된 것: S1 스텁 셀 = 노드 레인, S2 스텁 row 단조, S3 Down/Up 짝·거리 > N, S4 미해결 Down ⇔ 스트림 밖 부모, I3 확장(셀 경로 또는 Down 스텁), I11 고정 체인은 레인 0 만, I12 접기 레인 수 ≤ 안 접은 레인 수, I13 ref 색 적용. proptest 는 옵션(고정 없음/안/밖, 임의 ref 색, 접기 1..8)까지 무작위로 넣어 결정성(I6)·배치 분할 동일(I9)·window=브루트포스(I8)를 검사한다.

## 3. G2 — 통합 타임라인 (MR-12) + 브랜치 목록 저장소 표기

| 항목 | 구현 |
|---|---|
| 데이터 | 폴더 세션의 `TimelineState{data: TimelineData{layout: GraphLayout<(u16, Oid)>, table, repos}, query(기본 날짜순 전체), prefs, reload, task}`. 처음 "타임라인" 탭을 켤 때만 읽는다 |
| 로드 | 저장소를 `common_dir` 로 중복 제거(워크트리는 원 저장소에 흡수) → 저장소마다(동시 8) `head_state`·`list_refs`·`git log --date-order --max-count=<cap>`(`run`, 스트림 permit 교착 회피) → `commit_time` 내림차순 **k-way 병합**(동률은 저장소 번호순, 저장소 안 순서는 유지되므로 자식 먼저가 지켜짐) → `table.push_in(repo, …)` + `layout.push((repo, oid), …)`. 레인 색 = 저장소 번호(`lane_color`), 고정·ref 색 없음, 긴 엣지 접기는 설정대로. 캡 `CoreConfig.timeline_max_per_repo = 10_000` |
| 질의 | 모든 저장소에 같은 `GraphQuery`. solo/branches 에서 그 ref 가 없는 저장소는 건너뛴다(branches 는 있는 이름만 넘김) |
| 갱신 | `watch_folder` 콜백이 `ChangeSet` 을 보고 `FolderChanged{refs: true}`(HEAD·refs·packed-refs) 를 보내면 프런트가 타임라인을 열어 둔 경우에만 1.5초 디바운스로 `folder_timeline_reload`. 재스캔·일괄 작업·일괄 커밋 뒤에도 다시 읽는다. 이벤트는 기존 `graphLoadStarted/Finished/Reloaded/Failed` 를 **폴더 세션 id** 로 보낸다(wire 변경 없음) |
| IPC | `folder_timeline_open/info/reload/query_set/prefs_set/window/find_row`, `TimelineInfo{repos[{index,name,path,color,headBranch,truncated}], branches[{name,remote,repos,currentIn}]}`, `GraphRow.repo` |
| 프런트 | 폴더 탭 "타임라인" 보기: 왼쪽 브랜치 패널(검색, 로컬/원격, 이름 + `(저장소, …)`, 현재 브랜치 ●, 클릭 = 그 브랜치만, 원격 숨기기) + 오른쪽 `GraphView`(저장소 이름 열 `columns.repo`, 저장소 색 배경, 현재 브랜치 밖 흐리게, 접힌 긴 엣지). 행을 다시 클릭하거나 우클릭 "저장소에서 열기" → 그 저장소를 하위 탭으로 열고 **로드가 끝난 뒤** 그 커밋으로 이동(`jumpToCommitWhenLoaded`, `pendingJump`) |
| 부수 수정 | 탭 이름이 `▣`·`└` 만 보이던 버그, 저장소 간 검색의 커밋 클릭이 처음 여는 저장소에서 이동하지 못하던 문제(`openRepositoryAt` 이 세션 id 를 돌려주고 대기 이동을 쓴다) |

## 4. 실기기 확인 절차 (사용자)

업무 저장소(development/staging/master + feature/*)에서:

1. **원격 숨기기**: 필터 바(머리글 ▾ 필터)에서 "development 만" + 원격 숨기기 → 행에 `origin/*` 배지가 없는지.
2. **브랜치별 색·고정**: feature 브랜치에 커밋 → feature 체인은 feature 색, master 팁부터 master 색. `development` 이 레인 0 에 있고 커밋 뒤에도 위치·색이 그대로인지. 옵션 ▾ 보기에서 "기본 브랜치 고정"을 끄면 최신 팁이 레인 0 을 가져가는지(재로드 없이 바로).
3. **긴 엣지 접기**: 이전의 계단 모양이 ↓/↑ 스텁으로 접혀 레인 수가 줄었는지. 끄면 원래대로.
4. **옵션 메뉴**: 커밋 날짜순·첫 부모만·머지 제외 전환, staging 머지 행이 흐리게 보이는지, "현재 브랜치 밖 흐리게" 끄기.
5. **타임라인**: `~/git` 같은 부모 폴더를 열고 "타임라인" 탭 → 저장소 색 열, 브랜치 목록의 `(저장소…)`, 브랜치 클릭으로 범위 좁히기, 행 더블클릭(다시 클릭)으로 저장소 탭의 그 커밋으로 이동, 다른 창에서 커밋한 뒤 1~2초 안에 갱신되는지.
6. **탭 이름**: 폴더 탭 `▣ 이름`, 하위 탭 `└ 이름`.

## 5. 미측정·한계

- 10만 행 저장소에서 lookahead(40행)가 첫 화면 시간을 바꾸는지는 측정하지 않았다(`GraphFirstChunk` 는 500행 기준이라 영향이 없어야 한다).
- 타임라인 저장소 10개 × 1만 행 로드 시간 미측정. 캡을 넘는 저장소는 오래된 커밋이 잘리고 머리글에 "저장소당 최근 N개만 표시"로 안내한다.
- 색 10개라 해시 충돌은 불가피하다. 원격 전용 브랜치(`origin/release`)가 main 체인 위에 있으면 그 아래가 그 색으로 바뀐다(의도된 의미, 보기 설정으로 끌 수 있다).
- 스텁 클릭으로 상대 행 이동(`onStubClick`)은 넣지 않았다. 선형 구간 접기(IntelliJ "Collapse Linear Branches"), 가상 그룹(MR-13)은 비범위.
- 타임라인 레이아웃 설정 변경은 재배치 대신 다시 읽는다(코어 `folder_timeline_prefs_set`). 프런트에서는 아직 노출하지 않았다(긴 엣지 접기는 기본 켬).
- 탭 복원 시 부모-자식 관계는 여전히 사라진다(기존 한계).

## 6. 다음 단계

1. 사용자 실기기 확인(4절) → 어긋나는 모양은 `mgit-graph/tests/scenarios.rs` 에 그 DAG 를 재현해 고친다.
2. push 는 요청 시.
3. Phase 3 다음 슬라이스: 명세 P2 나머지(현재 브랜치 밖 커밋 흐리게·정렬 메뉴는 이번에 끝남), 타임라인 레이아웃 설정 노출, 스텁 클릭 이동.

## 7. 실기기 피드백 수정 (BR-02·RM-04, 2026-10-29)

원격이 둘(`origin`, `fork`)이고 둘 다 `master` 를 가진 저장소에서 발견한 문제 둘을 고쳤다.

| 항목 | 문제 | 수정 |
|---|---|---|
| BR-02 원격 브랜치 체크아웃 | `fork/master` 를 체크아웃해도 로컬 `master`(= origin/master)로 감. 코어가 같은 이름의 로컬만 보고 업스트림을 보지 않았고, 사이드바 더블클릭은 원격 접두를 두 번 잘라 빈 이름을 보냈다 | 코어 `CheckoutTarget::RemoteBranch{local}`: 로컬의 업스트림이 그 원격이면 전환, 아니면 `CoreError::LocalBranchTracksOther` → 대화상자(새 이름 기본 `<remote>-<name>` 추적 브랜치 / 분리된 HEAD). 이름은 `@mgit/ipc` `remoteBranchName`(fullName 기준)으로 통일 |
| RM-04 push 대상 | 원격은 업스트림을 따르지만 원격 쪽 브랜치를 로컬 이름으로 써서 `fork-master` push 가 fork 에 새 브랜치를 만들었다. 원격 이름에 `/` 가 있으면 잘못 잘랐다 | 코어 refspec `refs/heads/<local>:refs/heads/<업스트림 브랜치>`(업스트림 원격일 때), 다른 원격이면 같은 이름. 원격 이름은 등록 목록의 가장 긴 접두로 분리(`split_upstream`). 툴바 Push ⌄ 메뉴(업스트림/원격별)와 사이드바 원격 이름 메뉴(이 원격만 fetch·push·push 하고 업스트림 지정) 추가 |

테스트: `branch_ops.rs::remote_branch_checkout_with_same_name_on_other_remote`, `sync.rs::push_updates_upstream_branch_when_local_name_differs`·`push_to_chosen_remote_keeps_or_sets_upstream`, `sync.rs` 단위 `split_upstream_*`, 프런트 `refs.test.ts`·`session-store-s3/s4`. testkit `add_bare_remote_named`.
