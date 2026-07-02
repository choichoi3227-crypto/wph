export interface Env {
  // KV
  CHUNKS: KVNamespace;
  CREDENTIALS: KVNamespace;
  // D1 — 객체 메타데이터 메인 스토어 (DO 대체)
  META_DB: D1Database;
  // DO — WordPress DB 서빙 전용
  WP_DB: DurableObjectNamespace;
  // DO — 헬스체크 전용
  LOAD_BALANCER: DurableObjectNamespace;
  // vars
  STORAGE_BASE_URL: string;
  TEMPLATE_API_KEY: string;
  SMALL_OBJECT_THRESHOLD: string; // 문자열로 바인딩됨
}

/** 소용량 객체 기준 (기본 64KB) */
export function smallThreshold(env: Env): number {
  return Number(env.SMALL_OBJECT_THRESHOLD ?? "65536");
}

export interface ObjectMeta {
  site_id: string;
  key: string;
  object_id: string;
  size: number;
  chunk_count: number;
  is_small: number;          // 0 | 1
  content_type: string;
  etag: string;
  last_modified: string;
  storage_class: string;
}

export interface MultipartPart {
  upload_id: string;
  part_number: number;
  object_id: string;
  etag: string;
  size: number;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function xmlError(code: string, message: string, status: number): Response {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<Error><Code>${code}</Code><Message>${escXml(message)}</Message></Error>`,
    { status, headers: { "content-type": "application/xml" } }
  );
}

export function escXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c] ?? c)
  );
}
