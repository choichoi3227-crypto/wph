/**
 * PhpRuntimeDO
 * ============
 * 호스팅(사이트)당 1개 존재하는 PHP 실행 Durable Object.
 *
 * 동작 흐름:
 *  1) 첫 요청: 자체 스토리지에서 php.wasm(21MB, KV 청크) 조립 → WebAssembly.compile
 *  2) @php-wasm/universal: loadPHPRuntime → new PHP(runtimeId) → PHPRequestHandler
 *  3) WordPress 필수 파일을 Emscripten VFS에 마운트
 *  4) PHPRequestHandler.request()로 HTTP 요청 처리 → 응답 반환
 *  5) DO 인스턴스가 살아있는 동안 PHP 런타임 + VFS를 메모리에 캐시
 *     (두 번째 요청부터 ~수ms 내 응답)
 */

import {
  loadPHPRuntime,
  PHP,
  PHPRequestHandler,
} from "@php-wasm/universal";
import type { PHPLoaderModule } from "@php-wasm/universal";

export interface Env {
  STORAGE_WORKER: Fetcher;
  SITE_ID: string;
  STORAGE_BASE_URL: string;
  STORAGE_API_KEY: string;
}

const PHP_WASM_KEY   = "__system__/php_8_2.wasm"; // 자체 스토리지 내 php.wasm 경로
const WP_CORE_PREFIX = "core/";                   // WordPress 코어 파일 prefix
const DOC_ROOT       = "/var/www/html";            // Emscripten VFS 루트

// WordPress 첫 요청에 반드시 필요한 파일 목록 (미리 VFS에 마운트)
const ESSENTIAL_WP_FILES = [
  "wp-config.php",
  "wp-settings.php",
  "wp-load.php",
  "wp-blog-header.php",
  "index.php",
  "wp-login.php",
  "wp-cron.php",
];

