# CloudPress Bridge — 전체 배포 가이드

GitHub Actions 없이 `wrangler` CLI만으로 배포한다 (자본금 제로, 외부 CI 제로).

---

## 프로젝트 구조

```
cloudpress-storage/      ← [1] S3 호환 자체 스토리지 + 내부 프로비저닝 API
cloudpress-api/          ← [2] 호스팅/DNS/결제/인증 API (D1 + Service Binding)
cloudpress-frontend/     ← [3] 정적 페이지 (Cloudflare Pages)
cloudpress-site-worker/  ← [4] 호스팅별 PHP-WASM 런타임 Worker (사이트당 10개)
deploy.sh                ← 전체 배포 오케스트레이터
```

---

## 최초 1회 — 인프라 프로비저닝

```bash
# KV 네임스페이스 2개 생성
wrangler kv:namespace create CHUNKS
wrangler kv:namespace create CREDENTIALS
# → 출력된 id를 cloudpress-storage/wrangler.toml에 붙여넣기

# D1 데이터베이스 생성
wrangler d1 create cloudpress-bridge
# → 출력된 database_id를 cloudpress-api/wrangler.toml에 붙여넣기

# 또는 한 번에:
bash deploy.sh infra
```

---

## 최초 1회 — 시크릿 등록

```bash
# cloudpress-api
wrangler secret put CF_API_TOKEN         --name cloudpress-api
wrangler secret put PAYPAL_CLIENT_ID     --name cloudpress-api
wrangler secret put PAYPAL_CLIENT_SECRET --name cloudpress-api

# cloudpress-storage (템플릿 시드용 API 키 — 임의 생성해서 등록)
wrangler secret put TEMPLATE_API_KEY     --name cloudpress-storage

# cloudpress-api의 wrangler.toml에도 같은 값으로 업데이트
# TEMPLATE_API_KEY = "your-key-here"
```

---

## 배포 순서

```bash
# 1. 스토리지 Worker 배포 (먼저 배포해야 cloudpress-api Service Binding이 연결됨)
bash deploy.sh storage

# 2. API Worker 배포 (D1 스키마도 자동 적용)
bash deploy.sh api

# 3. 프론트엔드 Pages 배포
bash deploy.sh frontend

# 또는 한 번에:
bash deploy.sh all
```

---

## 최초 1회 — WordPress 템플릿 시드

```bash
# 스토리지 배포 완료 후 WordPress 코어/플러그인/테마를 __template__ 버킷에 1회 다운로드
export STORAGE_URL=https://cloudpress-storage.workers.dev
export TEMPLATE_API_KEY=your-key-here
bash deploy.sh seed
```

---

## 호스팅 생성 시 자동 배포 (사이트 Workers 10개)

API가 `/internal/provision-hosting`을 통해 내부적으로 호출한다.
필요 시 수동으로도 실행 가능:

```bash
export SITE_ID=my-blog
bash deploy.sh workers
```

---

## 배포 후 체크리스트

| 항목 | 확인 방법 |
|---|---|
| 스토리지 헬스 | `curl https://cloudpress-storage.workers.dev/` |
| API 인증 | `curl -X POST https://cloudpress-api.workers.dev/api/auth/sign-up -d '{"email":"...","password":"..."}'` |
| 프론트엔드 | Cloudflare Pages 대시보드 또는 배포 URL 접속 |
| 템플릿 시드 | `curl -X POST https://cloudpress-storage.workers.dev/internal/seed-template` |
| PayPal | `PAYPAL_ENV = "live"` 로 변경 후 재배포 (현재 sandbox) |

---

## 시스템 전체 아키텍처

```
사용자 브라우저
    │
    ├── cloudpress-frontend (Cloudflare Pages)
    │       sign-up / sign-in / dashboard / products 등 정적 HTML
    │
    ├── cloudpress-api (Cloudflare Worker)
    │       /api/auth  /api/hostings  /api/dns  /api/payments
    │       │  ├── D1  (사용자/호스팅/결제/도메인 관계형 데이터)
    │       │  ├── Service Binding → cloudpress-storage (프로비저닝)
    │       │  └── Cloudflare API  (Zone/DNS 레코드)
    │
    └── 호스팅 사이트 요청
            │
            ▼
        cloudpress-site-worker (사이트당 10개 Workers)
            │  ├── LoadBalancerDO (헬스체크 / 라운드로빈)
            │  ├── Service Binding → cloudpress-storage (파일 서빙)
            │  └── PHP-WASM 런타임 (WordPress 실행)
            │
            ▼
        cloudpress-storage (Cloudflare Worker)
            ├── KV "CHUNKS"      — 파일 청크 바이트 (4MB 단위)
            ├── DO StorageIndexDO — 객체 메타데이터 인덱스 (SQLite)
            └── DO LoadBalancerDO — Workers 헬스체크 + SQLite DB 장애복구
```

---

## 완료된 단계

- ✅ **백엔드** — 자체 S3 호환 스토리지 (Workers + KV + DO, SigV4 + Bearer 인증)
- ✅ **워크플로우** — WordPress 자동 설치 (템플릿 시드 + 복제 + wp-config 개인화)
- ✅ **API** — 호스팅/DNS(Cloudflare API)/가격/결제(PayPal)/인증 REST API
- ✅ **프론트엔드** — index/feature/about/products/sign-up/sign-in/dashboard 전 페이지
- ✅ **배포 파일** — deploy.sh (GitHub Actions 없이 wrangler 직접 배포)

---

## 다음 단계 (선택적 개선)

- **PHP-WASM 실제 통합**: `cloudpress-site-worker/src/index.ts`의 `handlePhp()` 함수에 `@cloudflare/php-workers-sdk` 연결
- **어드민 패널**: 노트의 [어드민 기능] 항목 (사용자 관리, 트래픽 모니터링, 커스터마이징)
- **PayPal live 전환**: `cloudpress-api/wrangler.toml`에서 `PAYPAL_ENV = "live"` 로 변경
- **DNS 쿼리 카운팅**: D1의 `dns_usage` 테이블 집계 로직 추가 (현재 레코드 구조만 있음)
- **SSH/FTP 접속** (스탠다드 이상): Cloudflare Tunnel 또는 별도 Workers 연결 필요
