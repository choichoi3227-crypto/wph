/**
 * D1 Meta Store
 * ─────────────
 * v1의 StorageIndexDO(SQLite)를 D1으로 교체한다.
 * DO 호출을 완전히 제거하고 D1 직접 쿼리로 메타데이터를 처리한다.
 *
 * DO가 제거되면서 얻는 이점:
 *  - DO 콜드스타트/웜업 지연 제거
 *  - DO 동시성 제한(단일 인스턴스) 제거 — D1은 워커 수에 비례해 병렬 처리
 *  - 사이트 간 공유 쿼리 가능 (예: 전체 스토리지 사용량 집계)
 *  - 비용 절감 (DO 활성화 비용 없음)
 */

import type { ObjectMeta, Env } from "./types";

// ── 객체 메타 CRUD ──────────────────────────────────────────────────────

export async function metaPut(
  db: D1Database,
  meta: ObjectMeta
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO objects
         (site_id, key, object_id, size, chunk_count, is_small,
          content_type, etag, last_modified, storage_class)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(site_id, key) DO UPDATE SET
         object_id=excluded.object_id, size=excluded.size,
         chunk_count=excluded.chunk_count, is_small=excluded.is_small,
         content_type=excluded.content_type, etag=excluded.etag,
         last_modified=excluded.last_modified`
    )
    .bind(
      meta.site_id, meta.key, meta.object_id, meta.size,
      meta.chunk_count, meta.is_small, meta.content_type,
      meta.etag, meta.last_modified, meta.storage_class
    )
    .run();

  // 사용량 집계 업데이트 (과금용)
  const period = meta.last_modified.slice(0, 7); // "2026-07"
  await db
    .prepare(
      `INSERT INTO storage_usage (site_id, period, total_bytes, object_count)
       VALUES (?,?,?,1)
       ON CONFLICT(site_id, period) DO UPDATE SET
         total_bytes  = total_bytes  + excluded.total_bytes,
         object_count = object_count + 1`
    )
    .bind(meta.site_id, period, meta.size)
    .run();
}

export async function metaGet(
  db: D1Database,
  siteId: string,
  key: string
): Promise<ObjectMeta | null> {
  return db
    .prepare("SELECT * FROM objects WHERE site_id=? AND key=?")
    .bind(siteId, key)
    .first<ObjectMeta>();
}

export async function metaDelete(
  db: D1Database,
  siteId: string,
  key: string
): Promise<ObjectMeta | null> {
  const row = await metaGet(db, siteId, key);
  if (!row) return null;
  await db
    .prepare("DELETE FROM objects WHERE site_id=? AND key=?")
    .bind(siteId, key)
    .run();
  // 사용량 차감
  const period = new Date().toISOString().slice(0, 7);
  await db
    .prepare(
      `UPDATE storage_usage
       SET total_bytes  = MAX(0, total_bytes  - ?),
           object_count = MAX(0, object_count - 1)
       WHERE site_id=? AND period=?`
    )
    .bind(row.size, siteId, period)
    .run();
  return row;
}

export interface ListResult {
  items: Pick<ObjectMeta, "key" | "size" | "etag" | "last_modified" | "storage_class">[];
  truncated: boolean;
  nextToken: string | null;
  commonPrefixes: string[];
}

export async function metaList(
  db: D1Database,
  siteId: string,
  prefix = "",
  delimiter = "",
  maxKeys = 1000,
  continuationToken = ""
): Promise<ListResult> {
  // delimiter가 있으면 "가상 폴더" 처리 (S3 호환)
  if (delimiter) {
    return metaListWithDelimiter(db, siteId, prefix, delimiter, maxKeys, continuationToken);
  }

  const { results } = await db
    .prepare(
      `SELECT key, size, etag, last_modified, storage_class
       FROM objects
       WHERE site_id=? AND key LIKE ? || '%' AND key > ?
       ORDER BY key ASC
       LIMIT ?`
    )
    .bind(siteId, prefix, continuationToken, maxKeys + 1)
    .all<Pick<ObjectMeta, "key" | "size" | "etag" | "last_modified" | "storage_class">>();

  const truncated = results.length > maxKeys;
  const items     = truncated ? results.slice(0, maxKeys) : results;
  return {
    items,
    truncated,
    nextToken: truncated ? items[items.length - 1].key : null,
    commonPrefixes: [],
  };
}

async function metaListWithDelimiter(
  db: D1Database,
  siteId: string,
  prefix: string,
  delimiter: string,
  maxKeys: number,
  continuationToken: string
): Promise<ListResult> {
  const { results } = await db
    .prepare(
      `SELECT key, size, etag, last_modified, storage_class
       FROM objects
       WHERE site_id=? AND key LIKE ? || '%' AND key > ?
       ORDER BY key ASC
       LIMIT ?`
    )
    .bind(siteId, prefix, continuationToken, maxKeys * 2) // 여유 있게 가져와 클라이언트 측에서 처리
    .all<Pick<ObjectMeta, "key" | "size" | "etag" | "last_modified" | "storage_class">>();

  const items: typeof results         = [];
  const commonPrefixes = new Set<string>();

  for (const row of results) {
    const relative = row.key.slice(prefix.length);
    const delimIdx = relative.indexOf(delimiter);
    if (delimIdx >= 0) {
      // 공통 접두사(가상 폴더)로 분류
      commonPrefixes.add(prefix + relative.slice(0, delimIdx + delimiter.length));
    } else {
      items.push(row);
    }
    if (items.length + commonPrefixes.size >= maxKeys) break;
  }

  const allItems = items.slice(0, maxKeys);
  return {
    items: allItems,
    truncated: results.length > maxKeys,
    nextToken: allItems.length > 0 ? allItems[allItems.length - 1].key : null,
    commonPrefixes: [...commonPrefixes].sort(),
  };
}

// ── 멀티파트 CRUD ────────────────────────────────────────────────────────

export async function mpCreate(
  db: D1Database,
  uploadId: string,
  siteId: string,
  key: string,
  contentType: string
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO multipart_uploads (upload_id, site_id, key, content_type) VALUES (?,?,?,?)"
    )
    .bind(uploadId, siteId, key, contentType)
    .run();
}

export async function mpPutPart(
  db: D1Database,
  uploadId: string,
  partNumber: number,
  objectId: string,
  etag: string,
  size: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO multipart_parts (upload_id, part_number, object_id, etag, size)
       VALUES (?,?,?,?,?)
       ON CONFLICT(upload_id, part_number) DO UPDATE SET
         object_id=excluded.object_id, etag=excluded.etag, size=excluded.size`
    )
    .bind(uploadId, partNumber, objectId, etag, size)
    .run();
}

