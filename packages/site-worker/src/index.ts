/**
 * CloudPress Site Worker
 * ----------------------
 * 호스팅(사이트)당 10개 배포되는 엣지 런타임 Worker.
 *
 * 요청 흐름:
 *  /__health       → 즉시 200 (LoadBalancerDO 헬스체크용)
 *  정적 파일(.css/.js/.png 등) → STORAGE_WORKER Service Binding으로 직접 서빙 (빠름)
 *  .php 요청 / WP 퍼머링크    → PhpRuntimeDO로 전달 → PHP-WASM 실행 → 응답 반환
 */

export { PhpRuntimeDO } from "./php-runtime-do";

export interface Env {
  STORAGE_WORKER: Fetcher;
  PHP_RUNTIME: DurableObjectNamespace;
  SITE_ID: string;
  WORKER_INDEX: string;
  STORAGE_BASE_URL: string;
  STORAGE_API_KEY: string;
}

// 정적 파일로 확정 처리할 확장자 목록
const STATIC_EXTS = new Set([
  "css", "js", "mjs", "map",
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "avif",
  "woff", "woff2", "ttf", "otf", "eot",
  "pdf", "zip", "gz",
  "mp4", "mp3", "webm", "ogg",
  "xml", "txt", "csv", "json",
]);

const CACHE_TTL: Record<string, number> = {
  css: 31536000, js: 31536000, mjs: 31536000,
  png: 2592000, jpg: 2592000, jpeg: 2592000, gif: 2592000,
  webp: 2592000, svg: 86400, ico: 86400, avif: 2592000,
  woff: 31536000, woff2: 31536000, ttf: 31536000,
  xml: 3600, json: 300,
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── 헬스체크 ───────────────────────────────────────────────────────
    if (path === "/__health") {
      return new Response(
        JSON.stringify({ ok: true, site: env.SITE_ID, worker: env.WORKER_INDEX }),
        { headers: { "content-type": "application/json" } }
      );
    }

    const ext = path.split(".").pop()?.toLowerCase() ?? "";

    // ── 정적 파일 → STORAGE_WORKER 직접 서빙 ──────────────────────────
    if (STATIC_EXTS.has(ext)) {
      return serveStatic(request, env, path, ext);
    }

    // ── PHP / WP 퍼머링크 → PhpRuntimeDO ─────────────────────────────
    return servePhp(request, env);
  },
};

// ── 정적 파일 서빙 ────────────────────────────────────────────────────

async function serveStatic(
  request: Request,
  env: Env,
  path: string,
  ext: string
): Promise<Response> {
  // WordPress 정적 파일은 스토리지의 core/ 접두사 아래 있음
  const storageKey = `core${path}`;
  const storageUrl = `${env.STORAGE_BASE_URL}/${env.SITE_ID}/${storageKey}`;

  const storageRes = await env.STORAGE_WORKER.fetch(storageUrl, {
    method: request.method,
    headers: { authorization: `Bearer ${env.STORAGE_API_KEY}` },
  });

  if (!storageRes.ok) {
    // wp-content/uploads 처럼 core/ prefix 없이 저장된 파일 시도
    const altUrl = `${env.STORAGE_BASE_URL}/${env.SITE_ID}${path}`;
    const altRes = await env.STORAGE_WORKER.fetch(altUrl, {
      headers: { authorization: `Bearer ${env.STORAGE_API_KEY}` },
    });
    if (!altRes.ok) return new Response("Not Found", { status: 404 });
    return buildStaticResponse(altRes, ext);
  }

  return buildStaticResponse(storageRes, ext);
}

function buildStaticResponse(storageRes: Response, ext: string): Response {
  const ttl = CACHE_TTL[ext] ?? 3600;
  const headers = new Headers(storageRes.headers);
  headers.set("cache-control", `public, max-age=${ttl}, stale-while-revalidate=${ttl * 2}`);
  headers.set("vary", "Accept-Encoding");
  return new Response(storageRes.body, { status: storageRes.status, headers });
}

// ── PHP 요청 → PhpRuntimeDO ───────────────────────────────────────────

async function servePhp(request: Request, env: Env): Promise<Response> {
  // 사이트당 1개의 PhpRuntimeDO 인스턴스 (idFromName으로 항상 같은 인스턴스)
  const doId = env.PHP_RUNTIME.idFromName(env.SITE_ID);
  const stub = env.PHP_RUNTIME.get(doId);

  try {
    return await stub.fetch(request);
  } catch (err: any) {
    console.error("[Site Worker] PhpRuntimeDO 오류:", err?.message);
    return phpErrorPage(err?.message ?? "PHP 런타임 오류");
  }
}

function phpErrorPage(message: string): Response {
  const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>서버 오류</title>
<style>
  body { font-family: monospace; background:#0b0f19; color:#e8f4fd; display:flex;
         align-items:center; justify-content:center; height:100vh; margin:0; }
  .box { background:#141927; border:1px solid #2a3650; border-radius:8px;
         padding:2rem; max-width:480px; }
  h1 { color:#ef4444; margin-bottom:1rem; }
  pre { color:#7a94b0; font-size:.8rem; white-space:pre-wrap; word-break:break-all; }
</style></head><body>
<div class="box">
  <h1>500 — PHP 실행 오류</h1>
  <pre>${escapeHtml(message)}</pre>
  <p style="margin-top:1rem;color:#7a94b0;font-size:.8rem">
    오류가 지속되면 <a href="https://cloud-press.co.kr/dashboard/index.html" style="color:#3b82f6">대시보드</a>를 통해 지원팀에 문의하세요.
  </p>
</div></body></html>`;
  return new Response(html, {
    status: 500,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"]/g, c =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c)
  );
}
