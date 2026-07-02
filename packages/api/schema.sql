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
