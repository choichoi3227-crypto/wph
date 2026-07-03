import type { Env } from "../common";
import { errorResponse, json, uuid, logActivity, getCloudflareCreds, randomSubdomain } from "../common";
import type { AuthedUser } from "../auth-middleware";
import { assertHostingOwner, ROOT_DOMAIN } from "./hostings";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

async function ownedOr404(env: Env, user: AuthedUser, hostingId: string): Promise<Response | null> {
  const owned = await assertHostingOwner(env, user, hostingId);
  if (!owned) return errorResponse("hosting not found", 404);
  return null;
}

// ── 개요 (워드프레스 정보 + 플랜 + 기본 도메인 + 구독 상태) ───────────────────
export async function handleHostingOverview(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const hosting = await env.DB.prepare(
    `SELECT h.id, h.site_name, h.site_url, h.plan_id, h.locale, h.status, h.created_at,
            p.name as plan_name, p.price_usd_cents
     FROM hostings h JOIN plans p ON p.id = h.plan_id
     WHERE h.id = ?`
  )
    .bind(hostingId)
    .first();
  if (!hosting) return errorResponse("hosting not found", 404);

  const subscription = await env.DB.prepare(
    "SELECT status, current_period_end, granted_by_admin FROM subscriptions WHERE hosting_id = ?"
  )
    .bind(hostingId)
    .first();

  const versionsRes = await env.STORAGE_WORKER.fetch(
    `https://internal/internal/updates/check?siteId=${encodeURIComponent(hostingId)}`,
    { headers: { "x-internal-secret": env.INTERNAL_SHARED_SECRET } }
  );
  const versions = versionsRes.ok ? await versionsRes.json() : null;

  return json({ hosting, subscription, versions });
}

// ── 로그 ──────────────────────────────────────────────────────────────────
export async function handleHostingLogs(env: Env, user: AuthedUser, hostingId: string, limit: number): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const res = await env.STORAGE_WORKER.fetch(
    `https://internal/internal/logs?siteId=${encodeURIComponent(hostingId)}&limit=${limit}`,
    { headers: { "x-internal-secret": env.INTERNAL_SHARED_SECRET } }
  );
  if (!res.ok) return errorResponse("failed to fetch logs", 502);
  return json(await res.json());
}

// ── 스토리지 사용량 ─────────────────────────────────────────────────────────
export async function handleHostingStorageUsage(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const res = await env.STORAGE_WORKER.fetch(
    `https://internal/internal/usage?siteId=${encodeURIComponent(hostingId)}`,
    { headers: { "x-internal-secret": env.INTERNAL_SHARED_SECRET } }
  );
  if (!res.ok) return errorResponse("failed to fetch storage usage", 502);
  return json(await res.json());
}

// ── DB 접속 (해당 사용자의 DB만, 절대 다른 사용자 DB 접근 불가) ────────────────
// siteId는 URL 경로의 hostingId로만 결정되며, 요청 바디의 siteId는 무시한다.
export async function handleHostingDbQuery(
  request: Request,
  env: Env,
  user: AuthedUser,
  hostingId: string
): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const body = (await request.json().catch(() => null)) as {
    action?: "query" | "batch" | "listTables";
    sql?: string;
    params?: unknown[];
    queries?: Array<{ sql: string; params?: unknown[] }>;
  } | null;
  if (!body?.action) return errorResponse("action is required (query|batch|listTables)");

  const doAction = body.action === "listTables" ? "query" : body.action;
  const doBody =
    body.action === "listTables"
      ? { sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", params: [] }
      : body.action === "batch"
      ? { queries: body.queries ?? [] }
      : { sql: body.sql, params: body.params ?? [] };

  const res = await env.STORAGE_WORKER.fetch(
    `https://internal/internal/db/query`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SHARED_SECRET },
      body: JSON.stringify({ siteId: hostingId, action: doAction, ...doBody }),
    }
  );
  if (!res.ok) return errorResponse("db query failed", 502);
  return json(await res.json());
}

// ── 워드프레스 캐시 초기화 ───────────────────────────────────────────────────
export async function handlePurgeWpCache(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const res = await env.STORAGE_WORKER.fetch("https://internal/internal/cache/purge-wp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SHARED_SECRET },
    body: JSON.stringify({ siteId: hostingId }),
  });
  if (!res.ok) return errorResponse("wp cache purge failed", 502);
  await logActivity(env, hostingId, user.id, "cache.purged_wp");
  return json({ ok: true });
}

