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
