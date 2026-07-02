import type { Env } from "../common";
import { errorResponse, json, uuid } from "../common";
import type { AuthedUser } from "../auth-middleware";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

function cfHeaders(env: Env): Record<string, string> {
  return {
    authorization: `Bearer ${env.CF_API_TOKEN}`,
    "content-type": "application/json",
  };
}

/** 노트 [도메인] 2번: 도메인 등록 흐름 — 도메인 입력 -> 약관동의 -> 사용여부확인 -> 네임서버 안내 -> 전파 확인까지 */
export async function handleAddDomain(
  request: Request,
  env: Env,
  user: AuthedUser,
  hostingId: string
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { domainName?: string } | null;
  if (!body?.domainName) return errorResponse("domainName is required");

  const hosting = await env.DB.prepare("SELECT id FROM hostings WHERE id = ? AND user_id = ?")
    .bind(hostingId, user.id)
    .first();
  if (!hosting) return errorResponse("hosting not found", 404);

  const existing = await env.DB.prepare("SELECT id FROM domains WHERE domain_name = ?")
    .bind(body.domainName)
    .first();
  if (existing) return errorResponse("domain already registered", 409);

  // Cloudflare에 Zone 생성 (도메인을 Cloudflare 네임서버로 전환하기 위함)
  const zoneRes = await fetch(`${CF_API_BASE}/zones`, {
    method: "POST",
    headers: cfHeaders(env),
    body: JSON.stringify({ name: body.domainName, account: { id: env.CF_ACCOUNT_ID }, type: "full" }),
  });
  const zoneData = (await zoneRes.json()) as {
    success: boolean;
    result?: { id: string; name_servers: string[] };
    errors?: Array<{ message: string }>;
  };

  if (!zoneData.success || !zoneData.result) {
    return errorResponse(zoneData.errors?.[0]?.message ?? "failed to create zone", 502);
  }

  const domainId = uuid();
  await env.DB.prepare(
    `INSERT INTO domains (id, hosting_id, domain_name, cf_zone_id, status) VALUES (?, ?, ?, ?, 'pending')`
  )
    .bind(domainId, hostingId, body.domainName, zoneData.result.id)
    .run();

  return json(
    {
      id: domainId,
      domainName: body.domainName,
      status: "pending",
      nameServers: zoneData.result.name_servers, // 사용자에게 안내할 네임서버 목록 (노트 [도메인] 4번)
    },
    201
  );
}

/** 도메인의 네임서버 전파 상태를 확인하고 active로 갱신 */
export async function handleCheckDomainStatus(env: Env, user: AuthedUser, domainId: string): Promise<Response> {
  const domain = await env.DB.prepare(
    `SELECT d.id as id, d.domain_name as domain_name, d.cf_zone_id as cf_zone_id, d.status as status
     FROM domains d JOIN hostings h ON h.id = d.hosting_id
     WHERE d.id = ? AND h.user_id = ?`
  )
    .bind(domainId, user.id)
    .first<{ id: string; domain_name: string; cf_zone_id: string; status: string }>();
  if (!domain) return errorResponse("domain not found", 404);

  const zoneRes = await fetch(`${CF_API_BASE}/zones/${domain.cf_zone_id}`, { headers: cfHeaders(env) });
  const zoneData = (await zoneRes.json()) as { result?: { status: string } };
  const cfStatus = zoneData.result?.status; // "active" | "pending" 등

  const newStatus = cfStatus === "active" ? "active" : "pending";
  if (newStatus !== domain.status) {
    await env.DB.prepare("UPDATE domains SET status = ? WHERE id = ?").bind(newStatus, domainId).run();
  }

  return json({ id: domainId, domainName: domain.domain_name, status: newStatus });
}

export async function handleListDomains(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    `SELECT d.id, d.domain_name, d.status, d.created_at FROM domains d
     JOIN hostings h ON h.id = d.hosting_id
     WHERE d.hosting_id = ? AND h.user_id = ?`
  )
    .bind(hostingId, user.id)
    .all();
  return json({ domains: results });
}

