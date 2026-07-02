/**
 * WordPressDbDO
 * ─────────────
 * DO 역할을 DB 서빙 전용으로 최소화한다.
 * 파일/메타/멀티파트는 D1+KV가 처리. DO는 WordPress SQLite 쿼리만 담당.
 *
 * 파이프라인 다각화:
 *  - 읽기(SELECT): DO 없이 D1 직접 쿼리 가능하게 /db/query 엔드포인트 분리
 *  - 쓰기(INSERT/UPDATE): 트랜잭션 보장이 필요한 경우만 DO 경유
 *  - 배치: 여러 쿼리를 한 번의 DO fetch로 묶어 왕복 최소화
 *
 * DO 과다 호출 최소화 전략:
 *  1) 단순 SELECT → D1 직접 (DO 호출 0)
 *  2) 단일 INSERT/UPDATE → DO 경유 (DO 호출 1)
 *  3) 트랜잭션 묶음 → DO batch 엔드포인트 (DO 호출 1, 쿼리 N)
 */

export class WordPressDbDO {
  private sql: SqlStorage;

  constructor(
    private readonly state: DurableObjectState,
  ) {
    this.sql = state.storage.sql;
    this.initSchema();
  }

  private initSchema(): void {
    // WordPress 6.x 핵심 테이블 (SQLite 호환)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS wp_options (
        option_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        option_name  TEXT NOT NULL UNIQUE,
        option_value TEXT NOT NULL DEFAULT '',
        autoload     TEXT NOT NULL DEFAULT 'yes'
      );
      CREATE TABLE IF NOT EXISTS wp_users (
        ID                  INTEGER PRIMARY KEY AUTOINCREMENT,
        user_login          TEXT NOT NULL DEFAULT '',
        user_pass           TEXT NOT NULL DEFAULT '',
        user_nicename       TEXT NOT NULL DEFAULT '',
        user_email          TEXT NOT NULL DEFAULT '',
        user_url            TEXT NOT NULL DEFAULT '',
        user_registered     TEXT NOT NULL DEFAULT '',
        user_activation_key TEXT NOT NULL DEFAULT '',
        user_status         INTEGER NOT NULL DEFAULT 0,
        display_name        TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS wp_usermeta (
        umeta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL DEFAULT 0,
        meta_key    TEXT,
        meta_value  TEXT
      );
      CREATE TABLE IF NOT EXISTS wp_posts (
        ID                    INTEGER PRIMARY KEY AUTOINCREMENT,
        post_author           INTEGER NOT NULL DEFAULT 0,
        post_date             TEXT NOT NULL DEFAULT '',
        post_date_gmt         TEXT NOT NULL DEFAULT '',
        post_content          TEXT NOT NULL DEFAULT '',
        post_title            TEXT NOT NULL DEFAULT '',
        post_excerpt          TEXT NOT NULL DEFAULT '',
        post_status           TEXT NOT NULL DEFAULT 'publish',
        comment_status        TEXT NOT NULL DEFAULT 'open',
        ping_status           TEXT NOT NULL DEFAULT 'open',
        post_password         TEXT NOT NULL DEFAULT '',
        post_name             TEXT NOT NULL DEFAULT '',
        to_ping               TEXT NOT NULL DEFAULT '',
        pinged                TEXT NOT NULL DEFAULT '',
        post_modified         TEXT NOT NULL DEFAULT '',
        post_modified_gmt     TEXT NOT NULL DEFAULT '',
        post_content_filtered TEXT NOT NULL DEFAULT '',
        post_parent           INTEGER NOT NULL DEFAULT 0,
        guid                  TEXT NOT NULL DEFAULT '',
        menu_order            INTEGER NOT NULL DEFAULT 0,
        post_type             TEXT NOT NULL DEFAULT 'post',
        post_mime_type        TEXT NOT NULL DEFAULT '',
        comment_count         INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wp_postmeta (
        meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        post_id    INTEGER NOT NULL DEFAULT 0,
        meta_key   TEXT,
        meta_value TEXT
      );
      CREATE TABLE IF NOT EXISTS wp_terms (
        term_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL DEFAULT '',
        slug       TEXT NOT NULL DEFAULT '',
        term_group INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wp_term_taxonomy (
        term_taxonomy_id INTEGER PRIMARY KEY AUTOINCREMENT,
        term_id          INTEGER NOT NULL DEFAULT 0,
        taxonomy         TEXT NOT NULL DEFAULT '',
        description      TEXT NOT NULL DEFAULT '',
        parent           INTEGER NOT NULL DEFAULT 0,
        count            INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wp_term_relationships (
        object_id        INTEGER NOT NULL DEFAULT 0,
        term_taxonomy_id INTEGER NOT NULL DEFAULT 0,
        term_order       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (object_id, term_taxonomy_id)
      );
      CREATE TABLE IF NOT EXISTS wp_comments (
        comment_ID           INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_post_ID      INTEGER NOT NULL DEFAULT 0,
        comment_author       TEXT NOT NULL DEFAULT '',
        comment_author_email TEXT NOT NULL DEFAULT '',
        comment_author_url   TEXT NOT NULL DEFAULT '',
        comment_author_IP    TEXT NOT NULL DEFAULT '',
        comment_date         TEXT NOT NULL DEFAULT '',
        comment_date_gmt     TEXT NOT NULL DEFAULT '',
        comment_content      TEXT NOT NULL DEFAULT '',
        comment_karma        INTEGER NOT NULL DEFAULT 0,
        comment_approved     TEXT NOT NULL DEFAULT '1',
        comment_agent        TEXT NOT NULL DEFAULT '',
        comment_type         TEXT NOT NULL DEFAULT 'comment',
        comment_parent       INTEGER NOT NULL DEFAULT 0,
        user_id              INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wp_commentmeta (
        meta_id    INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id INTEGER NOT NULL DEFAULT 0,
        meta_key   TEXT,
        meta_value TEXT
      );
      CREATE TABLE IF NOT EXISTS wp_links (
        link_id          INTEGER PRIMARY KEY AUTOINCREMENT,
        link_url         TEXT NOT NULL DEFAULT '',
        link_name        TEXT NOT NULL DEFAULT '',
        link_image       TEXT NOT NULL DEFAULT '',
        link_target      TEXT NOT NULL DEFAULT '',
        link_description TEXT NOT NULL DEFAULT '',
        link_visible     TEXT NOT NULL DEFAULT 'Y',
        link_owner       INTEGER NOT NULL DEFAULT 1,
        link_rating      INTEGER NOT NULL DEFAULT 0,
        link_updated     TEXT NOT NULL DEFAULT '',
        link_rel         TEXT NOT NULL DEFAULT '',
        link_notes       TEXT NOT NULL DEFAULT '',
        link_rss         TEXT NOT NULL DEFAULT ''
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url    = new URL(request.url);
    const action = url.searchParams.get("action") ?? "";

    try {
      switch (action) {
        // ── 단일 쿼리 실행 (SELECT / INSERT / UPDATE / DELETE) ──
        case "query": {
          const { sql, params = [] } = await request.json() as { sql: string; params: unknown[] };
          const rows = this.sql.exec(sql, ...params).toArray();
          return ok(rows);
        }

        // ── 배치 쿼리 (여러 쿼리를 1번 DO 호출로) ──────────────
        // DO 과다 호출 최소화의 핵심: N개 쿼리를 1번 왕복으로 처리
        case "batch": {
          const { queries } = await request.json() as {
            queries: Array<{ sql: string; params?: unknown[] }>;
          };
          const results = queries.map(({ sql, params = [] }) =>
            this.sql.exec(sql, ...params).toArray()
          );
          return ok(results);
        }

        // ── 트랜잭션 (원자적 실행 필요 시) ─────────────────────
        case "transaction": {
          const { queries } = await request.json() as {
            queries: Array<{ sql: string; params?: unknown[] }>;
          };
          // DO 내장 SQLite는 단일 스레드라 암묵적으로 직렬화됨
          // 명시적 트랜잭션으로 원자성 보장
          this.sql.exec("BEGIN");
          try {
            const results = queries.map(({ sql, params = [] }) =>
              this.sql.exec(sql, ...params).toArray()
            );
            this.sql.exec("COMMIT");
            return ok(results);
          } catch (err) {
            this.sql.exec("ROLLBACK");
            throw err;
          }
        }

        // ── WordPress 옵션 읽기 (자주 쓰이는 경로 최적화) ───────
        case "getOption": {
          const name = url.searchParams.get("name") ?? "";
          const row  = this.sql
            .exec("SELECT option_value FROM wp_options WHERE option_name=?", name)
            .toArray()[0] as { option_value: string } | undefined;
          return ok(row?.option_value ?? null);
        }

        // ── WordPress 옵션 쓰기 ──────────────────────────────────
        case "setOption": {
          const { name, value } = await request.json() as { name: string; value: string };
          this.sql.exec(
            `INSERT INTO wp_options (option_name, option_value)
             VALUES (?,?)
             ON CONFLICT(option_name) DO UPDATE SET option_value=excluded.option_value`,
            name, value
          );
          return ok(true);
        }

        // ── 초기 시드 데이터 삽입 ────────────────────────────────
        case "seed": {
          const { siteName, siteUrl, adminEmail, adminUser, adminPassHash } =
            await request.json() as {
              siteName: string; siteUrl: string;
              adminEmail: string; adminUser: string; adminPassHash: string;
            };
          this.seedWordPress({ siteName, siteUrl, adminEmail, adminUser, adminPassHash });
          return ok(true);
        }

        // ── DB 헬스체크 ──────────────────────────────────────────
        case "health": {
          const count = (this.sql.exec("SELECT COUNT(*) as c FROM wp_options").toArray()[0] as { c: number }).c;
          return ok({ healthy: true, optionCount: count });
        }

        default:
          return err("unknown action", 400);
      }
    } catch (e: unknown) {
      return err(e instanceof Error ? e.message : "internal error", 500);
    }
  }

  private seedWordPress(opts: {
    siteName: string; siteUrl: string;
    adminEmail: string; adminUser: string; adminPassHash: string;
  }): void {
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    // 핵심 옵션
    const options: [string, string][] = [
      ["siteurl",             opts.siteUrl],
      ["home",                opts.siteUrl],
      ["blogname",            opts.siteName],
      ["blogdescription",     "Powered by CloudPress Bridge"],
      ["admin_email",         opts.adminEmail],
      ["permalink_structure", "/%postname%/"],
      ["default_role",        "subscriber"],
      ["db_version",          "57155"],
    ];
    for (const [name, value] of options) {
      this.sql.exec(
        `INSERT OR IGNORE INTO wp_options (option_name, option_value) VALUES (?,?)`,
        name, value
      );
    }

    // 관리자 계정
    this.sql.exec(
      `INSERT OR IGNORE INTO wp_users
         (user_login, user_pass, user_nicename, user_email, user_registered, display_name)
       VALUES (?,?,?,?,?,?)`,
      opts.adminUser, opts.adminPassHash, opts.adminUser, opts.adminEmail, now, opts.adminUser
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO wp_usermeta (user_id, meta_key, meta_value)
       VALUES (1, 'wp_capabilities', 'a:1:{s:13:"administrator";b:1;}')`,
    );

    // 샘플 페이지
    this.sql.exec(
      `INSERT OR IGNORE INTO wp_posts
         (post_author, post_date, post_date_gmt, post_content, post_title,
          post_status, post_name, post_modified, post_modified_gmt, post_type, guid)
       VALUES (1,?,?,?,?,?,?,?,?,?,?)`,
      now, now, "CloudPress Bridge에 오신 것을 환영합니다.",
      "안녕하세요!", "publish", "hello-world",
      now, now, "post", `${opts.siteUrl}/?p=1`
    );
  }
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data }), {
    headers: { "content-type": "application/json" },
  });
}

function err(message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}
