import type { Env } from "../common";
import { errorResponse, json, uuid } from "../common";
import type { AuthedUser } from "../auth-middleware";

const VALID_PLANS = ["light", "standard", "smart"] as const;

export async function handleCreateHosting(
  request: Request,
  env: Env,
  user: AuthedUser
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    siteName?: string;
    subdomain?: string; // {subdomain}.cloudpress.app 형태로 발급
    planId?: string;
    locale?: string;
  } | null;

  if (!body?.siteName || !body?.subdomain || !body?.planId) {
    return errorResponse("siteName, subdomain, planId are required");
  }
  if (!VALID_PLANS.includes(body.planId as any)) {
    return errorResponse(`planId must be one of ${VALID_PLANS.join(", ")}`);
  }
  if (!/^[a-z0-9-]{3,40}$/.test(body.subdomain)) {
    return errorResponse("subdomain must be 3-40 chars of lowercase letters, numbers, hyphens");
  }

  const siteId = body.subdomain;
  const existing = await env.DB.prepare("SELECT id FROM hostings WHERE id = ?").bind(siteId).first();
  if (existing) return errorResponse("subdomain already taken", 409);

  const siteUrl = `https://${siteId}.cloudpress.app`;

  await env.DB.prepare(
    `INSERT INTO hostings (id, user_id, plan_id, site_name, site_url, locale, status)
     VALUES (?, ?, ?, ?, ?, ?, 'provisioning')`
  )
    .bind(siteId, user.id, body.planId, body.siteName, siteUrl, body.locale ?? "ko_KR")
    .run();

  // 실제 워드프레스 파일 적재(템플릿 복제) + 자격증명 발급은 cloudpress-storage 워크플로우 호출.
  // 시간이 걸릴 수 있으므로 비동기로 진행하고, 상태는 DB의 status 컬럼으로 폴링한다.
  const provisionRes = await env.STORAGE_WORKER.fetch("https://internal/provision-hosting", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      siteId,
      siteName: body.siteName,
      siteUrl,
      locale: body.locale ?? "ko_KR",
      adminEmail: user.email,
    }),
  });

  if (!provisionRes.ok) {
    await env.DB.prepare("UPDATE hostings SET status = 'error' WHERE id = ?").bind(siteId).run();
    return errorResponse("provisioning failed", 502);
  }

  const result = (await provisionRes.json()) as {
    accessKeyId: string;
    secretKey: string;
    apiKey: string;
  };

  await env.DB.prepare(
    `UPDATE hostings SET status = 'active', storage_access_key_id = ?, storage_secret_key = ?, storage_api_key = ?, updated_at = datetime('now')
     WHERE id = ?`
  )
    .bind(result.accessKeyId, result.secretKey, result.apiKey, siteId)
    .run();

  return json({ id: siteId, siteName: body.siteName, siteUrl, planId: body.planId, status: "active" }, 201);
}

export async function handleListHostings(env: Env, user: AuthedUser): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, site_name, site_url, plan_id, status, created_at FROM hostings WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(user.id)
    .all();
  return json({ hostings: results });
}

export async function handleGetHosting(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, site_name, site_url, plan_id, locale, status, created_at FROM hostings WHERE id = ? AND user_id = ?`
  )
    .bind(hostingId, user.id)
    .first();
  if (!row) return errorResponse("hosting not found", 404);
  return json(row);
}

export async function handleDeleteHosting(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT id FROM hostings WHERE id = ? AND user_id = ?")
    .bind(hostingId, user.id)
    .first();
  if (!row) return errorResponse("hosting not found", 404);

  await env.DB.prepare("UPDATE hostings SET status = 'deleted', updated_at = datetime('now') WHERE id = ?")
    .bind(hostingId)
    .run();

  // 스토리지 데이터 정리는 STORAGE_WORKER에 비동기 위임 (자격증명 폐기 + 객체 삭제)
  await env.STORAGE_WORKER.fetch("https://internal/deprovision-hosting", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ siteId: hostingId }),
  });

  return new Response(null, { status: 204 });
}

export async function handleUpdatePlan(
  request: Request,
  env: Env,
  user: AuthedUser,
  hostingId: string
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { planId?: string } | null;
  if (!body?.planId || !VALID_PLANS.includes(body.planId as any)) {
    return errorResponse(`planId must be one of ${VALID_PLANS.join(", ")}`);
  }
  const row = await env.DB.prepare("SELECT id FROM hostings WHERE id = ? AND user_id = ?")
    .bind(hostingId, user.id)
    .first();
  if (!row) return errorResponse("hosting not found", 404);

  await env.DB.prepare("UPDATE hostings SET plan_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(body.planId, hostingId)
    .run();
  return json({ id: hostingId, planId: body.planId });
}
