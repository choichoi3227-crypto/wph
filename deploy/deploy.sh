#!/usr/bin/env bash
# =============================================================================
# CloudPress Bridge — deploy.sh (모노레포 버전)
# 레포: https://github.com/choichoi3227-crypto/wph
# 실행: bash deploy/deploy.sh [storage|api|frontend|worker|all|infra|secrets|seed]
# =============================================================================
set -euo pipefail

CYAN='\033[0;36m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()   { echo -e "${GREEN}[OK]${NC}    $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()  { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-all}"

check_deps() {
  command -v wrangler >/dev/null 2>&1 || die "wrangler 없음: npm i -g wrangler"
  command -v node    >/dev/null 2>&1 || die "Node.js 필요"
  info "$(wrangler --version 2>/dev/null | head -1)"
}

deploy_storage() {
  info "━━━ [1/4] packages/storage 배포 ━━━"
  cd "$ROOT/packages/storage"
  npm ci --silent
  npx tsc --noEmit && ok "타입체크 통과"
  wrangler d1 execute cloudpress-storage-meta --file=./schema.sql --remote || true
  wrangler deploy
  ok "storage 완료 → storage.cloud-press.co.kr"
}

deploy_api() {
  info "━━━ [2/4] packages/api 배포 ━━━"
  cd "$ROOT/packages/api"
  npm ci --silent
  npx tsc --noEmit && ok "타입체크 통과"
  wrangler d1 execute cloudpress-bridge --file=./schema.sql --remote || true
  wrangler deploy
  ok "api 완료 → api.cloud-press.co.kr"
}

deploy_frontend() {
  info "━━━ [3/4] apps/frontend 배포 ━━━"
  cd "$ROOT/apps/frontend"
  wrangler pages deploy . --project-name=cloudpress-bridge --branch=main
  ok "frontend 완료 → Cloudflare Pages"
  warn "루트 도메인(cloud-press.co.kr) 연결은 대시보드에서 직접: Pages → cloudpress-bridge → Custom domains"
}

deploy_worker() {
  local SITE_ID="${SITE_ID:-}"
  [[ -z "$SITE_ID" ]] && die "export SITE_ID=my-blog 필요"
  info "━━━ site-worker ($SITE_ID) — Workers 10개 ━━━"
  cd "$ROOT/packages/site-worker"
  npm ci --silent
  for i in $(seq 0 9); do
    WNAME="${SITE_ID}-w${i}"
    info "  $WNAME"
    wrangler deploy --name "$WNAME" \
      --var "SITE_ID:${SITE_ID}" --var "WORKER_INDEX:${i}"
  done
  ok "Workers 10개 완료"
  warn "공개 라우트는 대시보드에서 직접: ${WNAME%-w*}-w0 → Settings → Domains & Routes → Route 추가"
  warn "  라우트: ${SITE_ID}.cloud-press.co.kr/*  (zone: cloud-press.co.kr)"
}

setup_infra() {
  info "━━━ 최초 인프라 프로비저닝 ━━━"
  wrangler kv:namespace create CHUNKS      || warn "이미 존재"
  wrangler kv:namespace create CREDENTIALS || warn "이미 존재"
  wrangler d1 create cloudpress-storage-meta || warn "이미 존재"
  wrangler d1 create cloudpress-bridge       || warn "이미 존재"
  warn "출력된 ID를 wrangler.toml에 붙여넣고 커밋하세요."
}

setup_secrets() {
  cat << 'EOF'
# 두 값(INTERNAL_SHARED_SECRET)은 반드시 동일해야 함. 먼저 하나 생성:
#   openssl rand -hex 32

# packages/storage
wrangler secret put TEMPLATE_API_KEY       --name cloudpress-storage
wrangler secret put INTERNAL_SHARED_SECRET --name cloudpress-storage

# packages/api
wrangler secret put CF_API_TOKEN           --name cloudpress-api
wrangler secret put PAYPAL_CLIENT_ID       --name cloudpress-api
wrangler secret put PAYPAL_CLIENT_SECRET   --name cloudpress-api
wrangler secret put INTERNAL_SHARED_SECRET --name cloudpress-api

# packages/site-worker (호스팅당 10개)
for i in $(seq 0 9); do
  wrangler secret put STORAGE_API_KEY --name ${SITE_ID}-w${i}
done
EOF
}

seed() {
  STORAGE_URL="${STORAGE_URL:-https://storage.cloud-press.co.kr}"
  TEMPLATE_API_KEY="${TEMPLATE_API_KEY:?'TEMPLATE_API_KEY 환경변수 필요'}"
  info "WordPress 템플릿 시드 중..."
  curl -sf -X POST "${STORAGE_URL}/internal/provision" \
    -H "Authorization: Bearer ${TEMPLATE_API_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"siteId":"__template__","siteName":"Template","siteUrl":"https://template.cloud-press.co.kr","locale":"ko_KR","adminEmail":"admin@cloud-press.co.kr"}' \
    && ok "시드 완료"
}

check_deps
case "$TARGET" in
  storage)  deploy_storage ;;
  api)      deploy_api ;;
  frontend) deploy_frontend ;;
  worker)   deploy_worker ;;
  infra)    setup_infra ;;
  secrets)  setup_secrets ;;
  seed)     seed ;;
  all)
    deploy_storage
    deploy_api
    deploy_frontend
    ok "전체 배포 완료"
    warn "최초 1회: bash deploy/deploy.sh seed"
    ;;
  *) echo "사용법: bash deploy/deploy.sh [storage|api|frontend|worker|infra|secrets|seed|all]"; exit 1 ;;
esac
