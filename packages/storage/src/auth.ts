/**
 * Auth v2
 * ───────
 * SigV4 + Bearer 인증. v1과 동일 로직.
 * CREDENTIALS KV에서 자격증명 조회 (DO 호출 없음).
 */

import type { Env } from "./types";

export interface AuthResult {
  ok: boolean;
  siteId?: string;
  reason?: string;
}

export async function authenticate(
  request: Request,
  body: ArrayBuffer | null,
  env: Env
): Promise<AuthResult> {
  const auth = request.headers.get("authorization") ?? "";

  // Bearer API 키
  if (auth.startsWith("Bearer ")) {
    const apiKey = auth.slice(7).trim();
    const raw    = await env.CREDENTIALS.get(`apikey:${apiKey}`);
    if (!raw) return { ok: false, reason: "invalid api key" };
    const { siteId } = JSON.parse(raw) as { siteId: string };
    return { ok: true, siteId };
  }

  // AWS SigV4
  if (auth.startsWith("AWS4-HMAC-SHA256")) {
    return verifySigV4(request, body, env);
  }

  // Presigned URL
  const url = new URL(request.url);
  if (url.searchParams.has("X-Amz-Signature")) {
    return verifyPresigned(url, env);
  }

  return { ok: false, reason: "missing authorization" };
}

async function verifySigV4(
  request: Request,
  body: ArrayBuffer | null,
  env: Env
): Promise<AuthResult> {
  const auth = request.headers.get("authorization") ?? "";
  const m    = auth.match(
    /Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request,\s*SignedHeaders=([^,]+),\s*Signature=([0-9a-f]+)/
  );
  if (!m) return { ok: false, reason: "malformed sigv4" };

  const [, accessKeyId, dateStamp, region, service, signedHeadersRaw, sig] = m;
  const raw = await env.CREDENTIALS.get(`key:${accessKeyId}`);
  if (!raw) return { ok: false, reason: "unknown access key" };
  const { siteId, secretKey } = JSON.parse(raw) as { siteId: string; secretKey: string };

  const amzDate = request.headers.get("x-amz-date") ?? "";
  const url     = new URL(request.url);
  const signedHeaders = signedHeadersRaw.split(";");
  const canonicalHeaders =
    signedHeaders.map((h) => `${h}:${h === "host" ? url.host : request.headers.get(h) ?? ""}`).join("\n") + "\n";
  const payloadHash =
    request.headers.get("x-amz-content-sha256") ??
    (await sha256Hex(body ?? new ArrayBuffer(0)));

  const canonicalRequest = [
    request.method,
    url.pathname,
    canonicalQS(url),
    canonicalHeaders,
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");

  const scope        = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope,
    await sha256Hex(enc(canonicalRequest))].join("\n");
  const signingKey   = await deriveKey(secretKey, dateStamp, region, service);
  const computed     = toHex(await hmac(signingKey, amzDate.length > 0 ? stringToSign : ""));

  if (computed !== sig) return { ok: false, reason: "signature mismatch" };
  return { ok: true, siteId };
}

async function verifyPresigned(url: URL, env: Env): Promise<AuthResult> {
  const cred = url.searchParams.get("X-Amz-Credential") ?? "";
  const [accessKeyId, dateStamp, region, service] = cred.split("/");
  if (!accessKeyId) return { ok: false, reason: "malformed presigned" };

  const raw = await env.CREDENTIALS.get(`key:${accessKeyId}`);
  if (!raw) return { ok: false, reason: "unknown access key" };
  const { siteId, secretKey } = JSON.parse(raw) as { siteId: string; secretKey: string };

  const stripped = new URL(url.toString());
  stripped.searchParams.delete("X-Amz-Signature");
  const amzDate       = url.searchParams.get("X-Amz-Date") ?? "";
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders") ?? "host";
  const provided      = url.searchParams.get("X-Amz-Signature") ?? "";

  const canonicalRequest = [
    "GET", url.pathname, canonicalQS(stripped),
    `host:${url.host}\n`, signedHeaders, "UNSIGNED-PAYLOAD",
  ].join("\n");

  const scope        = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope,
    await sha256Hex(enc(canonicalRequest))].join("\n");
  const signingKey   = await deriveKey(secretKey, dateStamp, region, service);
  const computed     = toHex(await hmac(signingKey, stringToSign));

  if (computed !== provided) return { ok: false, reason: "signature mismatch" };
  return { ok: true, siteId };
}

// ── 자격증명 발급 ─────────────────────────────────────────────────────────

export async function provisionCredentials(
  env: Env,
  siteId: string
): Promise<{ accessKeyId: string; secretKey: string; apiKey: string }> {
  const accessKeyId = `CP${randomHex(16).toUpperCase()}`;
  const secretKey   = randomHex(40);
  const apiKey      = `cp_live_${randomHex(32)}`;

  await Promise.all([
    env.CREDENTIALS.put(`key:${accessKeyId}`,  JSON.stringify({ siteId, secretKey })),
    env.CREDENTIALS.put(`apikey:${apiKey}`,     JSON.stringify({ siteId })),
    env.CREDENTIALS.put(`site:${siteId}`,       JSON.stringify({ accessKeyId, apiKey, createdAt: new Date().toISOString() })),
  ]);
  return { accessKeyId, secretKey, apiKey };
}

export async function revokeCredentials(env: Env, siteId: string): Promise<void> {
  const raw = await env.CREDENTIALS.get(`site:${siteId}`);
  if (!raw) return;
  const { accessKeyId, apiKey } = JSON.parse(raw) as { accessKeyId: string; apiKey: string };
  await Promise.all([
    env.CREDENTIALS.delete(`key:${accessKeyId}`),
    env.CREDENTIALS.delete(`apikey:${apiKey}`),
    env.CREDENTIALS.delete(`site:${siteId}`),
  ]);
}

// ── 암호화 유틸 ──────────────────────────────────────────────────────────

function enc(s: string): ArrayBuffer { return new TextEncoder().encode(s).buffer as ArrayBuffer; }
function toHex(b: ArrayBuffer): string { return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join(""); }

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", data));
}

async function hmac(key: ArrayBuffer, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc(msg));
}

async function deriveKey(secret: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate    = await hmac(enc(`AWS4${secret}`), date);
  const kRegion  = await hmac(kDate,    region);
  const kService = await hmac(kRegion,  service);
  return hmac(kService, "aws4_request");
}

function canonicalQS(url: URL): string {
  return [...url.searchParams.entries()]
    .filter(([k]) => k !== "X-Amz-Signature")
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

function randomHex(n: number): string {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}