/** DNS 레코드 추가 (A, AAAA, CNAME, TXT 등) */
export async function handleAddDnsRecord(
  request: Request,
  env: Env,
  user: AuthedUser,
  domainId: string
): Promise<Response> {
  const body = (await request.json().catch(() => null)) as {
    type?: string;
    name?: string;
    content?: string;
    ttl?: number;
    proxied?: boolean;
  } | null;
  if (!body?.type || !body?.name || !body?.content) {
    return errorResponse("type, name, content are required");
  }

  const domain = await env.DB.prepare(
    `SELECT d.id as id, d.cf_zone_id as cf_zone_id FROM domains d
     JOIN hostings h ON h.id = d.hosting_id
     WHERE d.id = ? AND h.user_id = ?`
  )
    .bind(domainId, user.id)
    .first<{ id: string; cf_zone_id: string }>();
  if (!domain) return errorResponse("domain not found", 404);

  const cfRes = await fetch(`${CF_API_BASE}/zones/${domain.cf_zone_id}/dns_records`, {
    method: "POST",
    headers: cfHeaders(env),
    body: JSON.stringify({
      type: body.type,
      name: body.name,
      content: body.content,
      ttl: body.ttl ?? 1,
      proxied: body.proxied ?? true,
    }),
  });
  const cfData = (await cfRes.json()) as {
    success: boolean;
    result?: { id: string };
    errors?: Array<{ message: string }>;
  };
  if (!cfData.success || !cfData.result) {
    return errorResponse(cfData.errors?.[0]?.message ?? "failed to create dns record", 502);
  }

  const recordId = uuid();
  await env.DB.prepare(
    `INSERT INTO dns_records (id, domain_id, cf_record_id, type, name, content, ttl, proxied)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(recordId, domainId, cfData.result.id, body.type, body.name, body.content, body.ttl ?? 1, body.proxied ? 1 : 0)
    .run();

  return json({ id: recordId, type: body.type, name: body.name, content: body.content }, 201);
}

export async function handleListDnsRecords(env: Env, user: AuthedUser, domainId: string): Promise<Response> {
  const domainCheck = await env.DB.prepare(
    `SELECT d.id FROM domains d JOIN hostings h ON h.id = d.hosting_id WHERE d.id = ? AND h.user_id = ?`
  )
    .bind(domainId, user.id)
    .first();
  if (!domainCheck) return errorResponse("domain not found", 404);

  const { results } = await env.DB.prepare(
    `SELECT id, type, name, content, ttl, proxied FROM dns_records WHERE domain_id = ?`
  )
    .bind(domainId)
    .all();
  return json({ records: results });
}

export async function handleDeleteDnsRecord(
  env: Env,
  user: AuthedUser,
  domainId: string,
  recordId: string
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT r.id as id, r.cf_record_id as cf_record_id, d.cf_zone_id as cf_zone_id
     FROM dns_records r
     JOIN domains d ON d.id = r.domain_id
     JOIN hostings h ON h.id = d.hosting_id
     WHERE r.id = ? AND r.domain_id = ? AND h.user_id = ?`
  )
    .bind(recordId, domainId, user.id)
    .first<{ id: string; cf_record_id: string; cf_zone_id: string }>();
  if (!row) return errorResponse("dns record not found", 404);

  await fetch(`${CF_API_BASE}/zones/${row.cf_zone_id}/dns_records/${row.cf_record_id}`, {
    method: "DELETE",
    headers: cfHeaders(env),
  });
  await env.DB.prepare("DELETE FROM dns_records WHERE id = ?").bind(recordId).run();

  return new Response(null, { status: 204 });
}

export async function handleDeleteDomain(env: Env, user: AuthedUser, domainId: string): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT d.id as id, d.cf_zone_id as cf_zone_id FROM domains d
     JOIN hostings h ON h.id = d.hosting_id
     WHERE d.id = ? AND h.user_id = ?`
  )
    .bind(domainId, user.id)
    .first<{ id: string; cf_zone_id: string }>();
  if (!row) return errorResponse("domain not found", 404);

  await fetch(`${CF_API_BASE}/zones/${row.cf_zone_id}`, { method: "DELETE", headers: cfHeaders(env) });
  await env.DB.prepare("DELETE FROM dns_records WHERE domain_id = ?").bind(domainId).run();
  await env.DB.prepare("DELETE FROM domains WHERE id = ?").bind(domainId).run();

  return new Response(null, { status: 204 });
}
