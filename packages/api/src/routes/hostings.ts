import type { Env } from "../common";
import { errorResponse, json, uuid, logActivity, getCloudflareCreds } from "../common";
import type { AuthedUser } from "../auth-middleware";

const VALID_PLANS = ["light", "standard", "smart"] as const;
export const ROOT_DOMAIN = "cloud-press.co.kr";

export async function handleCreateHosting(
  request: Request,
  env: Env,
  user: AuthedUser
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    siteName?: string;
    subdomain?: string; // {subdomain}.cloud-press.co.kr 형태로 발급
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

  return createHostingForUser(
    env,
    user.id,
    user.email,
    { siteName: body.siteName, subdomain: body.subdomain, planId: body.planId, locale: body.locale },
    { grantedByAdmin: false }
  );
}

/** 내부 공용 로직: 일반 사용자 라우트 / 관리자 라우트(handleAdminCreateHosting)가 함께 사용한다 */
export async function createHostingForUser(
  env: Env,
  ownerUserId: string,
  ownerEmail: string,
  body: { siteName: string; subdomain: string; planId: string; locale?: string },
  opts: { grantedByAdmin: boolean }
): Promise<Response> {
  const siteId = body.subdomain;
  const existing = await env.DB.prepare("SELECT id FROM hostings WHERE id = ?").bind(siteId).first();
  if (existing) return errorResponse("subdomain already taken", 409);

  const siteUrl = `https://${siteId}.${ROOT_DOMAIN}`;

  await env.DB.prepare(
    `INSERT INTO hostings (id, user_id, plan_id, site_name, site_url, locale, status)
     VALUES (?, ?, ?, ?, ?, ?, 'provisioning')`
  )
    .bind(siteId, ownerUserId, body.planId, body.siteName, siteUrl, body.locale ?? "ko_KR")
    .run();

  const provisionRes = await env.STORAGE_WORKER.fetch("https://internal/internal/provision", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": env.INTERNAL_SHARED_SECRET,
    },
    body: JSON.stringify({
      siteId,
      siteName: body.siteName,
      siteUrl,
      locale: body.locale ?? "ko_KR",
      adminEmail: ownerEmail,
    }),
  });

  if (!provisionRes.ok) {
    await env.DB.prepare("UPDATE hostings SET status = 'error' WHERE id = ?").bind(siteId).run();
    await logActivity(env, siteId, ownerUserId, "hosting.provision_failed");
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

  // 기본(primary) 사이트를 hosting_sites에 등록 — 멀티사이트 구조의 첫 사이트
  await env.DB.prepare(
    `INSERT INTO hosting_sites (id, hosting_id, subdomain, domain_id, site_url, is_primary, status)
     VALUES (?, ?, ?, NULL, ?, 1, 'active')`
  )
    .bind(uuid(), siteId, `${siteId}.${ROOT_DOMAIN}`, siteUrl)
    .run();

  // site-worker가 이 호스트네임으로 들어오는 요청을 라우팅할 수 있도록 매핑 등록
  await env.STORAGE_WORKER.fetch("https://internal/internal/domain-map/set", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SHARED_SECRET },
    body: JSON.stringify({ hostname: `${siteId}.${ROOT_DOMAIN}`, bucketSiteId: siteId, targetSiteId: siteId }),
  }).catch(() => null);

  // 관리자가 무결제로 발급한 경우, 결제 없이 즉시 active인 구독 레코드를 만든다 (청구 대상 아님)
  if (opts.grantedByAdmin) {
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, hosting_id, plan_id, status, granted_by_admin, current_period_end)
       VALUES (?, ?, ?, 'active', 1, NULL)`
    )
      .bind(uuid(), siteId, body.planId)
      .run();
  }

  await logActivity(env, siteId, ownerUserId, "hosting.created", `plan=${body.planId}`);

  return json({ id: siteId, siteName: body.siteName, siteUrl, planId: body.planId, status: "active" }, 201);
}

export async function handleListHostings(env: Env, user: AuthedUser): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT id, site_name, site_url, plan_id, status, created_at FROM hostings WHERE user_id = ? AND status != 'deleted' ORDER BY created_at DESC`
  )
    .bind(user.id)
    .all();
  return json({ hostings: results });
}