export class PhpRuntimeDO {
  private php: PHP | null = null;
  private handler: PHPRequestHandler | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    if (!this.initPromise) {
      this.initPromise = this.initialize().catch((err) => {
        this.initPromise = null; // 실패 시 다음 요청에서 재시도
        throw err;
      });
    }
    await this.initPromise;
    return this.handleRequest(request);
  }

  // ── 초기화 ────────────────────────────────────────────────────────────

  private async initialize(): Promise<void> {
    console.log(`[PhpRuntimeDO] 초기화 시작 — ${this.env.SITE_ID}`);

    // 1) php.wasm 바이너리 조립 + WebAssembly.compile
    const wasmBytes = await this.fetchPhpWasm();
    const wasmModule = await WebAssembly.compile(wasmBytes);

    // 2) PHPLoaderModule 구성 — asyncify/php_8_2.js init 함수 사용
    //    타입 선언이 없으므로 dynamic import + any cast
    const loaderJs = await import(
      /* @vite-ignore */
      "@php-wasm/web-8-2/asyncify/php_8_2.js" as string
    ) as { init: PHPLoaderModule["init"]; dependencyFilename: string; dependenciesTotalSize: number };

    const phpLoaderModule: PHPLoaderModule = {
      dependencyFilename:   loaderJs.dependencyFilename,
      dependenciesTotalSize: loaderJs.dependenciesTotalSize,
      phpWasmAsyncMode:     "asyncify",
      init:                 loaderJs.init,
    };

    // 3) PHP 런타임 초기화 (loadPHPRuntime → runtimeId → new PHP(runtimeId))
    //    instantiateWasm 옵션으로 미리 컴파일된 WebAssembly.Module을 주입
    const runtimeId = await loadPHPRuntime(phpLoaderModule, {
      instantiateWasm(
        importObject: WebAssembly.Imports,
        receiveInstance: (inst: WebAssembly.Instance, mod: WebAssembly.Module) => void
      ) {
        WebAssembly.instantiate(wasmModule, importObject).then(
          (inst) => receiveInstance(inst, wasmModule)
        );
        return {}; // emscripten에게 비동기 인스턴스화를 알리는 빈 객체
      },
    });
    this.php = new PHP(runtimeId);

    // 4) PHPRequestHandler 생성
    this.handler = new PHPRequestHandler({
      php:          this.php,
      documentRoot: DOC_ROOT,
      absoluteUrl:  `https://${this.env.SITE_ID}.cloud-press.co.kr`,
      rewriteRules: [
        // WordPress 퍼머링크: wp-admin/wp-content/wp-includes 외 모든 경로는 index.php로
        {
          match:    /^(?!\/wp-admin|\/wp-content|\/wp-includes).+$/,
          replacement: "/index.php",
        },
      ],
    });

    // 5) WordPress 필수 파일 VFS 마운트
    await this.mountEssentialFiles();

    console.log(`[PhpRuntimeDO] 초기화 완료 — ${this.env.SITE_ID}`);
  }

  // ── php.wasm 가져오기 ────────────────────────────────────────────────

  private async fetchPhpWasm(): Promise<ArrayBuffer> {
    const url = this.storageUrl(PHP_WASM_KEY);
    const res = await this.env.STORAGE_WORKER.fetch(url, {
      headers: { authorization: `Bearer ${this.env.STORAGE_API_KEY}` },
    });
    if (res.ok) return res.arrayBuffer();

    // 스토리지에 없으면 WordPress Playground CDN에서 받아 캐시
    console.log("[PhpRuntimeDO] php.wasm 미존재 — 외부 다운로드 시작");
    const CDN_URL =
      "https://playground.wordpress.net/wp-content/uploads/wp-blueprints/php_8_2.wasm";
    const dlRes = await fetch(CDN_URL, {
      headers: { "user-agent": "CloudPress-Bridge/1.0" },
    });
    if (!dlRes.ok) throw new Error(`php.wasm 다운로드 실패: ${dlRes.status}`);
    const bytes = await dlRes.arrayBuffer();

    // 스토리지에 저장 (다음 콜드스타트 시 재사용)
    await this.env.STORAGE_WORKER.fetch(url, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${this.env.STORAGE_API_KEY}`,
        "content-type": "application/wasm",
      },
      body: bytes,
    });
    return bytes;
  }

  // ── WordPress 파일 VFS 마운트 ────────────────────────────────────────

  private async mountEssentialFiles(): Promise<void> {
    const php = this.php!;

    // VFS 디렉토리 구조 생성
    for (const dir of [
      DOC_ROOT,
      `${DOC_ROOT}/wp-content`,
      `${DOC_ROOT}/wp-content/plugins`,
      `${DOC_ROOT}/wp-content/uploads`,
      `${DOC_ROOT}/wp-includes`,
      `${DOC_ROOT}/wp-admin`,
    ]) {
      try { php.mkdir(dir); } catch { /* 이미 존재 */ }
    }

    // 필수 파일 병렬 로드
    await Promise.all(
      ESSENTIAL_WP_FILES.map(async (file) => {
        const data = await this.fetchSiteFile(`${WP_CORE_PREFIX}${file}`);
        if (data) {
          php.writeFile(`${DOC_ROOT}/${file}`, new TextDecoder().decode(data));
        }
      })
    );
  }

  // ── 요청 처리 ─────────────────────────────────────────────────────────

  private async handleRequest(request: Request): Promise<Response> {
    const handler = this.handler!;
    const php     = this.php!;
    const url     = new URL(request.url);

    try {
      const bodyBuf =
        request.method !== "GET" && request.method !== "HEAD"
          ? await request.arrayBuffer()
          : undefined;

      const phpRes = await handler.request({
        url:     url.href,
        method:  request.method as import("@php-wasm/universal").HTTPMethod,
        headers: headersToRecord(request.headers),
        body:    bodyBuf ? (new Uint8Array(bodyBuf) as unknown as string) : undefined,
      });

      return new Response(phpRes.bytes.buffer as ArrayBuffer, {
        status:  phpRes.httpStatusCode,
        headers: buildResponseHeaders(phpRes.headers),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      // PHP include/require가 VFS에서 파일을 못 찾으면 lazy 마운트 후 재시도
      if (msg.includes("No such file")) {
        const recovered = await this.lazyMountAndRetry(request, msg);
        if (recovered) return recovered;
      }
      console.error("[PhpRuntimeDO] 요청 실패:", msg);
      return errorResponse(500, msg);
    }
  }

  /**
   * PHP가 파일 미존재 오류를 낼 때 스토리지에서 가져와 VFS에 쓰고 재시도.
   * WordPress는 require 체인이 깊으므로 이 과정이 여러 번 반복될 수 있다.
   */
  private async lazyMountAndRetry(
    request: Request,
    errorMsg: string
  ): Promise<Response | null> {
    const php     = this.php!;
    const handler = this.handler!;

    // 에러 메시지에서 요청된 파일 경로 추출
    // PHP fatal: require(/var/www/html/wp-includes/foo.php): failed to open stream
    const match = errorMsg.match(/(?:include|require)(?:_once)?\(([^)]+)\)/);
    if (!match) return null;

    const vfsPath    = match[1].trim();
    const relPath    = vfsPath.replace(DOC_ROOT + "/", "");
    const storageKey = `${WP_CORE_PREFIX}${relPath}`;
    const data       = await this.fetchSiteFile(storageKey);
    if (!data) return null;

    // 중간 디렉토리 보장
    const dir = vfsPath.split("/").slice(0, -1).join("/");
    try { php.mkdir(dir); } catch { /* 이미 존재 */ }
    php.writeFile(vfsPath, new TextDecoder().decode(data));

    // 재시도
    try {
      const bodyBuf =
        request.method !== "GET" && request.method !== "HEAD"
          ? await request.clone().arrayBuffer()
          : undefined;
      const url = new URL(request.url);
      const phpRes = await handler.request({
        url:     url.href,
        method:  request.method as import("@php-wasm/universal").HTTPMethod,
        headers: headersToRecord(request.headers),
        body:    bodyBuf ? (new Uint8Array(bodyBuf) as unknown as string) : undefined,
      });
      return new Response(phpRes.bytes.buffer as ArrayBuffer, {
        status:  phpRes.httpStatusCode,
        headers: buildResponseHeaders(phpRes.headers),
      });
    } catch {
      return null;
    }
  }

  // ── 스토리지 헬퍼 ────────────────────────────────────────────────────

  private storageUrl(key: string): string {
    return `${this.env.STORAGE_BASE_URL}/${this.env.SITE_ID}/${key}`;
  }

  private async fetchSiteFile(key: string): Promise<Uint8Array | null> {
    const res = await this.env.STORAGE_WORKER.fetch(this.storageUrl(key), {
      headers: { authorization: `Bearer ${this.env.STORAGE_API_KEY}` },
    });
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  }
}

// ── 유틸 ──────────────────────────────────────────────────────────────

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => { out[k] = v; });
  return out;
}

function buildResponseHeaders(headers: Record<string, string[]>): Headers {
  const out = new Headers();
  for (const [k, vals] of Object.entries(headers)) {
    for (const v of vals) {
      if (k.toLowerCase() === "set-cookie") out.append(k, v);
      else out.set(k, v);
    }
  }
  return out;
}

function errorResponse(status: number, message: string): Response {
  const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8"><title>오류 ${status}</title>
<style>
  body{font-family:monospace;background:#0b0f19;color:#e8f4fd;display:flex;
       align-items:center;justify-content:center;height:100vh;margin:0}
  .box{background:#141927;border:1px solid #2a3650;border-radius:8px;padding:2rem;max-width:520px}
  h1{color:#ef4444;margin-bottom:1rem}
  pre{color:#7a94b0;font-size:.8rem;white-space:pre-wrap;word-break:break-all}
</style></head><body>
<div class="box">
  <h1>${status} — PHP 실행 오류</h1>
  <pre>${message.replace(/[<>&"]/g, c => ({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]??c))}</pre>
</div></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
