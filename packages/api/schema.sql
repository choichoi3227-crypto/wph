-- CloudPress Bridge D1 Schema
-- 사용자/호스팅/결제/도메인 등 관계형 데이터. 사이트별 운영 핫데이터는 별도 DO(StorageIndexDO, LoadBalancerDO)에 있음.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,                  -- uuid
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_admin INTEGER NOT NULL DEFAULT 0
);

-- 가격 정책: 노트 [가격] 항목
-- 1) 라이트 $15/월 - 트래픽 무제한, CDN/WAF 기본 제공
-- 2) 스탠다드 $30/월 - 라이트 전체 + SSH/FTP/DB
-- 3) 스마트 $49/월 - 스탠다드 전체 + 기타 기능
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,                  -- "light" | "standard" | "smart"
  name TEXT NOT NULL,
  price_usd_cents INTEGER NOT NULL,
  features_json TEXT NOT NULL           -- JSON 배열: 기능 목록
);

INSERT OR IGNORE INTO plans (id, name, price_usd_cents, features_json) VALUES
  ('light', '라이트', 1500, '["트래픽 무제한","CDN 기본 제공","WAF 기본 제공"]'),
  ('standard', '스탠다드', 3000, '["라이트 전체 포함","SSH 접속","FTP 접속","DB 직접 접근"]'),
  ('smart', '스마트', 4900, '["스탠다드 전체 포함","기타 고급 기능"]');

CREATE TABLE IF NOT EXISTS hostings (
  id TEXT PRIMARY KEY,                  -- siteId (스토리지 버킷명과 동일)
  user_id TEXT NOT NULL REFERENCES users(id),
  plan_id TEXT NOT NULL REFERENCES plans(id),
  site_name TEXT NOT NULL,
  site_url TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'ko_KR',
  status TEXT NOT NULL DEFAULT 'provisioning', -- provisioning | active | suspended | deleted
  storage_access_key_id TEXT,
  storage_secret_key TEXT,
  storage_api_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hostings_user ON hostings(user_id);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,                  -- uuid
  hosting_id TEXT NOT NULL REFERENCES hostings(id),
  domain_name TEXT NOT NULL UNIQUE,
  cf_zone_id TEXT,                      -- Cloudflare Zone ID
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | error
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_domains_hosting ON domains(hosting_id);

CREATE TABLE IF NOT EXISTS dns_records (
  id TEXT PRIMARY KEY,                  -- uuid
  domain_id TEXT NOT NULL REFERENCES domains(id),
  cf_record_id TEXT,                    -- Cloudflare DNS record ID
  type TEXT NOT NULL,                   -- A | AAAA | CNAME | TXT | MX 등
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  ttl INTEGER NOT NULL DEFAULT 1,       -- 1 = auto
  proxied INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dns_domain ON dns_records(domain_id);

-- 노트 [가격(DNS)] zone당 $0.1, 쿼리당 $0.09 과금용 사용량 집계
CREATE TABLE IF NOT EXISTS dns_usage (
  domain_id TEXT NOT NULL REFERENCES domains(id),
  period TEXT NOT NULL,                 -- "2026-06"
  query_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (domain_id, period)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,                  -- uuid
  hosting_id TEXT NOT NULL REFERENCES hostings(id),
  paypal_subscription_id TEXT,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | cancelled | suspended
  current_period_end TEXT,
  granted_by_admin INTEGER NOT NULL DEFAULT 0, -- 1이면 관리자가 결제 없이 발급 (청구 대상 아님)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,                  -- uuid
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id),
  amount_usd_cents INTEGER NOT NULL,
  paypal_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'unpaid', -- unpaid | paid | failed | refunded
  issued_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_invoices_subscription ON invoices(subscription_id);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 우선순위 1 추가: 멀티사이트 (하나의 호스팅 = 인프라, 그 안에 여러 사이트) ──────
CREATE TABLE IF NOT EXISTS hosting_sites (
  id TEXT PRIMARY KEY,                  -- uuid
  hosting_id TEXT NOT NULL REFERENCES hostings(id),
  subdomain TEXT NOT NULL UNIQUE,       -- "{random}.cloud-press.co.kr" 전체 호스트네임
  domain_id TEXT REFERENCES domains(id),-- NULL = 기본 cloud-press.co.kr 서브도메인 / 값 있음 = 사용자 개인 도메인의 서브도메인
  site_url TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'provisioning', -- provisioning | active | error | deleted
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hosting_sites_hosting ON hosting_sites(hosting_id);

-- ── 인증서 상태 (도메인당 1개, Google Trust Services 기반 자동 발급 추적) ─────────
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY,
  domain_id TEXT NOT NULL REFERENCES domains(id),
  cert_authority TEXT NOT NULL DEFAULT 'google_trust',
  tls_version TEXT NOT NULL DEFAULT 'TLSv1.3', -- 항상 최신 TLS만 허용
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | expired | error
  issued_at TEXT,
  expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_certificates_domain ON certificates(domain_id);

-- ── 백업 ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY,
  hosting_id TEXT NOT NULL REFERENCES hostings(id),
  status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed | restoring
  size_bytes INTEGER,
  storage_key TEXT,                     -- storage 워커 내 백업 아카이브 오브젝트 키
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_backups_hosting ON backups(hosting_id);

-- ── 활동 로그 (호스팅 상세 페이지의 "로그" 탭용) ───────────────────────────────
CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  hosting_id TEXT NOT NULL,
  actor TEXT,                           -- user id 또는 'system' / 'admin'
  action TEXT NOT NULL,                 -- 예: hosting.created, cache.purged, plan.updated
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_hosting ON activity_logs(hosting_id, created_at);

-- ── 어드민 전역 설정 (Cloudflare 글로벌 API 키 등 런타임 설정) ───────────────────
-- 주의: value는 배포 환경에서 반드시 암호화하거나 최소한 D1 접근을 관리자 API로만 제한할 것.
CREATE TABLE IF NOT EXISTS admin_settings (
  key TEXT PRIMARY KEY,                 -- cf_global_api_key | cf_account_email | cf_account_id | paypal_client_id | paypal_client_secret | paypal_env
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 등록된 결제 수단 (PayPal Vault) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_methods (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  paypal_payment_token_id TEXT NOT NULL, -- PayPal Vault v3 payment-tokens id
  payer_email TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_user ON payment_methods(user_id);

