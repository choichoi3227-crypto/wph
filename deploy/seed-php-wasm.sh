#!/usr/bin/env bash
# =============================================================================
# seed-php-wasm.sh
# php.wasm(~21MB)을 WordPress Playground CDN에서 다운로드해
# 자체 스토리지(__system__/php_8_2.wasm)에 시드한다.
#
# 사용법:
#   export STORAGE_URL=https://cloudpress-storage.workers.dev
#   export SITE_ID=__system__   # 시스템 전역 버킷
#   export STORAGE_API_KEY=cp_live_...
#   bash seed-php-wasm.sh
#
# cloudpress-storage 배포 + TEMPLATE_API_KEY 시크릿 등록 후 실행할 것.
# PhpRuntimeDO가 자동으로 CDN 다운로드 + 시드를 수행하므로
# 이 스크립트는 미리 배치해 콜드스타트 지연을 없애는 선택적 최적화임.
# =============================================================================
set -euo pipefail

STORAGE_URL="${STORAGE_URL:?'STORAGE_URL 환경변수 필요'}"
SITE_ID="${SITE_ID:-__system__}"
STORAGE_API_KEY="${STORAGE_API_KEY:?'STORAGE_API_KEY 환경변수 필요'}"
PHP_WASM_URL="https://playground.wordpress.net/wp-content/uploads/wp-blueprints/php_8_2.wasm"
DEST_KEY="__system__/php_8_2.wasm"
TMP="/tmp/php_8_2.wasm"

echo "[1/3] php.wasm 다운로드 중 (~21MB)..."
curl -fL "$PHP_WASM_URL" -o "$TMP" \
  -H "user-agent: CloudPress-Bridge/1.0" \
  --progress-bar

echo "[2/3] 자체 스토리지에 업로드 중..."
curl -fX PUT "${STORAGE_URL}/${SITE_ID}/${DEST_KEY}" \
  -H "Authorization: Bearer ${STORAGE_API_KEY}" \
  -H "Content-Type: application/wasm" \
  --data-binary "@${TMP}"

echo "[3/3] 완료!"
rm -f "$TMP"
echo "php.wasm → ${STORAGE_URL}/${SITE_ID}/${DEST_KEY}"
echo "PhpRuntimeDO 콜드스타트 시 추가 다운로드 없이 즉시 사용됩니다."