// ── Cloudflare 캐시 초기화 (해당 호스팅에 연결된 모든 존, 워드프레스 포함 전체 캐시) ──
export async function handlePurgeCloudflareCache(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const { results: domains } = await env.DB.prepare(
    "SELECT cf_zone_id FROM domains WHERE hosting_id = ? AND cf_zone_id IS NOT NULL"
  )
    .bind(hostingId)
    .all<{ cf_zone_id: string }>();

  const creds = await getCloudflareCreds(env);
  const results: Array<{ zoneId: string; ok: boolean }> = [];
  for (const d of domains) {
    const res = await fetch(`${CF_API_BASE}/zones/${d.cf_zone_id}/purge_cache`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ purge_everything: true }),
    });
    results.push({ zoneId: d.cf_zone_id, ok: res.ok });
  }

  // 기본 cloud-press.co.kr 서브도메인은 자체 Zone이 없으므로 워드프레스 오브젝트 캐시도 함께 비운다
  await env.STORAGE_WORKER.fetch("https://internal/internal/cache/purge-wp", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SHARED_SECRET },
    body: JSON.stringify({ siteId: hostingId }),
  }).catch(() => null);

  await logActivity(env, hostingId, user.id, "cache.purged_cloudflare", JSON.stringify(results));
  return json({ zones: results });
}

// ── 업데이트 확인/적용 ────────────────────────────────────────────────────────
export async function handleUpdatesCheck(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;
  const res = await env.STORAGE_WORKER.fetch(
    `https://internal/internal/updates/check?siteId=${encodeURIComponent(hostingId)}`,
    { headers: { "x-internal-secret": env.INTERNAL_SHARED_SECRET } }
  );
  if (!res.ok) return errorResponse("failed to check updates", 502);
  return json(await res.json());
}

export async function handleUpdatesApply(request: Request, env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;
  const body = (await request.json().catch(() => null)) as {
    target?: "php_wasm" | "wp_core" | "plugin" | "theme";
    version?: string;
    slug?: string;
  } | null;
  if (!body?.target) return errorResponse("target is required (php_wasm|wp_core|plugin|theme)");

  const res = await env.STORAGE_WORKER.fetch("https://internal/internal/updates/apply", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SHARED_SECRET },
    body: JSON.stringify({ siteId: hostingId, target: body.target, version: body.version, slug: body.slug }),
  });
  if (!res.ok) return errorResponse("update failed", 502);
  await logActivity(env, hostingId, user.id, "update.applied", body.target);
  return json({ ok: true });
}

// ── 인증서 상태 (Google Trust Services 자동 발급, 항상 최신 TLS) ────────────────
export async function handleCertificateStatus(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const { results: domains } = await env.DB.prepare(
    "SELECT d.id, d.domain_name, d.cf_zone_id, c.status as cert_status, c.tls_version, c.issued_at, c.expires_at FROM domains d LEFT JOIN certificates c ON c.domain_id = d.id WHERE d.hosting_id = ?"
  )
    .bind(hostingId)
    .all();

  // cloud-press.co.kr 기본 서브도메인은 루트 존의 유니버설 SSL(Google Trust)로 항상 보호됨
  const defaultCert = {
    hostname: null as string | null,
    certAuthority: "google_trust",
    tlsVersion: "TLSv1.3",
    status: "active",
  };

  return json({ defaultSubdomain: defaultCert, customDomains: domains });
}

// ── 백업 ──────────────────────────────────────────────────────────────────
export async function handleCreateBackup(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const backupId = uuid();
  await env.DB.prepare(
    "INSERT INTO backups (id, hosting_id, status) VALUES (?, ?, 'pending')"
  )
    .bind(backupId, hostingId)
    .run();

  const res = await env.STORAGE_WORKER.fetch("https://internal/internal/backup/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SHARED_SECRET },
    body: JSON.stringify({ siteId: hostingId }),
  });

  if (!res.ok) {
    await env.DB.prepare("UPDATE backups SET status = 'failed' WHERE id = ?").bind(backupId).run();
    return errorResponse("backup failed", 502);
  }
  const { storageKey, sizeBytes } = (await res.json()) as { storageKey: string; sizeBytes: number };

  await env.DB.prepare(
    "UPDATE backups SET status = 'completed', storage_key = ?, size_bytes = ?, completed_at = datetime('now') WHERE id = ?"
  )
    .bind(storageKey, sizeBytes, backupId)
    .run();

  await logActivity(env, hostingId, user.id, "backup.created", storageKey);
  return json({ id: backupId, storageKey, sizeBytes, status: "completed" }, 201);
}

