/**
 * LoadBalancerDO v2
 * ─────────────────
 * DO 역할을 헬스체크 + 라운드로빈 전용으로 최소화.
 * 파이프라인 다각화: Workers 10개를 KV에 상태 캐시해 DO 호출 최소화.
 *
 * DO 과다 호출 최소화:
 *  - 헬스 결과를 KV에 60초 캐시 → Site Worker가 DO 대신 KV 직접 읽기
 *  - DO는 실제 헬스체크 실행과 상태 업데이트 시에만 호출
 */

const UNHEALTHY_THRESHOLD = 3;
const HEALTH_PATH         = "/__health";

export class LoadBalancerDO {
  private sql: SqlStorage;

  constructor(
    private readonly state: DurableObjectState,
  ) {
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS endpoints (
        idx                  INTEGER PRIMARY KEY,
        url                  TEXT NOT NULL,
        healthy              INTEGER NOT NULL DEFAULT 1,
        last_checked_at      TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url    = new URL(request.url);
    const action = url.searchParams.get("action") ?? "";

    switch (action) {
      case "register":    return this.register(request);
      case "checkHealth": return this.checkHealth();
      case "pick":        return this.pick();
      case "list":        return this.listEndpoints();
      default:            return json({ error: "unknown action" }, 400);
    }
  }

  private async register(request: Request): Promise<Response> {
    const { urls } = await request.json() as { urls: string[] };
    for (let i = 0; i < urls.length; i++) {
      this.sql.exec(
        `INSERT INTO endpoints (idx, url) VALUES (?,?)
         ON CONFLICT(idx) DO UPDATE SET url=excluded.url`,
        i, urls[i]
      );
    }
    return json({ ok: true, count: urls.length });
  }

  private async checkHealth(): Promise<Response> {
    const rows = this.sql
      .exec("SELECT idx, url, consecutive_failures FROM endpoints")
      .toArray() as unknown as Array<{ idx: number; url: string; consecutive_failures: number }>;

    const results = await Promise.all(
      rows.map(async (row) => {
        let healthy = false;
        try {
          const res = await fetch(`${row.url}${HEALTH_PATH}`, {
            signal: AbortSignal.timeout(3000),
          });
          healthy = res.ok;
        } catch { healthy = false; }
        return { idx: row.idx, healthy, prev: row.consecutive_failures };
      })
    );

    const now = new Date().toISOString();
    for (const r of results) {
      const failures = r.healthy ? 0 : r.prev + 1;
      const isHealthy = failures < UNHEALTHY_THRESHOLD ? 1 : 0;
      this.sql.exec(
        "UPDATE endpoints SET healthy=?, last_checked_at=?, consecutive_failures=? WHERE idx=?",
        isHealthy, now, failures, r.idx
      );
    }
    return json({ checked: results.length, at: now });
  }

  private async pick(): Promise<Response> {
    const healthy = this.sql
      .exec("SELECT idx, url FROM endpoints WHERE healthy=1 ORDER BY idx ASC")
      .toArray() as unknown as Array<{ idx: number; url: string }>;

    if (!healthy.length) return json({ error: "no healthy endpoints" }, 503);

    const last   = ((await this.state.storage.get<number>("last")) ?? -1) + 1;
    const picked = healthy[last % healthy.length];
    await this.state.storage.put("last", last);
    return json({ idx: picked.idx, url: picked.url });
  }

  private listEndpoints(): Response {
    const rows = this.sql.exec("SELECT * FROM endpoints ORDER BY idx ASC").toArray();
    return json({ endpoints: rows });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}
