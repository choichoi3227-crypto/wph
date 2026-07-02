#!/usr/bin/env bash
# =============================================================================
# init-repo.sh
# https://github.com/choichoi3227-crypto/wph 레포에 모노레포를 초기 푸시한다.
# 이 스크립트는 로컬 머신에서 1회만 실행한다.
# =============================================================================
set -euo pipefail

REMOTE="https://github.com/choichoi3227-crypto/wph.git"
BRANCH="main"

# 스크립트 위치 기준으로 루트 찾기
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

echo "[1/5] 루트: $ROOT"
cd "$ROOT"

# git 초기화 (이미 .git 있으면 스킵)
if [ ! -d ".git" ]; then
  echo "[2/5] git init"
  git init
  git remote add origin "$REMOTE"
else
  echo "[2/5] .git 이미 존재 — remote 확인"
  git remote set-url origin "$REMOTE" 2>/dev/null || git remote add origin "$REMOTE"
fi

echo "[3/5] npm install (워크스페이스 전체)"
npm install

echo "[4/5] 타입체크"
npm run typecheck

echo "[5/5] 커밋 & 푸시"
git add -A
git commit -m "feat: CloudPress Bridge 모노레포 초기 구조

패키지:
- packages/storage  : 100% 자체 S3 호환 스토리지 v2 (D1+KV+DO)
- packages/api      : 호스팅/DNS/결제/인증 API
- packages/site-worker: PHP-WASM 사이트 런타임
- apps/frontend     : 랜딩/대시보드 정적 페이지

엔드포인트:
- storage.cloud-press.co.kr
- api.cloud-press.co.kr
- Cloudflare Pages (frontend)
"
git branch -M "$BRANCH"
git push -u origin "$BRANCH"

echo ""
echo "✅ 푸시 완료: $REMOTE"
echo ""
echo "다음 단계:"
echo "  1. bash deploy/deploy.sh infra   (KV/D1 생성 → ID를 wrangler.toml에 업데이트)"
echo "  2. bash deploy/deploy.sh secrets (시크릿 등록)"
echo "  3. bash deploy/deploy.sh all     (전체 배포)"
echo "  4. bash deploy/deploy.sh seed    (WordPress 템플릿 시드)"
