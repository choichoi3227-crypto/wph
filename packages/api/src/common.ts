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
