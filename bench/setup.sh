#!/usr/bin/env bash
# 벤치 픽스처를 준비한다.
# - 대형 저장소(PoC-1): 받아서 commit-graph 를 만든다
# - 합성 폴더(W0): 저장소 여러 개를 git fast-import 로 만든다. 커밋 시각 배치(W18)를 고를 수 있다
# - 원격 브랜치가 많은 저장소(W9): 합성 폴더의 저장소 하나를 복사해 원격 추적 ref 를 N개 더한다
# - 큰 디렉터리·1 MiB 파일(W18): 파일 트리 나열·파일 읽기용 (git 저장소가 아니다)
# - 변경 파일이 많은 저장소(W18): 폴더 stage·unstage 용 (추적 파일 N개가 모두 수정된 상태)
# 사용법: bench/setup.sh [git|rust|linux|<url>]
#         bench/setup.sh folder [저장소 수=20] [저장소당 커밋 수=10000] [시각 배치=uniform|partial|clustered]
#         bench/setup.sh remotes [원격 브랜치 수=300] [원본 저장소=repos/folder-20x10000/repo-01] [결과 이름=remotes-<수>]
#         bench/setup.sh fs [항목 수=50000]
#         bench/setup.sh stage [변경 파일 수=5000]
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p repos

# 합성 저장소 하나의 fast-import 스트림을 표준 출력으로 낸다 (인자: 저장소 번호, 총 커밋 수, 저장소 수, 시각 배치).
# 날짜·작성자가 고정이라 같은 인자면 항상 같은 커밋이 나온다. 구성:
# - main 한 줄기, main 커밋 400개마다 토픽 브랜치(3커밋)를 main 과 번갈아 쌓고 머지
# - 끝에 머지하지 않은 로컬 브랜치 2개(feature/search, feature/login)
# - 원격 추적 브랜치 4개: origin/main(ahead 5·behind 1), origin/feature/login,
#   origin/hotfix(원격에만 있음), origin/release/1.0(예전 main 커밋)
# 모든 ref 에서 닿는 커밋 수가 정확히 총 커밋 수가 된다.
# 시각 배치(W18 레인 수 측정): 저장소 하나가 활동하는 기간은 최대 n × 480초(W)다.
# - uniform: 모든 저장소가 같은 기간에 활동해 타임라인에서 고르게 섞인다 (W0 부터의 기본, 스트림이 그대로다)
# - partial: 저장소마다 활동 기간을 W/4 씩 밀어 어느 시점이든 저장소 3~4개가 겹친다
# - clustered: 저장소마다 활동 기간을 W 씩 밀어 겹치지 않는다 (번호가 큰 저장소가 최근)
folder_repo_stream() {
  LC_ALL=C awk -v idx="$1" -v n="$2" -v count="${3:-1}" -v layout="${4:-uniform}" '
    # 커밋 하나를 내고 표식 번호를 돌려준다. from·merge 는 부모 표식(0 이면 생략)
    function commit(ref, subject, from, merge, path, body,    a, ts, msg) {
      seq++
      ts = t_end - (n - seq) * step
      a = seq % 5 + 1
      msg = sprintf("repo-%02d: %s\n", idx, subject)
      printf "commit %s\nmark :%d\n", ref, seq
      printf "author %s <%s> %d +0000\n", names[a], mails[a], ts - 60
      printf "committer %s <%s> %d +0000\n", names[a], mails[a], ts
      printf "data %d\n%s", length(msg), msg
      if (from) printf "from :%d\n", from
      if (merge) printf "merge :%d\n", merge
      printf "M 100644 inline %s\ndata %d\n%s\n", path, length(body), body
      return seq
    }
    # main 에 커밋 하나를 쌓는다
    function main_commit(    path) {
      path = sprintf("src/mod-%d/file-%02d.txt", seq % 8, seq % 40)
      main_tip = commit("refs/heads/main", "change " (seq + 1), 0, 0, path, "rev " (seq + 1) "\n")
      marks[++main_n] = main_tip
    }
    BEGIN {
      split("Kim Mina|Lee Joon|Park Sora|Choi Dan|Jung Hana", names, "|")
      split("mina@example.invalid|joon@example.invalid|sora@example.invalid|dan@example.invalid|hana@example.invalid", mails, "|")
      # 저장소마다 커밋 간격이 달라 타임라인에서 불규칙하게 섞인다. uniform 이면 마지막 커밋은 거의 같은 시각
      step = 240 + (idx * 37) % 240
      span = n * 480
      if (layout == "clustered") {
        t_end = 1760000000 - (count - idx) * span - idx * 11
      } else if (layout == "partial") {
        t_end = 1760000000 - (count - idx) * int(span / 4) - idx * 11
      } else {
        t_end = 1760000000 - idx * 11
      }
      seq = 0; main_n = 0; topic_n = 0
      body_n = n - 7
      while (seq < body_n) {
        if (main_n > 0 && main_n % 400 == 0 && seq + 6 <= body_n) {
          topic_n++
          tfile = sprintf("topics/topic-%03d.txt", topic_n)
          tsubj = "topic " topic_n
          tip = commit("refs/heads/tmp-topic", tsubj " step 1", main_tip, 0, tfile, "step 1\n")
          main_commit()
          tip = commit("refs/heads/tmp-topic", tsubj " step 2", 0, 0, tfile, "step 2\n")
          main_commit()
          tip = commit("refs/heads/tmp-topic", tsubj " step 3", 0, 0, tfile, "step 3\n")
          main_tip = commit("refs/heads/main", "Merge " tsubj, 0, tip, tfile, "step 3\n")
          marks[++main_n] = main_tip
        } else {
          main_commit()
        }
      }
      commit("refs/heads/feature/search", "search 1", main_tip, 0, "feature/search.txt", "1\n")
      commit("refs/heads/feature/search", "search 2", 0, 0, "feature/search.txt", "2\n")
      commit("refs/heads/feature/search", "search 3", 0, 0, "feature/search.txt", "3\n")
      commit("refs/heads/feature/login", "login 1", marks[main_n - 20], 0, "feature/login.txt", "1\n")
      tip = commit("refs/heads/feature/login", "login 2", 0, 0, "feature/login.txt", "2\n")
      printf "reset refs/remotes/origin/feature/login\nfrom :%d\n\n", tip
      commit("refs/remotes/origin/hotfix", "hotfix 1", marks[main_n - 2], 0, "hotfix.txt", "1\n")
      commit("refs/remotes/origin/main", "remote change", marks[main_n - 5], 0, "remote.txt", "1\n")
      printf "reset refs/remotes/origin/release/1.0\nfrom :%d\n\n", marks[int(main_n / 2)]
    }'
}