export async function handleGetHosting(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, site_name, site_url, plan_id, locale, status, created_at FROM hostings WHERE id = ? AND user_id = ? AND status != 'deleted'`
  )
    .bind(hostingId, user.id)
    .first();
  if (!row) return errorResponse("hosting not found", 404);
  return json(row);
}

/** 소유권 검증 공용 헬퍼 (호스팅 상세 하위 라우트들이 재사용) */
export async function assertHostingOwner(env: Env, user: AuthedUser, hostingId: string): Promise<boolean> {
  if (user.isAdmin) {
    const row = await env.DB.prepare("SELECT id FROM hostings WHERE id = ? AND status != 'deleted'")
      .bind(hostingId)
      .first();
    return !!row;
  }
  const row = await env.DB.prepare("SELECT id FROM hostings WHERE id = ? AND user_id = ? AND status != 'deleted'")
    .bind(hostingId, user.id)
    .first();
  return !!row;
}

/**
 * 호스팅 완전 삭제.
 * - storage 워커에 deprovision을 호출해 "성공을 확인한 뒤에만" DB 상태를 deleted로 바꾼다.
 * - 하위 리소스(도메인, DNS 레코드, 인증서, 멀티사이트 항목, 구독)를 전부 정리한다.
 * - 사용자 도메인을 사용 중이었다면 Cloudflare Zone까지 삭제한다.
 */
export async function handleDeleteHosting(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT id, user_id FROM hostings WHERE id = ? AND status != 'deleted'")
    .bind(hostingId)
    .first<{ id: string; user_id: string }>();
  if (!row) return errorResponse("hosting not found", 404);
  if (!user.isAdmin && row.user_id !== user.id) return errorResponse("hosting not found", 404);

  // 1) storage 워커에 완전 삭제 요청 (오브젝트/자격증명/사이트 메타/로드밸런서 등록 전부 제거)
  //    실패 시 DB 상태를 바꾸지 않고 에러를 반환한다 — "삭제됐다고 나오는데 실제로는 남아있는" 상황 방지.
  const deprovisionRes = await env.STORAGE_WORKER.fetch("https://internal/internal/deprovision", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-internal-secret": env.INTERNAL_SHARED_SECRET,
    },
    body: JSON.stringify({ siteId: hostingId }),
  });

  if (!deprovisionRes.ok) {
    await logActivity(env, hostingId, user.id, "hosting.delete_failed", "storage deprovision failed");
    return errorResponse("failed to clean up storage/database resources for this hosting", 502);
  }

  // 2) 이 호스팅에 연결된 사용자 도메인들의 Cloudflare Zone 삭제 + DNS/인증서 레코드 정리
  const { results: domains } = await env.DB.prepare("SELECT id, cf_zone_id FROM domains WHERE hosting_id = ?")
    .bind(hostingId)
    .all<{ id: string; cf_zone_id: string | null }>();

  const creds = await getCloudflareCreds(env);

  for (const domain of domains) {
    if (domain.cf_zone_id) {
      await fetch(`https://api.cloudflare.com/client/v4/zones/${domain.cf_zone_id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${creds.apiToken}`, "content-type": "application/json" },
      }).catch(() => null);
    }
    await env.DB.prepare("DELETE FROM dns_records WHERE domain_id = ?").bind(domain.id).run();
    await env.DB.prepare("DELETE FROM certificates WHERE domain_id = ?").bind(domain.id).run();
  }

  // 3) D1의 나머지 관계 레코드 정리 (배치 처리)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM domains WHERE hosting_id = ?").bind(hostingId),
    env.DB.prepare("DELETE FROM hosting_sites WHERE hosting_id = ?").bind(hostingId),
    env.DB.prepare("UPDATE subscriptions SET status = 'cancelled' WHERE hosting_id = ?").bind(hostingId),
    env.DB.prepare(
      `UPDATE hostings SET status = 'deleted', storage_access_key_id = NULL, storage_secret_key = NULL, storage_api_key = NULL, updated_at = datetime('now') WHERE id = ?`
    ).bind(hostingId),
  ]);

  await logActivity(env, hostingId, user.id, "hosting.deleted");

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
  const owned = await assertHostingOwner(env, user, hostingId);
  if (!owned) return errorResponse("hosting not found", 404);

  await env.DB.prepare("UPDATE hostings SET plan_id = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(body.planId, hostingId)
    .run();
  await env.DB.prepare("UPDATE subscriptions SET plan_id = ? WHERE hosting_id = ?")
    .bind(body.planId, hostingId)
    .run();
  await logActivity(env, hostingId, user.id, "plan.updated", `newPlan=${body.planId}`);
  return json({ id: hostingId, planId: body.planId });
}

export { VALID_PLANS };