export async function handleListBackups(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;
  const { results } = await env.DB.prepare(
    "SELECT id, status, size_bytes, storage_key, created_at, completed_at FROM backups WHERE hosting_id = ? ORDER BY created_at DESC"
  )
    .bind(hostingId)
    .all();
  return json({ backups: results });
}

export async function handleRestoreBackup(env: Env, user: AuthedUser, hostingId: string, backupId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const backup = await env.DB.prepare("SELECT storage_key FROM backups WHERE id = ? AND hosting_id = ?")
    .bind(backupId, hostingId)
    .first<{ storage_key: string }>();
  if (!backup) return errorResponse("backup not found", 404);

  await env.DB.prepare("UPDATE backups SET status = 'restoring' WHERE id = ?").bind(backupId).run();

  const res = await env.STORAGE_WORKER.fetch("https://internal/internal/backup/restore", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SHARED_SECRET },
    body: JSON.stringify({ siteId: hostingId, storageKey: backup.storage_key }),
  });

  await env.DB.prepare("UPDATE backups SET status = 'completed' WHERE id = ?").bind(backupId).run();
  if (!res.ok) return errorResponse("restore failed", 502);

  await logActivity(env, hostingId, user.id, "backup.restored", backupId);
  return json({ ok: true });
}

// ── 트래픽 (요청 로그 기반 일자별 집계 — Cloudflare Analytics 연동 전 임시 지표) ──
export async function handleTraffic(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const res = await env.STORAGE_WORKER.fetch(
    `https://internal/internal/logs?siteId=${encodeURIComponent(hostingId)}&limit=500`,
    { headers: { "x-internal-secret": env.INTERNAL_SHARED_SECRET } }
  );
  if (!res.ok) return errorResponse("failed to fetch traffic", 502);
  const { logs } = (await res.json()) as { logs: Array<{ created_at: string; level: string }> };

  const byDay = new Map<string, { total: number; errors: number }>();
  for (const l of logs) {
    const day = l.created_at.slice(0, 10);
    const cur = byDay.get(day) ?? { total: 0, errors: 0 };
    cur.total += 1;
    if (l.level === "error") cur.errors += 1;
    byDay.set(day, cur);
  }
  const series = [...byDay.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => (a.date < b.date ? -1 : 1));
  return json({ series });
}

// ── 멀티사이트: 사이트 목록 / 추가 ───────────────────────────────────────────
export async function handleListSites(env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;
  const { results } = await env.DB.prepare(
    "SELECT id, subdomain, domain_id, site_url, is_primary, status, created_at FROM hosting_sites WHERE hosting_id = ? ORDER BY created_at ASC"
  )
    .bind(hostingId)
    .all();
  return json({ sites: results });
}

/**
 * 새 사이트 추가. 호스팅은 인프라일 뿐이므로 하나의 호스팅 안에 여러 독립 워드프레스 사이트를 둘 수 있다.
 * - domainId 미지정: cloud-press.co.kr 아래 난수 서브도메인 자동 생성
 * - domainId 지정: 사용자가 연결한 개인 도메인의 서브도메인으로 생성 (예: blog.example.com)
 *   이 경우 subdomainLabel(예: "blog")을 받아 해당 도메인의 DNS에 CNAME 레코드까지 자동 등록한다.
 */
