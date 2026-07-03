-- CloudPress Storage v2 — D1 메타데이터 스키마
-- DO 대신 D1이 객체 메타데이터를 관리한다.
-- 사이트(버킷)별 격리는 site_id 컬럼으로 구현한다.

-- ── 객체 메타데이터 ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS objects (
  site_id      TEXT NOT NULL,
  key          TEXT NOT NULL,
  object_id    TEXT NOT NULL,          -- KV 청크 그룹의 고유 식별자
  size         INTEGER NOT NULL,
  chunk_count  INTEGER NOT NULL DEFAULT 1,
  is_small     INTEGER NOT NULL DEFAULT 0,  -- 1: KV 단일키, 0: 청크 분할
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  etag         TEXT NOT NULL,
  last_modified TEXT NOT NULL,
  storage_class TEXT NOT NULL DEFAULT 'STANDARD',
  PRIMARY KEY (site_id, key)
);

CREATE INDEX IF NOT EXISTS idx_objects_site    ON objects(site_id);
CREATE INDEX IF NOT EXISTS idx_objects_last_mod ON objects(site_id, last_modified);

-- ── 멀티파트 업로드 임시 상태 ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS multipart_uploads (
  upload_id    TEXT PRIMARY KEY,
  site_id      TEXT NOT NULL,
  key          TEXT NOT NULL,
  content_type TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_mp_site ON multipart_uploads(site_id);

CREATE TABLE IF NOT EXISTS multipart_parts (
  upload_id    TEXT NOT NULL,
  part_number  INTEGER NOT NULL,
  object_id    TEXT NOT NULL,          -- 파트별 KV 청크 식별자
  etag         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  PRIMARY KEY (upload_id, part_number)
);

-- ── 사이트(버킷) 메타 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sites (
  site_id      TEXT PRIMARY KEY,
  owner_id     TEXT,                   -- cloudpress-api user id
  access_key_id TEXT,
  api_key_hash  TEXT,                  -- Bearer 키 bcrypt 해시 (평문 CREDENTIALS KV에)
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  quota_bytes  INTEGER NOT NULL DEFAULT 10737418240  -- 기본 10GB
);

-- ── 스토리지 사용량 집계 (과금용) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS storage_usage (
  site_id      TEXT NOT NULL,
  period       TEXT NOT NULL,          -- "2026-07"
  total_bytes  INTEGER NOT NULL DEFAULT 0,
  object_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, period)
);

-- ── 사이트별 요청/에러 로그 (호스팅 상세 페이지 "로그" 탭) ─────────────────
CREATE TABLE IF NOT EXISTS site_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id      TEXT NOT NULL,
  level        TEXT NOT NULL DEFAULT 'info', -- info | warn | error
  message      TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_site_logs_site ON site_logs(site_id, created_at);

-- ── 호스트네임 → siteId 매핑 (site-worker 라우팅 단일 진실 공급원) ────────────
-- 기본 서브도메인({siteId}.cloud-press.co.kr), 사용자 커스텀 도메인, 멀티사이트(서브사이트)
-- 모두 이 테이블 하나로 hostname → target_site_id(= WP_DB DO / 스토리지 프리픽스 키) 를 조회한다.
CREATE TABLE IF NOT EXISTS domain_map (
  hostname        TEXT PRIMARY KEY,     -- 예: "abc123.cloud-press.co.kr" 또는 "blog.example.com"
  bucket_site_id  TEXT NOT NULL,        -- 객체 스토리지 버킷(자격증명) 기준 siteId = hosting_id
  target_site_id  TEXT NOT NULL,        -- WP_DB DO 키 = hosting_id(기본 사이트) 또는 hosting_sites.id(서브사이트)
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── 사이트 버전 정보 (php-wasm / 워드프레스 코어 / 플러그인·테마) ──────────────
CREATE TABLE IF NOT EXISTS site_versions (
  site_id       TEXT PRIMARY KEY,
  php_wasm_version TEXT NOT NULL DEFAULT '8.2.0',
  wp_core_version  TEXT NOT NULL DEFAULT '6.5',
  plugins_json     TEXT NOT NULL DEFAULT '[]', -- [{"slug":"...","version":"..."}]
  themes_json      TEXT NOT NULL DEFAULT '[]',
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
