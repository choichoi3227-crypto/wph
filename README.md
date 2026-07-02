# CloudPress Bridge

100% Cloudflare Native WordPress 호스팅 플랫폼. 서버 없이, GitHub Actions 없이, 자본금 없이.

> 레포: https://github.com/choichoi3227-crypto/wph

---

## 모노레포 구조

```
cloudpress-bridge/
  packages/
    storage/        ← 100% 자체 S3 호환 스토리지 (storage.cloud-press.co.kr)
    api/            ← 호스팅/DNS/결제/인증 API    (api.cloud-press.co.kr)
    site-worker/    ← 호스팅당 PHP-WASM 런타임 10개
  apps/
    frontend/       ← 랜딩 + 대시보드            (Cloudflare Pages)
  deploy/
    deploy.sh       ← 전체 배포 오케스트레이터
    init-repo.sh    ← GitHub 최초 푸시
    seed-php-wasm.sh← php.wasm 스토리지 시드
```

---

## 패키지 간 통신 구조

```
브라우저
  │
  ├── apps/frontend (Cloudflare Pages)
  │       정적 HTML → /api/* 호출
  │
  └── packages/api (Cloudflare Worker)
          api.cloud-press.co.kr
          │
          │  Service Binding (HTTP 왕복 없이 Worker-to-Worker 직접 호출)
          ▼
      packages/storage (Cloudflare Worker)
          storage.cloud-press.co.kr
          │
          ├── KV "CHUNKS"      바이트 데이터 (4MB 청크 / 소용량 직접)
          ├── KV "CREDENTIALS" 자격증명
          ├── D1 "META_DB"     객체 메타데이터 인덱스 (DO 대체)
          ├── DO WordPressDbDO  WordPress SQLite DB 전용
          └── DO LoadBalancerDO 헬스체크 전용

packages/site-worker (호스팅당 10개 Worker)
  ├── Service Binding → packages/storage (파일 서빙)
  ├── DO PhpRuntimeDO  PHP-WASM 실행 + VFS
  └── DO LoadBalancerDO (cloudpress-storage에서 export)
```

### Service Binding이란?

Cloudflare Workers끼리 **같은 데이터센터 내부**에서 직접 호출하는 방식이야.
일반 HTTP fetch와 달리 네트워크 왕복이 없고, 추가 비용도 없어.

```typescript
// packages/api의 코드 — packages/storage를 직접 호출
const res = await env.STORAGE_WORKER.fetch(
  "https://storage.cloud-press.co.kr/my-site/wp-config.php",
  { headers: { authorization: `Bearer ${apiKey}` } }
);
// 이게 실제 HTTP 요청처럼 보이지만 내부 직접 호출 (지연 ~0ms)
```

### wrangler.toml Service Binding 설정

```toml
# packages/api/wrangler.toml
[[services]]
binding = "STORAGE_WORKER"
service = "cloudpress-storage"   # ← packages/storage의 name
```

---

## 빠른 시작

### 1. 레포 클론

```bash
git clone https://github.com/choichoi3227-crypto/wph.git cloudpress-bridge
cd cloudpress-bridge
npm install
```

### 2. 인프라 프로비저닝 (최초 1회)

```bash
bash deploy/deploy.sh infra
```

출력된 KV ID, D1 ID를 각 `wrangler.toml`에 붙여넣고 커밋.

### 3. 시크릿 등록

```bash
bash deploy/deploy.sh secrets   # 명령어 가이드 출력
# 출력된 명령어들을 순서대로 실행
```

### 4. 전체 배포

```bash
bash deploy/deploy.sh all
```

### 5. WordPress 템플릿 시드 (최초 1회)

```bash
export TEMPLATE_API_KEY=your_key
bash deploy/deploy.sh seed
```

---

## 엔드포인트

| 서비스 | URL | 설명 |
|---|---|---|
| 스토리지 | storage.cloud-press.co.kr | S3 호환 오브젝트 스토리지 |
| API | api.cloud-press.co.kr | 호스팅/DNS/결제 REST API |
| 프론트엔드 | cloud-press.co.kr (루트/메인 도메인) | 랜딩 + 대시보드 (Cloudflare Pages) |
| 사이트 | {siteId}.cloud-press.co.kr | 호스팅된 WordPress |

---

## 도메인 구조 (cloud-press.co.kr = 루트/메인 도메인)

```
cloud-press.co.kr            ← 루트 도메인. 랜딩 + 대시보드 (Cloudflare Pages, apps/frontend)
www.cloud-press.co.kr        ← cloud-press.co.kr 로 리다이렉트
api.cloud-press.co.kr        ← packages/api (Worker, custom_domain)
storage.cloud-press.co.kr    ← packages/storage (Worker, custom_domain)
{siteId}.cloud-press.co.kr   ← 호스팅된 WordPress 사이트 (packages/site-worker)
```