# 합성 폴더 픽스처를 만든다 (인자: 저장소 수, 저장소당 커밋 수, 시각 배치). 이미 있는 저장소는 건너뛴다.
# uniform 은 repos/folder-<수>x<커밋>, 나머지는 뒤에 -<배치> 를 붙인 폴더다
make_folder() {
  local count=$1 commits=$2 layout=$3
  if ! [[ "$count" =~ ^[0-9]+$ && "$commits" =~ ^[0-9]+$ ]] || [ "$count" -lt 1 ] || [ "$commits" -lt 100 ]; then
    echo "usage: bench/setup.sh folder [저장소 수>=1] [저장소당 커밋 수>=100] [uniform|partial|clustered]" >&2
    exit 2
  fi
  local root="repos/folder-${count}x${commits}"
  case "$layout" in
    uniform) ;;
    partial | clustered) root="${root}-${layout}" ;;
    *)
      echo "시각 배치는 uniform, partial, clustered 중 하나입니다: $layout" >&2
      exit 2
      ;;
  esac
  mkdir -p "$root"
  local i name dir tmp total=0
  for i in $(seq 1 "$count"); do
    name=$(printf 'repo-%02d' "$i")
    dir="$root/$name"
    if [ ! -d "$dir/.git" ]; then
      # 중간에 끊겨도 반쯤 만든 저장소가 남지 않게 임시 경로에 만든 뒤 옮긴다
      tmp="$root/.tmp-$name"
      rm -rf "$tmp"
      git init --quiet --initial-branch=main "$tmp"
      folder_repo_stream "$i" "$commits" "$count" "$layout" | git -C "$tmp" fast-import --quiet
      if git -C "$tmp" show-ref --verify --quiet refs/heads/tmp-topic; then
        git -C "$tmp" update-ref -d refs/heads/tmp-topic
      fi
      # fast-import 는 객체만 만든다. 작업 트리·인덱스를 main 으로 채워야 status 가 깨끗하다
      git -C "$tmp" reset --quiet --hard
      # 가짜 원격: 추적 브랜치의 ahead/behind 계산이 돌게 upstream 만 잡는다 (.invalid 라 접속되지 않는다)
      git -C "$tmp" config remote.origin.url "https://example.invalid/$name.git"
      git -C "$tmp" config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
      git -C "$tmp" config branch.main.remote origin
      git -C "$tmp" config branch.main.merge refs/heads/main
      git -C "$tmp" commit-graph write --reachable --changed-paths
      mv "$tmp" "$dir"
    fi
    total=$((total + $(git -C "$dir" rev-list --all --count)))
  done
  echo "repos: $count, commits: $total"
  echo "ready: $(pwd)/$root"
}

