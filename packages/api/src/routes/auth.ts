import type { Env } from "../common";
import { errorResponse, hashPassword, json, uuid, verifyPassword } from "../common";
import { authenticate, createSession, destroySession, sessionCookie, clearSessionCookie } from "../auth-middleware";

export async function handleSignUp(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    email?: string;
    password?: string;
    name?: string;
  } | null;
  if (!body?.email || !body?.password) {
    return errorResponse("email and password are required");
  }
  if (body.password.length < 8) {
    return errorResponse("password must be at least 8 characters");
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(body.email).first();
  if (existing) return errorResponse("email already registered", 409);

  const id = uuid();
  const passwordHash = await hashPassword(body.password);
  await env.DB.prepare("INSERT INTO users (id, email, password_hash, name) VALUES (?, ?, ?, ?)")
    .bind(id, body.email, passwordHash, body.name ?? null)
    .run();

  const token = await createSession(env, id);
  return new Response(JSON.stringify({ id, email: body.email }), {
    status: 201,
    headers: { "content-type": "application/json", "set-cookie": sessionCookie(token) },
  });
}

export async function handleSignIn(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { email?: string; password?: string } | null;
  if (!body?.email || !body?.password) return errorResponse("email and password are required");

  const user = await env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ?")
    .bind(body.email)
    .first<{ id: string; password_hash: string }>();
  if (!user) return errorResponse("invalid credentials", 401);

  const valid = await verifyPassword(body.password, user.password_hash);
  if (!valid) return errorResponse("invalid credentials", 401);

  const token = await createSession(env, user.id);
  return new Response(JSON.stringify({ id: user.id, email: body.email }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": sessionCookie(token) },
  });
}

export async function handleSignOut(request: Request, env: Env): Promise<Response> {
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(/(?:^|;\s*)cp_session=([^;]+)/);
  if (match) await destroySession(env, decodeURIComponent(match[1]));
  return new Response(null, { status: 204, headers: { "set-cookie": clearSessionCookie() } });
}

export async function handleMe(request: Request, env: Env): Promise<Response> {
  const user = await authenticate(request, env);
  if (!user) return errorResponse("not authenticated", 401);
  return json(user);
}