export async function mpListParts(
  db: D1Database,
  uploadId: string
): Promise<{ part_number: number; object_id: string; etag: string; size: number }[]> {
  const { results } = await db
    .prepare(
      "SELECT part_number, object_id, etag, size FROM multipart_parts WHERE upload_id=? ORDER BY part_number ASC"
    )
    .bind(uploadId)
    .all<{ part_number: number; object_id: string; etag: string; size: number }>();
  return results;
}

export async function mpGetUpload(
  db: D1Database,
  uploadId: string
): Promise<{ site_id: string; key: string; content_type: string } | null> {
  return db
    .prepare("SELECT site_id, key, content_type FROM multipart_uploads WHERE upload_id=?")
    .bind(uploadId)
    .first<{ site_id: string; key: string; content_type: string }>();
}

export async function mpCleanup(db: D1Database, uploadId: string): Promise<string[]> {
  const parts = await mpListParts(db, uploadId);
  const staleIds = parts.map((p) => p.object_id);
  await db.batch([
    db.prepare("DELETE FROM multipart_parts WHERE upload_id=?").bind(uploadId),
    db.prepare("DELETE FROM multipart_uploads WHERE upload_id=?").bind(uploadId),
  ]);
  return staleIds;
}

// ── 사이트 관리 ──────────────────────────────────────────────────────────

export async function siteCreate(
  db: D1Database,
  siteId: string,
  ownerId?: string
): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO sites (site_id, owner_id) VALUES (?,?)")
    .bind(siteId, ownerId ?? null)
    .run();
}

export async function siteExists(db: D1Database, siteId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM sites WHERE site_id = ?").bind(siteId).first();
  return !!row;
}

/** 호스팅 완전 삭제 시 사이트 메타 행 자체를 제거한다 (objects/usage는 별도로 정리됨) */
export async function siteDelete(db: D1Database, siteId: string): Promise<void> {
  await db.prepare("DELETE FROM sites WHERE site_id = ?").bind(siteId).run();
  await db.prepare("DELETE FROM storage_usage WHERE site_id = ?").bind(siteId).run();
}

export async function siteUsage(
  db: D1Database,
  siteId: string
): Promise<{ total_bytes: number; object_count: number }> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(total_bytes),0) AS total_bytes,
              COALESCE(SUM(object_count),0) AS object_count
       FROM storage_usage WHERE site_id=?`
    )
    .bind(siteId)
    .first<{ total_bytes: number; object_count: number }>();
  return row ?? { total_bytes: 0, object_count: 0 };
}
