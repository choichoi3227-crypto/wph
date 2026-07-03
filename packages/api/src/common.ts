export interface Env {
  DB: D1Database;
  STORAGE_WORKER: Fetcher; // Service Binding to cloudpress-storage
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  STORAGE_BASE_URL: string;
  TEMPLATE_API_KEY: string;
  PAYPAL_ENV: "sandbox" | "live";
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  // storage 워커 /internal/* 호출 시 사용하는 공유 시크릿 (storage 워커와 동일한 값이어야 함)
  INTERNAL_SHARED_SECRET: string;
}

export function uuid(): string {
  return crypto.randomUUID();
}

/**
 * 어드민 설정(admin_settings 테이블)에서 값을 읽는다. 관리자가 어드민 페이지에서
 * Cloudflare 글로벌 API 키 / PayPal 자격증명 등을 등록하면 이 값이 wrangler secret보다 우선한다.
 * 값이 없으면 wrangler.toml/secret으로 설정된 기본값(fallback)을 사용한다.
 */
export async function getAdminSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM admin_settings WHERE key = ?")
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setAdminSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO admin_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  )
    .bind(key, value)
    .run();
}

export interface CloudflareCreds {
  apiToken: string; // Global API Key 또는 API Token (Authorization: Bearer로 사용)
  accountId: string;
}

/** 어드민이 등록한 Cloudflare 글로벌 API 키가 있으면 그것을, 없으면 wrangler secret 기본값을 반환 */
export async function getCloudflareCreds(env: Env): Promise<CloudflareCreds> {
  const [globalKey, accountId] = await Promise.all([
    getAdminSetting(env, "cf_global_api_key"),
    getAdminSetting(env, "cf_account_id"),
  ]);
  return {
    apiToken: globalKey ?? env.CF_API_TOKEN,
    accountId: accountId ?? env.CF_ACCOUNT_ID,
  };
}

export interface PayPalCreds {
  env: "sandbox" | "live";
  clientId: string;
  clientSecret: string;
}

export async function getPayPalCreds(env: Env): Promise<PayPalCreds> {
  const [clientId, clientSecret, payEnv] = await Promise.all([
    getAdminSetting(env, "paypal_client_id"),
    getAdminSetting(env, "paypal_client_secret"),
    getAdminSetting(env, "paypal_env"),
  ]);
  return {
    clientId: clientId ?? env.PAYPAL_CLIENT_ID,
    clientSecret: clientSecret ?? env.PAYPAL_CLIENT_SECRET,
    env: (payEnv as "sandbox" | "live") ?? env.PAYPAL_ENV,
  };
}

export async function logActivity(
  env: Env,
  hostingId: string,
  actor: string,
  action: string,
  detail?: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO activity_logs (id, hosting_id, actor, action, detail) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(uuid(), hostingId, actor, action, detail ?? null)
    .run();
}

export function randomSubdomain(len = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => chars[b % chars.length]).join("");
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function errorResponse(message: string, status = 400, code?: string): Response {
  return json({ error: message, code: code ?? null }, status);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder().encode(password);
  const keyMaterial = await crypto.subtle.importKey("raw", enc, "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  const saltHex = toHex(salt);
  const hashHex = toHex(derived);
  return `pbkdf2$100000$${saltHex}$${hashHex}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterStr, saltHex, hashHex] = stored.split("$");
  if (scheme !== "pbkdf2") return false;
  const salt = fromHex(saltHex);
  const enc = new TextEncoder().encode(password);
  const keyMaterial = await crypto.subtle.importKey("raw", enc, "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: Number(iterStr), hash: "SHA-256" },
    keyMaterial,
    256
  );
  return toHex(derived) === hashHex;
}

function toHex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