**주의**: `apps/frontend/js/common.js`는 `/api`라는 상대경로로만 요청한다. 브라우저가
`cloud-press.co.kr`과 `api.cloud-press.co.kr`을 서로 다른 오리진으로 취급하기 때문에,
그대로 두면 세션 쿠키가 붙지 않고 CORS 에러가 난다. 그래서 `apps/frontend/functions/api/[[path]].js`
Pages Function이 `cloud-press.co.kr/api/*` 요청을 내부적으로 `api.cloud-press.co.kr`로 그대로
전달(proxy)한다. 브라우저는 항상 같은 오리진(cloud-press.co.kr)하고만 통신하므로 별도 CORS
설정 없이 쿠키 인증이 그대로 동작한다.

### 대시보드에서 직접 연결해야 하는 라우트

라우트/커스텀 도메인은 더 이상 `wrangler.toml`이나 배포 스크립트가 자동으로 건드리지 않는다.
Cloudflare 대시보드에서 아래 표대로 직접 연결한다.

| 대상 | 위치 | 설정 | 값 |
|---|---|---|---|
| packages/api | Workers & Pages → **cloudpress-api** → Settings → Domains & Routes | Custom Domain 추가 | `api.cloud-press.co.kr` |
| packages/storage | Workers & Pages → **cloudpress-storage** → Settings → Domains & Routes | Custom Domain 추가 | `storage.cloud-press.co.kr` |
| apps/frontend | Workers & Pages → Pages → **cloudpress-bridge** → Custom domains | Custom Domain 추가 | `cloud-press.co.kr` (+ `www.cloud-press.co.kr`, 루트로 리다이렉트되도록) |
| packages/site-worker (호스팅당) | Workers & Pages → **{siteId}-w0** → Settings → Domains & Routes | Route 추가 (zone: `cloud-press.co.kr`) | `{siteId}.cloud-press.co.kr/*` |

- `{siteId}-w0`만 공개 라우트를 갖는다. `{siteId}-w1`~`{siteId}-w9`는 공개 라우트 없이 `workers.dev`로만
  접근 가능한 상태로 둔다(향후 로드밸런싱 확장용).
- `{siteId}.cloud-press.co.kr` 라우트를 붙이려면 먼저 DNS에 `*.cloud-press.co.kr` 와일드카드 레코드
  (프록시 On, 임의의 A 레코드로 충분 — 예: `192.0.2.1`)가 zone에 존재해야 한다.
- 호스팅이 새로 생성될 때마다(`POST /api/hostings`) 해당 `{siteId}-w0`에 라우트를 수동으로 추가해야
  실제로 사이트가 열린다는 뜻이다. 자동화하려면 Cloudflare API(`PUT /zones/{zone_id}/workers/routes`)를
  호출하는 코드를 추후 추가해야 한다.

---

## 가격 정책

| 플랜 | 가격 | 주요 기능 |
|---|---|---|
| 라이트 | $15/월 | 트래픽 무제한, CDN, WAF |
| 스탠다드 | $30/월 | 라이트 + SSH, FTP, DB |
| 스마트 | $49/월 | 스탠다드 + 고급 기능 |
| DNS | $0.10/zone + $0.09/쿼리 | Cloudflare API 직결 |

---

## 패키지별 상세

### packages/storage
- **메인**: D1(메타) + KV(데이터) 하이브리드 — DO 호출 최소화
- **DO**: `WordPressDbDO`(WordPress SQLite 전용), `LoadBalancerDO`(헬스체크 전용)
- **파이프라인**: 소용량(≤64KB) KV 단일키, 대용량 4MB 청크 병렬 PUT/GET
- **인증**: AWS SigV4 + Bearer API 키 이중 지원
- **S3 호환**: PUT/GET/HEAD/DELETE/ListV2/Multipart 전체 지원

### packages/api
- **DB**: D1 (사용자/호스팅/결제/도메인 관계형 데이터)
- **인증**: 세션 쿠키 (PBKDF2 비밀번호)
- **DNS**: Cloudflare API 직접 호출
- **결제**: PayPal 주문/캡처/웹훅

### packages/site-worker
- **PHP**: `PhpRuntimeDO` — php.wasm(21MB) → DO 메모리 캐시 → WordPress 실행
- **정적 파일**: Service Binding으로 storage 직접 서빙
- **로드밸런싱**: LoadBalancerDO 헬스체크 → 라운드로빈

### apps/frontend
- **페이지**: index, feature, about, products/*, sign-up/in, dashboard/*
- **디자인**: 딥 네이비 + 블루 액센트, 개발자 친화 터미널 시그니처 요소
