import type { Env } from "./types";
import { provisionCredentials, revokeCredentials } from "./auth";
import { siteCreate, siteExists, siteUsage, siteDelete, metaList } from "./d1-meta";
import { deleteObject } from "./chunk-engine";
import type { ObjectMeta } from "./types";
import { handleGet, handlePut } from "./object-handlers";

export async function handleInternal(request: Request, env: Env): Promise<Response> {
  const url  = new URL(request.url);
  const path = url.pathname;

  // site-worker가 요청 시점에 siteId 유효성(존재 여부)을 확인하는 경로.
  //   /internal/site-exists?siteId={siteId}
  if (path === "/internal/site-exists" && request.method === "GET") {
    const siteId = url.searchParams.get("siteId") ?? "";
    if (!siteId) return json({ error: "missing siteId" }, 400);
    const exists = await siteExists(env.META_DB, siteId);
    return json({ exists });
  }

  // site-worker가 정적 파일을 가져오거나(php.wasm 등) 캐시해 쓸 때 쓰는 내부 전용 경로.
  // 공개 S3 호환 엔드포인트(Bearer API 키)를 거치지 않고
  // Service Binding + INTERNAL_SHARED_SECRET로만 접근 가능.
  //   GET/PUT /internal/static/{siteId}/{...key}
  if (path.startsWith("/internal/static/") && (request.method === "GET" || request.method === "PUT")) {
    const rest = path.slice("/internal/static/".length);
    const segments = rest.split("/").filter(Boolean);
    if (!segments.length) return json({ error: "missing siteId" }, 400);
    const siteId = segments[0];
    const objectKey = decodeURIComponent(segments.slice(1).join("/"));
    if (!objectKey) return json({ error: "missing object key" }, 400);
    return request.method === "GET"
      ? handleGet(request, env, siteId, objectKey)
      : handlePut(request, env, siteId, objectKey);
  }

  if (path === "/internal/provision" && request.method === "POST") {
    const body = await request.json() as {
      siteId: string; siteName: string; siteUrl: string;
      locale: string; adminEmail: string; adminUser?: string;
    };
    await siteCreate(env.META_DB, body.siteId);
    const creds = await provisionCredentials(env, body.siteId);

    // WordPress DB DO 초기화 (배치로 한 번에)
    const dbDo = env.WP_DB.get(env.WP_DB.idFromName(body.siteId));
    await dbDo.fetch("https://do/?action=seed", {
      method: "POST",
      body: JSON.stringify({
        siteName:      body.siteName,
        siteUrl:       body.siteUrl,
        adminEmail:    body.adminEmail,
        adminUser:     body.adminUser ?? "admin",
        adminPassHash: "PENDING_FIRST_LOGIN",
      }),
    });

    return json({ ...creds, siteId: body.siteId }, 201);
  }

  if (path === "/internal/deprovision" && request.method === "POST") {
    const { siteId } = await request.json() as { siteId: string };

    // 모든 객체를 D1 목록에서 조회 후 KV 청크 삭제
    let token = "";
    do {
      const result = await metaList(env.META_DB, siteId, "", "", 1000, token);
      await Promise.all(
        result.items.map(async (item) => {
          // 풀 메타 조회해서 청크 정보 얻기
          const meta = item as unknown as ObjectMeta;
          if (meta.object_id) {
            await deleteObject(env.CHUNKS, meta.object_id, !!meta.is_small, meta.chunk_count ?? 1);
          }
        })
      );
      token = result.nextToken ?? "";
    } while (token);

    await revokeCredentials(env, siteId);

    // 사이트 메타 행 + 로그 + 버전 정보까지 완전 삭제 (부분 삭제로 잔존 데이터가 남지 않도록)
    await siteDelete(env.META_DB, siteId);
    await env.META_DB.prepare("DELETE FROM site_logs WHERE site_id = ?").bind(siteId).run();
    await env.META_DB.prepare("DELETE FROM site_versions WHERE site_id = ?").bind(siteId).run();
    await env.META_DB.prepare("DELETE FROM domain_map WHERE bucket_site_id = ?").bind(siteId).run();

    // WordPress DB DO는 참조가 없어지면 더 이상 호출되지 않는다.
    // (DO는 명시적 destroy API가 없으므로, 재사용 방지는 상위 API 워커에서 siteId 재사용을 막는 것으로 처리한다.)

    return json({ ok: true });
  }

  // ── 로그 조회 (호스팅 상세 "로그" 탭) ──────────────────────────────────
  //   GET /internal/logs?siteId={siteId}&limit=100
  if (path === "/internal/logs" && request.method === "GET") {
    const siteId = url.searchParams.get("siteId") ?? "";
    const limit = Math.min(Number(url.searchParams.get("limit") ?? "100"), 500);
    if (!siteId) return json({ error: "missing siteId" }, 400);
    const { results } = await env.META_DB.prepare(
      "SELECT id, level, message, created_at FROM site_logs WHERE site_id = ? ORDER BY id DESC LIMIT ?"
    )
      .bind(siteId, limit)
      .all();
    return json({ logs: results });
  }

  // 사이트 워커/워드프레스 런타임이 로그를 기록할 때 사용 (에러/경고/정보)
  if (path === "/internal/logs" && request.method === "POST") {
    const body = (await request.json()) as { siteId: string; level?: string; message: string };
    await env.META_DB.prepare(
      "INSERT INTO site_logs (site_id, level, message) VALUES (?, ?, ?)"
    )
      .bind(body.siteId, body.level ?? "info", body.message)
      .run();
    return json({ ok: true });
  }

  // ── 캐시 초기화 (워드프레스 오브젝트 캐시: wp_options의 트랜지언트를 비운다) ─────
  if (path === "/internal/cache/purge-wp" && request.method === "POST") {
    const { siteId } = (await request.json()) as { siteId: string };
    const dbDo = env.WP_DB.get(env.WP_DB.idFromName(siteId));
    const res = await dbDo.fetch("https://do/?action=query", {
      method: "POST",
      body: JSON.stringify({
        sql: "DELETE FROM wp_options WHERE option_name LIKE '\\_transient\\_%' ESCAPE '\\' OR option_name LIKE '\\_site\\_transient\\_%' ESCAPE '\\'",
        params: [],
      }),
    });
    if (!res.ok) return json({ error: "wp cache purge failed" }, 502);
    await env.META_DB.prepare("INSERT INTO site_logs (site_id, level, message) VALUES (?, 'info', 'WordPress object cache purged')")
      .bind(siteId)
      .run();
    return json({ ok: true });
  }

  // ── 업데이트 확인: php-wasm / WP 코어 / 플러그인·테마 ──────────────────────
  if (path === "/internal/updates/check" && request.method === "GET") {
    const siteId = url.searchParams.get("siteId") ?? "";
    if (!siteId) return json({ error: "missing siteId" }, 400);
    let row = await env.META_DB.prepare(
      "SELECT php_wasm_version, wp_core_version, plugins_json, themes_json FROM site_versions WHERE site_id = ?"
    )
      .bind(siteId)
      .first<{ php_wasm_version: string; wp_core_version: string; plugins_json: string; themes_json: string }>();

    if (!row) {
      // 최초 조회 시 기본값으로 초기화
      await env.META_DB.prepare(
        "INSERT INTO site_versions (site_id) VALUES (?)"
      ).bind(siteId).run();
      row = { php_wasm_version: "8.2.0", wp_core_version: "6.5", plugins_json: "[]", themes_json: "[]" };
    }

    // WordPress.org 코어 최신 버전 조회 (실패해도 현재값으로 폴백)
    let latestCore = row.wp_core_version;
    try {
      const wpRes = await fetch("https://api.wordpress.org/core/version-check/1.7/");
      const wpData = (await wpRes.json()) as { offers?: Array<{ version: string }> };
      if (wpData.offers?.[0]?.version) latestCore = wpData.offers[0].version;
    } catch {
      /* 네트워크 실패 시 현재 버전 유지 */
    }

    return json({
      phpWasm: { current: row.php_wasm_version, latest: "8.3.0", updateAvailable: row.php_wasm_version !== "8.3.0" },
      wordpressCore: { current: row.wp_core_version, latest: latestCore, updateAvailable: row.wp_core_version !== latestCore },
      plugins: JSON.parse(row.plugins_json),
      themes: JSON.parse(row.themes_json),
    });
  }

  // ── 업데이트 적용 ────────────────────────────────────────────────────────
  if (path === "/internal/updates/apply" && request.method === "POST") {
    const body = (await request.json()) as {
      siteId: string;
      target: "php_wasm" | "wp_core" | "plugin" | "theme";
      version?: string;
      slug?: string;
    };
    if (!body.siteId || !body.target) return json({ error: "siteId, target required" }, 400);

    if (body.target === "php_wasm") {
      await env.META_DB.prepare(
        `INSERT INTO site_versions (site_id, php_wasm_version) VALUES (?, ?)
         ON CONFLICT(site_id) DO UPDATE SET php_wasm_version = excluded.php_wasm_version, updated_at = datetime('now')`
      )
        .bind(body.siteId, body.version ?? "8.3.0")
        .run();
    } else if (body.target === "wp_core") {
      await env.META_DB.prepare(
        `INSERT INTO site_versions (site_id, wp_core_version) VALUES (?, ?)
         ON CONFLICT(site_id) DO UPDATE SET wp_core_version = excluded.wp_core_version, updated_at = datetime('now')`
      )
        .bind(body.siteId, body.version ?? "6.5")
        .run();
      const dbDo = env.WP_DB.get(env.WP_DB.idFromName(body.siteId));
      await dbDo.fetch("https://do/?action=setOption", {
        method: "POST",
        body: JSON.stringify({ name: "db_version", value: body.version ?? "6.5" }),
      });
    }
    // plugin/theme 업데이트는 plugins_json/themes_json 배열에서 해당 slug의 version을 갱신
    else {
      const col = body.target === "plugin" ? "plugins_json" : "themes_json";
      const row = await env.META_DB.prepare(`SELECT ${col} as list FROM site_versions WHERE site_id = ?`)
        .bind(body.siteId)
        .first<{ list: string }>();
      const list = row ? (JSON.parse(row.list) as Array<{ slug: string; version: string }>) : [];
      const idx = list.findIndex((it) => it.slug === body.slug);
      if (idx >= 0) list[idx].version = body.version ?? list[idx].version;
      else if (body.slug) list.push({ slug: body.slug, version: body.version ?? "1.0.0" });
      await env.META_DB.prepare(
        `INSERT INTO site_versions (site_id, ${col}) VALUES (?, ?)
         ON CONFLICT(site_id) DO UPDATE SET ${col} = excluded.${col}, updated_at = datetime('now')`
      )
        .bind(body.siteId, JSON.stringify(list))
        .run();
    }

    await env.META_DB.prepare("INSERT INTO site_logs (site_id, level, message) VALUES (?, 'info', ?)")
      .bind(body.siteId, `Update applied: ${body.target}${body.slug ? " (" + body.slug + ")" : ""}`)
      .run();

    return json({ ok: true });
  }

  // ── 백업 생성: WordPress DB 전체 덤프 + 오브젝트 매니페스트를 JSON으로 묶어 저장 ───
  if (path === "/internal/backup/create" && request.method === "POST") {
    const { siteId } = (await request.json()) as { siteId: string };
    if (!siteId) return json({ error: "missing siteId" }, 400);

    const dbDo = env.WP_DB.get(env.WP_DB.idFromName(siteId));
    const tablesRes = await dbDo.fetch("https://do/?action=query", {
      method: "POST",
      body: JSON.stringify({ sql: "SELECT name FROM sqlite_master WHERE type='table'", params: [] }),
    });
    const tablesData = (await tablesRes.json()) as { data: Array<{ name: string }> };
    const dump: Record<string, unknown[]> = {};
    for (const t of tablesData.data) {
      const rowsRes = await dbDo.fetch("https://do/?action=query", {
        method: "POST",
        body: JSON.stringify({ sql: `SELECT * FROM ${t.name}`, params: [] }),
      });
      const rowsData = (await rowsRes.json()) as { data: unknown[] };
      dump[t.name] = rowsData.data;
    }

    let objectManifest: Array<{ key: string; size: number }> = [];
    let token = "";
    do {
      const result = await metaList(env.META_DB, siteId, "", "", 1000, token);
      objectManifest = objectManifest.concat(result.items.map((i) => ({ key: i.key, size: i.size })));
      token = result.nextToken ?? "";
    } while (token);

    const backupId = crypto.randomUUID();
    const storageKey = `__backups__/${backupId}.json`;
    const payload = JSON.stringify({ siteId, createdAt: new Date().toISOString(), db: dump, objects: objectManifest });

    const putReq = new Request(`https://internal/backup-object`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    await handlePut(putReq, env, siteId, storageKey);

    await env.META_DB.prepare("INSERT INTO site_logs (site_id, level, message) VALUES (?, 'info', ?)")
      .bind(siteId, `Backup created: ${storageKey}`)
      .run();

    return json({ storageKey, sizeBytes: payload.length }, 201);
  }

  // ── 백업 복원 ────────────────────────────────────────────────────────────
  if (path === "/internal/backup/restore" && request.method === "POST") {
    const { siteId, storageKey } = (await request.json()) as { siteId: string; storageKey: string };
    if (!siteId || !storageKey) return json({ error: "siteId, storageKey required" }, 400);

    const getReq = new Request(`https://internal/backup-object`, { method: "GET" });
    const getRes = await handleGet(getReq, env, siteId, storageKey);
    if (!getRes.ok) return json({ error: "backup object not found" }, 404);
    const backup = (await getRes.json()) as { db: Record<string, unknown[]> };

    const dbDo = env.WP_DB.get(env.WP_DB.idFromName(siteId));
    for (const [table, rows] of Object.entries(backup.db)) {
      await dbDo.fetch("https://do/?action=query", {
        method: "POST",
        body: JSON.stringify({ sql: `DELETE FROM ${table}`, params: [] }),
      });
      for (const row of rows as Array<Record<string, unknown>>) {
        const cols = Object.keys(row);
        const placeholders = cols.map(() => "?").join(",");
        await dbDo.fetch("https://do/?action=query", {
          method: "POST",
          body: JSON.stringify({
            sql: `INSERT INTO ${table} (${cols.join(",")}) VALUES (${placeholders})`,
            params: cols.map((c) => row[c]),
          }),
        });
      }
    }

    await env.META_DB.prepare("INSERT INTO site_logs (site_id, level, message) VALUES (?, 'info', ?)")
      .bind(siteId, `Backup restored: ${storageKey}`)
      .run();

    return json({ ok: true });
  }

  // ── 멀티사이트: 같은 호스팅 안에 추가 사이트(독립 워드프레스 설치) 시딩 ──────────
  //   dbKey(=hosting_sites.id)로 별도의 WordPressDbDO 인스턴스를 만들어 완전히 격리한다.
  if (path === "/internal/sites/create" && request.method === "POST") {
    const body = (await request.json()) as {
      dbKey: string; siteName: string; siteUrl: string; adminEmail: string; adminUser?: string;
    };
    if (!body.dbKey || !body.siteUrl) return json({ error: "dbKey, siteUrl required" }, 400);
    const dbDo = env.WP_DB.get(env.WP_DB.idFromName(body.dbKey));
    await dbDo.fetch("https://do/?action=seed", {
      method: "POST",
      body: JSON.stringify({
        siteName: body.siteName,
        siteUrl: body.siteUrl,
        adminEmail: body.adminEmail,
        adminUser: body.adminUser ?? "admin",
        adminPassHash: "PENDING_FIRST_LOGIN",
      }),
    });
    return json({ ok: true }, 201);
  }

  if (path === "/internal/usage" && request.method === "GET") {
    const siteId = url.searchParams.get("siteId") ?? "";
    const usage  = await siteUsage(env.META_DB, siteId);
    return json(usage);
  }

  if (path === "/internal/db/query" && request.method === "POST") {
    // WordPress DB DO에 쿼리 전달 (배치 지원)
    const body   = await request.json() as { siteId: string; action: string; [k: string]: unknown };
    const dbDo   = env.WP_DB.get(env.WP_DB.idFromName(body.siteId));
    const doUrl  = new URL(`https://do/?action=${body.action}`);
    const doBody = JSON.stringify(body);
    return dbDo.fetch(doUrl.toString(), { method: "POST", body: doBody });
  }

  // ── 호스트네임 매핑 조회 (site-worker가 매 요청마다 호출) ─────────────────
  //   GET /internal/domain-map/resolve?hostname={host}
  if (path === "/internal/domain-map/resolve" && request.method === "GET") {
    const hostname = (url.searchParams.get("hostname") ?? "").toLowerCase();
    if (!hostname) return json({ error: "missing hostname" }, 400);
    const row = await env.META_DB.prepare(
      "SELECT bucket_site_id, target_site_id FROM domain_map WHERE hostname = ?"
    )
      .bind(hostname)
      .first<{ bucket_site_id: string; target_site_id: string }>();
    if (!row) return json({ found: false }, 404);
    return json({ found: true, bucketSiteId: row.bucket_site_id, targetSiteId: row.target_site_id });
  }

  // 도메인/서브도메인/멀티사이트 연결 시 API 워커가 호출해 매핑을 등록한다
  if (path === "/internal/domain-map/set" && request.method === "POST") {
    const { hostname, bucketSiteId, targetSiteId } = (await request.json()) as {
      hostname: string; bucketSiteId: string; targetSiteId: string;
    };
    if (!hostname || !bucketSiteId || !targetSiteId) return json({ error: "hostname, bucketSiteId, targetSiteId required" }, 400);
    await env.META_DB.prepare(
      `INSERT INTO domain_map (hostname, bucket_site_id, target_site_id) VALUES (?, ?, ?)
       ON CONFLICT(hostname) DO UPDATE SET bucket_site_id = excluded.bucket_site_id, target_site_id = excluded.target_site_id`
    )
      .bind(hostname.toLowerCase(), bucketSiteId, targetSiteId)
      .run();
    return json({ ok: true });
  }

  if (path === "/internal/domain-map/delete" && request.method === "POST") {
    const { hostname } = (await request.json()) as { hostname: string };
    if (!hostname) return json({ error: "missing hostname" }, 400);
    await env.META_DB.prepare("DELETE FROM domain_map WHERE hostname = ?").bind(hostname.toLowerCase()).run();
    return json({ ok: true });
  }

  if (path === "/internal/lb/register" && request.method === "POST") {
    const { siteId, urls } = await request.json() as { siteId: string; urls: string[] };
    const lb = env.LOAD_BALANCER.get(env.LOAD_BALANCER.idFromName(siteId));
    return lb.fetch("https://do/?action=register", {
      method: "POST",
      body: JSON.stringify({ urls }),
    });
  }

  return json({ error: "unknown internal route" }, 404);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
