/**
 * CloudPress Storage v2 — 메인 Worker
 * ─────────────────────────────────────
 * 엔드포인트: storage.cloud-press.co.kr/{siteId}/{objectKey}
 *
 * 파이프라인 다각화 요약:
 *  GET/HEAD   → D1 메타 직접 조회 + KV 병렬 청크 읽기 (DO 호출 없음)
 *  PUT        → KV 병렬 청크 기록 + D1 메타 기록 (DO 호출 없음)
 *  DELETE     → D1 메타 삭제 + KV 청크 비동기 삭제 (DO 호출 없음)
 *  LIST       → D1 쿼리 단독 (DO 호출 없음)
 *  Multipart  → D1 임시 상태 + KV 파트 청크 (DO 호출 없음)
 *  WP DB 쿼리 → WordPress DB DO만 (DB 전용)
 *  헬스체크   → LoadBalancer DO만 (헬스체크 전용)
 */

export { WordPressDbDO } from "./wp-db-do";
export { LoadBalancerDO } from "./load-balancer-do";

import type { Env } from "./types";
import { xmlError } from "./types";
import { authenticate } from "./auth";
import { handleInternal } from "./internal-routes";
import {
  handlePut,
  handleGet,
  handleHead,
  handleDelete,
  handleDeleteObjects,
  handleList,
  handleCreateMultipart,
  handleUploadPart,
  handleCompleteMultipart,
  handleAbortMultipart,
  handleListParts,
} from "./object-handlers";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url  = new URL(request.url);
    const path = url.pathname;

    // ── 헬스체크 ─────────────────────────────────────────────────────
    if (path === "/__health") {
      return new Response(JSON.stringify({ ok: true, version: "v2" }), {
        headers: { "content-type": "application/json" },
      });
    }

    // ── 내부 API (Service Binding 전용) ──────────────────────────────
    // 주의: 이 Worker는 storage.cloud-press.co.kr 로도 공개 노출되므로,
    // 시크릿 헤더 없이 /internal/* 를 그냥 열어두면 누구나 사이트를 생성/삭제할 수 있다.
    if (path.startsWith("/internal/")) {
      const provided = request.headers.get("x-internal-secret") ?? "";
      if (!env.INTERNAL_SHARED_SECRET || provided !== env.INTERNAL_SHARED_SECRET) {
        return new Response(JSON.stringify({ error: "forbidden" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      return handleInternal(request, env);
    }

    // ── URL 파싱: /{siteId}/{...key} ─────────────────────────────────
    const segments = path.split("/").filter(Boolean);
    if (!segments.length) {
      return new Response("CloudPress Storage v2 — storage.cloud-press.co.kr", { status: 200 });
    }

    const siteId   = segments[0];
    const objectKey = decodeURIComponent(segments.slice(1).join("/"));

    // ── 인증 ─────────────────────────────────────────────────────────
    const bodyBuf =
      request.method === "PUT" || request.method === "POST"
        ? await request.clone().arrayBuffer()
        : null;

    const auth = await authenticate(request, bodyBuf, env);
    if (!auth.ok) return xmlError("AccessDenied", auth.reason ?? "auth failed", 403);
    if (auth.siteId !== siteId) {
      return xmlError("AccessDenied", "credential does not match site", 403);
    }

    try {
      // ── 버킷 레벨 오퍼레이션 ─────────────────────────────────────
      if (!objectKey) {
        // DELETE ?delete (멀티 객체 삭제)
        if (request.method === "POST" && url.searchParams.has("delete")) {
          return handleDeleteObjects(request, env, siteId);
        }
        // GET ?list-type=2
        if (request.method === "GET") {
          return handleList(url, env, siteId);
        }
        return xmlError("InvalidRequest", "bucket-level operation not supported", 400);
      }

      // ── 멀티파트 오퍼레이션 ──────────────────────────────────────
      if (url.searchParams.has("uploads") && request.method === "POST") {
        return handleCreateMultipart(request, env, siteId, objectKey);
      }
      if (url.searchParams.has("uploadId") && url.searchParams.has("partNumber") && request.method === "PUT") {
        return handleUploadPart(request, env, siteId, objectKey, url);
      }
      if (url.searchParams.has("uploadId") && request.method === "POST") {
        return handleCompleteMultipart(env, siteId, objectKey, url);
      }
      if (url.searchParams.has("uploadId") && request.method === "DELETE") {
        return handleAbortMultipart(env, url);
      }
      if (url.searchParams.has("uploadId") && request.method === "GET") {
        return handleListParts(env, url);
      }

      // ── 오브젝트 CRUD ─────────────────────────────────────────────
      switch (request.method) {
        case "PUT":    return handlePut(request, env, siteId, objectKey);
        case "GET":    return handleGet(request, env, siteId, objectKey);
        case "HEAD":   return handleHead(env, siteId, objectKey);
        case "DELETE": return handleDelete(env, siteId, objectKey);
        default:
          return xmlError("MethodNotAllowed", `${request.method} not allowed`, 405);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "internal error";
      console.error("[Storage v2]", msg);
      return xmlError("InternalError", msg, 500);
    }
  },
};