# 원격 브랜치가 많은 저장소를 만든다 (인자: 더할 원격 추적 ref 수, 원본 저장소, 결과 폴더 이름). 원본을 복사하므로
# 합성 폴더 픽스처는 그대로다. 더하는 ref(`refs/remotes/origin/bench/feature-NNNN`)는 main 첫 부모 이력을 고르게
# 나눈 과거 커밋들을 가리킨다 — 최신 커밋은 몇 개만, 오래된 커밋은 거의 전부가 품는다. ref 만 더하므로
# commit-graph 는 다시 쓰지 않는다. 이미 있으면 건너뛴다 (다시 만들려면 폴더를 지운다).
# 결과 이름을 주지 않으면 repos/remotes-<수> 다 (원본이 다르면 이름을 따로 준다: W18 의 깊은 이력)
make_remotes() {
  local count=$1 source=$2 name=${3:-remotes-$1}
  if ! [[ "$count" =~ ^[0-9]+$ ]] || [ "$count" -lt 1 ] || [ "$count" -gt 9999 ]; then
    echo "usage: bench/setup.sh remotes [원격 브랜치 수 1~9999] [원본 저장소] [결과 폴더 이름]" >&2
    exit 2
  fi
  if ! [[ "$name" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "결과 폴더 이름은 영문·숫자·.·_·- 만 씁니다: $name" >&2
    exit 2
  fi
  if [ ! -d "$source/.git" ]; then
    echo "원본 저장소가 없습니다: $source (먼저 bench/setup.sh folder)" >&2
    exit 2
  fi
  local root="repos/${name}"
  local dir
  dir="$root/$(basename "$source")"
  if [ ! -d "$dir/.git" ]; then
    local tmp="$root/.tmp"
    rm -rf "$tmp"
    mkdir -p "$root"
    cp -R "$source" "$tmp"
    git -C "$tmp" rev-list --first-parent main | LC_ALL=C awk -v n="$count" '
      { oid[NR - 1] = $0 }
      END {
        step = NR / n
        for (i = 0; i < n; i++) printf "create refs/remotes/origin/bench/feature-%04d %s\n", i, oid[int(i * step)]
      }' | git -C "$tmp" update-ref --stdin
    mv "$tmp" "$dir"
  fi
  echo "remote branches: $(git -C "$dir" for-each-ref refs/remotes | wc -l | tr -d ' '), local branches: $(git -C "$dir" for-each-ref refs/heads | wc -l | tr -d ' ')"
  echo "ready: $(pwd)/$root"
}

# 파일 트리 측정용 폴더를 만든다 (인자: 큰 디렉터리의 항목 수). git 저장소가 아니다. 구성:
# - big/: 빈 파일 N개 (file-00000.txt …)
# - file-1m.txt: 64바이트 줄 16,384개 = 정확히 1 MiB 의 텍스트 (파일 보기 상한과 같은 크기라 본문을 다 읽는다)
# 이미 있으면 건너뛴다
make_fs() {
  local count=$1
  if ! [[ "$count" =~ ^[0-9]+$ ]] || [ "$count" -lt 1 ] || [ "$count" -gt 200000 ]; then
    echo "usage: bench/setup.sh fs [항목 수 1~200000]" >&2
    exit 2
  fi
  local root="repos/fs-${count}"
  if [ ! -d "$root" ]; then
    local tmp="repos/.tmp-fs-${count}"
    rm -rf "$tmp"
    mkdir -p "$tmp/big"
    (cd "$tmp/big" && LC_ALL=C awk -v n="$count" 'BEGIN { for (i = 0; i < n; i++) printf "file-%05d.txt\n", i }' | xargs touch)
    LC_ALL=C awk 'BEGIN { for (i = 0; i < 16384; i++) printf "%-63.63s\n", sprintf("line %05d: lorem ipsum dolor sit amet, consectetur adipiscing elit", i) }' > "$tmp/file-1m.txt"
    mv "$tmp" "$root"
  fi
  echo "entries: $(find "$root/big" -type f | wc -l | tr -d ' '), file-1m.txt: $(wc -c < "$root/file-1m.txt" | tr -d ' ') bytes"
  echo "ready: $(pwd)/$root"
}

# 변경 파일이 많은 저장소를 만든다 (인자: 파일 수). 추적 파일 N개(디렉터리 100개에 나눔)를 한 커밋으로 넣은 뒤
# 모두 고쳐 둔다 — stage 되지 않은 수정 N개. 폴더 stage·unstage 벤치는 끝나면 이 상태로 되돌린다. 이미 있으면 건너뛴다
make_stage() {
  local count=$1
  if ! [[ "$count" =~ ^[0-9]+$ ]] || [ "$count" -lt 1 ] || [ "$count" -gt 100000 ]; then
    echo "usage: bench/setup.sh stage [변경 파일 수 1~100000]" >&2
    exit 2
  fi
  local root="repos/stage-${count}"
  local dir="$root/repo-01"
  if [ ! -d "$dir/.git" ]; then
    local tmp="$root/.tmp-repo-01"
    rm -rf "$tmp"
    mkdir -p "$root"
    git init --quiet --initial-branch=main "$tmp"
    (cd "$tmp" && LC_ALL=C awk -v n="$count" 'BEGIN { for (i = 0; i < n; i++) printf "src/d-%02d\n", i % 100 }' | sort -u | xargs mkdir -p)
    (cd "$tmp" && LC_ALL=C awk -v n="$count" 'BEGIN {
      for (i = 0; i < n; i++) { f = sprintf("src/d-%02d/file-%05d.txt", i % 100, i); print "base " i > f; close(f) }
    }')
    git -C "$tmp" add -A
    GIT_AUTHOR_DATE="1760000000 +0000" GIT_COMMITTER_DATE="1760000000 +0000" \
      git -C "$tmp" -c user.name=Bench -c user.email=bench@example.invalid commit --quiet -m "files"
    (cd "$tmp" && LC_ALL=C awk -v n="$count" 'BEGIN {
      for (i = 0; i < n; i++) { f = sprintf("src/d-%02d/file-%05d.txt", i % 100, i); print "changed " i >> f; close(f) }
    }')
    mv "$tmp" "$dir"
  fi
  echo "modified: $(git -C "$dir" status --porcelain | wc -l | tr -d ' ')"
  echo "ready: $(pwd)/$root"
}

name=${1:-git}
if [ "$name" = folder ]; then
  make_folder "${2:-20}" "${3:-10000}" "${4:-uniform}"
  exit 0
fi
if [ "$name" = remotes ]; then
  make_remotes "${2:-300}" "${3:-repos/folder-20x10000/repo-01}" "${4:-}"
  exit 0
fi
if [ "$name" = fs ]; then
  make_fs "${2:-50000}"
  exit 0
fi
if [ "$name" = stage ]; then
  make_stage "${2:-5000}"
  exit 0
fi
case "$name" in
  git)   url=https://github.com/git/git ;;
  rust)  url=https://github.com/rust-lang/rust ;;
  linux) url=https://github.com/torvalds/linux ;;
  *)     url=$name; name=$(basename "$name" .git) ;;
esac

if [ ! -d "repos/$name/.git" ]; then
  echo "clone $url → repos/$name"
  git clone --quiet "$url" "repos/$name"
fi

echo "commit-graph write (--reachable --changed-paths)"
git -C "repos/$name" commit-graph write --reachable --changed-paths
echo "commits: $(git -C "repos/$name" rev-list --all --count)"
echo "ready: $(pwd)/repos/$name"
