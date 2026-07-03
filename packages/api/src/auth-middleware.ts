import type { Env } from "./common";
import { uuid } from "./common";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14일

export interface AuthedUser {
  id: string;
  email: string;
  isAdmin: boolean;
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = uuid() + uuid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(token, userId, expiresAt)
    .run();
  return token;
}

export async function destroySession(env: Env, token: string): Promise<void> {
  await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

export async function authenticate(request: Request, env: Env): Promise<AuthedUser | null> {
  const authHeader = request.headers.get("authorization") ?? "";
  const cookie = request.headers.get("cookie") ?? "";
  let token = "";

  if (authHeader.startsWith("Bearer ")) {
    token = authHeader.slice("Bearer ".length).trim();
  } else {
    const match = cookie.match(/(?:^|;\s*)cp_session=([^;]+)/);
    if (match) token = decodeURIComponent(match[1]);
  }
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT u.id as id, u.email as email, u.is_admin as is_admin, s.expires_at as expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ?`
  )
    .bind(token)
    .first<{ id: string; email: string; is_admin: number; expires_at: string }>();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(env, token);
    return null;
  }

  return { id: row.id, email: row.email, isAdmin: !!row.is_admin };
}

/** 어드민 전용 라우트 가드. 어드민이 아니면 null을 반환(호출부에서 403 처리). */
export function requireAdmin(user: AuthedUser): boolean {
  return user.isAdmin;
}

export function sessionCookie(token: string): string {
  return `cp_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearSessionCookie(): string {
  return `cp_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
