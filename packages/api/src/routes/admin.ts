import type { Env } from "../common";
import { errorResponse, json, uuid, getAdminSetting, setAdminSetting } from "../common";
import type { AuthedUser } from "../auth-middleware";
import { createHostingForUser } from "./hostings";

// admin_settings에 저장되는 민감한 값들은 조회 API에서 마스킹해 응답한다 (마지막 4자만 노출)
const SENSITIVE_KEYS = new Set(["cf_global_api_key", "paypal_client_secret"]);

function mask(value: string): string {
  if (value.length <= 4) return "****";
  return `${"*".repeat(value.length - 4)}${value.slice(-4)}`;
}

// ── 어드민 전역 설정 ─────────────────────────────────────────────────────────
// 필요한 키: cf_global_api_key, cf_account_id, cf_account_email, paypal_client_id,
//            paypal_client_secret, paypal_env
export async function handleGetAdminSettings(env: Env): Promise<Response> {
  const keys = [
    "cf_global_api_key",
    "cf_account_id",
    "cf_account_email",
    "paypal_client_id",
    "paypal_client_secret",
    "paypal_env",
  ];
  const settings: Record<string, { value: string; configured: boolean } | null> = {};
  for (const key of keys) {
    const value = await getAdminSetting(env, key);
    settings[key] = value ? { value: SENSITIVE_KEYS.has(key) ? mask(value) : value, configured: true } : null;
  }
  return json({ settings });
}

export async function handleUpdateAdminSettings(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, string> | null;
  if (!body || typeof body !== "object") return errorResponse("invalid body");

  const allowedKeys = new Set([
    "cf_global_api_key",
    "cf_account_id",
    "cf_account_email",
    "paypal_client_id",
    "paypal_client_secret",
    "paypal_env",
  ]);

  const updated: string[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    await setAdminSetting(env, key, value.trim());
    updated.push(key);
  }
  if (!updated.length) return errorResponse("no valid settings provided");
  return json({ updated });
}

// ── 사용자 관리 ──────────────────────────────────────────────────────────────
export async function handleAdminListUsers(env: Env, url: URL): Promise<Response> {
  const q = url.searchParams.get("q");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);

  const { results } = q
    ? await env.DB.prepare(
        "SELECT id, email, name, is_admin, created_at FROM users WHERE email LIKE ? ORDER BY created_at DESC LIMIT ?"
      )
        .bind(`%${q}%`, limit)
        .all()
    : await env.DB.prepare("SELECT id, email, name, is_admin, created_at FROM users ORDER BY created_at DESC LIMIT ?")
        .bind(limit)
        .all();

  return json({ users: results });
}

export async function handleAdminSetUserRole(request: Request, env: Env, userId: string): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { isAdmin?: boolean } | null;
  if (typeof body?.isAdmin !== "boolean") return errorResponse("isAdmin (boolean) is required");

  const user = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(userId).first();
  if (!user) return errorResponse("user not found", 404);

  await env.DB.prepare("UPDATE users SET is_admin = ? WHERE id = ?").bind(body.isAdmin ? 1 : 0, userId).run();
  return json({ id: userId, isAdmin: body.isAdmin });
}

// ── 호스팅 전체 조회/관리 ──────────────────────────────────────────────────────
export async function handleAdminListHostings(env: Env, url: URL): Promise<Response> {
  const status = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);

  const { results } = status
    ? await env.DB.prepare(
        `SELECT h.id, h.site_name, h.site_url, h.plan_id, h.status, h.created_at, u.email as owner_email
         FROM hostings h JOIN users u ON u.id = h.user_id
         WHERE h.status = ? ORDER BY h.created_at DESC LIMIT ?`
      )
        .bind(status, limit)
        .all()
    : await env.DB.prepare(
        `SELECT h.id, h.site_name, h.site_url, h.plan_id, h.status, h.created_at, u.email as owner_email
         FROM hostings h JOIN users u ON u.id = h.user_id
         ORDER BY h.created_at DESC LIMIT ?`
      )
        .bind(limit)
        .all();

  return json({ hostings: results });
}

/**
 * 관리자가 결제 없이 임의 사용자에게 호스팅을 발급한다.
 * targetUserEmail로 대상 사용자를 지정하며, 없으면 새 사용자를 만들지 않고 에러를 반환한다
 * (계정이 먼저 존재해야 함 — 회원가입 없이 임의 이메일로 호스팅을 만들지 않기 위함).
 */
export async function handleAdminCreateHosting(request: Request, env: Env, admin: AuthedUser): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    targetUserEmail?: string;
    siteName?: string;
    subdomain?: string;
    planId?: string;
    locale?: string;
  } | null;

  if (!body?.targetUserEmail || !body?.siteName || !body?.subdomain || !body?.planId) {
    return errorResponse("targetUserEmail, siteName, subdomain, planId are required");
  }
  if (!["light", "standard", "smart"].includes(body.planId)) {
    return errorResponse("invalid planId");
  }
  if (!/^[a-z0-9-]{3,40}$/.test(body.subdomain)) {
    return errorResponse("subdomain must be 3-40 chars of lowercase letters, numbers, hyphens");
  }

  const targetUser = await env.DB.prepare("SELECT id, email FROM users WHERE email = ?")
    .bind(body.targetUserEmail)
    .first<{ id: string; email: string }>();
  if (!targetUser) return errorResponse("target user not found — they must sign up first", 404);

  return createHostingForUser(
    env,
    targetUser.id,
    targetUser.email,
    { siteName: body.siteName, subdomain: body.subdomain, planId: body.planId, locale: body.locale },
    { grantedByAdmin: true }
  );
}

export async function handleAdminSuspendHosting(env: Env, hostingId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT id FROM hostings WHERE id = ? AND status != 'deleted'").bind(hostingId).first();
  if (!row) return errorResponse("hosting not found", 404);
  await env.DB.prepare("UPDATE hostings SET status = 'suspended', updated_at = datetime('now') WHERE id = ?")
    .bind(hostingId)
    .run();
  return json({ id: hostingId, status: "suspended" });
}

export async function handleAdminReactivateHosting(env: Env, hostingId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT id FROM hostings WHERE id = ? AND status = 'suspended'").bind(hostingId).first();
  if (!row) return errorResponse("suspended hosting not found", 404);
  await env.DB.prepare("UPDATE hostings SET status = 'active', updated_at = datetime('now') WHERE id = ?")
    .bind(hostingId)
    .run();
  return json({ id: hostingId, status: "active" });
}

// ── 결제/구독 전체 조회 (매출 확인용) ───────────────────────────────────────────
export async function handleAdminListInvoices(env: Env, url: URL): Promise<Response> {
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);
  const { results } = await env.DB.prepare(
    `SELECT i.id, i.amount_usd_cents, i.status, i.issued_at, i.paid_at, s.hosting_id
     FROM invoices i JOIN subscriptions s ON s.id = i.subscription_id
     ORDER BY i.issued_at DESC LIMIT ?`
  )
    .bind(limit)
    .all();
  return json({ invoices: results });
}