export async function handleCreateSite(request: Request, env: Env, user: AuthedUser, hostingId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const body = (await request.json().catch(() => null)) as {
    siteName?: string;
    domainId?: string;
    subdomainLabel?: string; // domainId가 있을 때 사용, 예: "blog" -> blog.example.com
  } | null;
  if (!body?.siteName) return errorResponse("siteName is required");

  const hosting = await env.DB.prepare("SELECT user_id FROM hostings WHERE id = ?")
    .bind(hostingId)
    .first<{ user_id: string }>();
  if (!hosting) return errorResponse("hosting not found", 404);

  let hostname: string;
  let domainId: string | null = null;

  if (body.domainId) {
    if (!body.subdomainLabel || !/^[a-z0-9-]{1,63}$/.test(body.subdomainLabel)) {
      return errorResponse("subdomainLabel is required and must be a valid DNS label when domainId is set");
    }
    const domain = await env.DB.prepare(
      "SELECT d.id, d.domain_name, d.cf_zone_id FROM domains d JOIN hostings h ON h.id = d.hosting_id WHERE d.id = ? AND h.id = ?"
    )
      .bind(body.domainId, hostingId)
      .first<{ id: string; domain_name: string; cf_zone_id: string }>();
    if (!domain) return errorResponse("domain not found for this hosting", 404);

    hostname = `${body.subdomainLabel}.${domain.domain_name}`;
    domainId = domain.id;

    // 사용자 도메인의 "서브도메인" 탭에 해당하는 CNAME 레코드를 Cloudflare DNS에 자동 등록
    const creds = await getCloudflareCreds(env);
    const cfRes = await fetch(`${CF_API_BASE}/zones/${domain.cf_zone_id}/dns_records`, {
      method: "POST",
      headers: { authorization: `Bearer ${creds.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "CNAME", name: body.subdomainLabel, content: `${hostingId}.${ROOT_DOMAIN}`, ttl: 1, proxied: true }),
    });
    const cfData = (await cfRes.json()) as { success: boolean; result?: { id: string }; errors?: Array<{ message: string }> };
    if (!cfData.success || !cfData.result) {
      return errorResponse(cfData.errors?.[0]?.message ?? "failed to create dns record for subdomain", 502);
    }
    await env.DB.prepare(
      `INSERT INTO dns_records (id, domain_id, cf_record_id, type, name, content, ttl, proxied)
       VALUES (?, ?, ?, 'CNAME', ?, ?, 1, 1)`
    )
      .bind(uuid(), domain.id, cfData.result.id, body.subdomainLabel, `${hostingId}.${ROOT_DOMAIN}`)
      .run();
  } else {
    hostname = `${randomSubdomain()}.${ROOT_DOMAIN}`;
  }

  const siteRowId = uuid();
  const siteUrl = `https://${hostname}`;

  await env.DB.prepare(
    `INSERT INTO hosting_sites (id, hosting_id, subdomain, domain_id, site_url, is_primary, status)
     VALUES (?, ?, ?, ?, ?, 0, 'provisioning')`
  )
    .bind(siteRowId, hostingId, hostname, domainId, siteUrl)
    .run();

  // 독립된 워드프레스 DB(DO)로 시딩 — 같은 호스팅의 다른 사이트와 완전히 격리됨
  const seedRes = await env.STORAGE_WORKER.fetch("https://internal/internal/sites/create", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SHARED_SECRET },
    body: JSON.stringify({ dbKey: siteRowId, siteName: body.siteName, siteUrl, adminEmail: user.email }),
  });
  if (!seedRes.ok) {
    await env.DB.prepare("UPDATE hosting_sites SET status = 'error' WHERE id = ?").bind(siteRowId).run();
    return errorResponse("failed to provision new site", 502);
  }

  // site-worker 라우팅 매핑: 객체 스토리지는 호스팅 버킷 공유, DB는 이 사이트 전용(dbKey)
  await env.STORAGE_WORKER.fetch("https://internal/internal/domain-map/set", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SHARED_SECRET },
    body: JSON.stringify({ hostname, bucketSiteId: hostingId, targetSiteId: siteRowId }),
  });

  await env.DB.prepare("UPDATE hosting_sites SET status = 'active' WHERE id = ?").bind(siteRowId).run();
  await logActivity(env, hostingId, user.id, "site.created", hostname);

  return json({ id: siteRowId, hostname, siteUrl, status: "active" }, 201);
}

export async function handleDeleteSite(env: Env, user: AuthedUser, hostingId: string, siteRowId: string): Promise<Response> {
  const guard = await ownedOr404(env, user, hostingId);
  if (guard) return guard;

  const site = await env.DB.prepare("SELECT subdomain, is_primary FROM hosting_sites WHERE id = ? AND hosting_id = ?")
    .bind(siteRowId, hostingId)
    .first<{ subdomain: string; is_primary: number }>();
  if (!site) return errorResponse("site not found", 404);
  if (site.is_primary) return errorResponse("primary site cannot be deleted; delete the whole hosting instead", 400);

  await env.STORAGE_WORKER.fetch("https://internal/internal/domain-map/delete", {
    method: "POST",
    headers: { "content-type": "application/json", "x-internal-secret": env.INTERNAL_SHARED_SECRET },
    body: JSON.stringify({ hostname: site.subdomain }),
  });

  await env.DB.prepare("DELETE FROM hosting_sites WHERE id = ?").bind(siteRowId).run();
  await logActivity(env, hostingId, user.id, "site.deleted", site.subdomain);
  return new Response(null, { status: 204 });
}
