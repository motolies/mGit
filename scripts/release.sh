#!/usr/bin/env bash
# 호출한 위치와 관계없이 버전 준비·커밋·태그·검사·패키징을 순서대로 실행한다.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  echo '사용법: ./scripts/release.sh [X.Y.Z] [--dry-run]'
  echo '새 버전: pnpm release 0.1.1'
  echo '현재 버전으로 패키징 또는 실패한 빌드 재시도: pnpm release'
  echo '깨끗한 작업 트리에서 시작하며 버전 변경만 자동 커밋합니다. 원격 push는 하지 않습니다.'
  exit 0
fi
exec node scripts/release.mjs all "$@"
