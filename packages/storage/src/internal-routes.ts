import type { Env } from "./types";
import { provisionCredentials, revokeCredentials } from "./auth";
import { siteCreate, siteUsage, metaList } from "./d1-meta";
import { deleteObject } from "./chunk-engine";
import type { ObjectMeta } from "./types";

export async function handleInternal(request: Request, env: Env): Promise<Response> {
  const url  = new URL(request.url);
  const path = url.pathname;

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
    return json({ ok: true });
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
