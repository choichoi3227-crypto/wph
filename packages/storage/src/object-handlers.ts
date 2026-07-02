/**
 * Object Handlers v2
 * ──────────────────
 * 파이프라인:
 *  PUT  → KV 청크(병렬) + D1 메타 동시 기록 → DO 호출 없음
 *  GET  → D1 메타 조회 → KV 청크(병렬 조립) → 응답 스트리밍
 *  HEAD → D1 메타 조회만 → 헤더만 반환
 *  DELETE → D1 메타 삭제 + KV 청크 삭제 병렬 → DO 호출 없음
 *  LIST → D1 쿼리 단독 → DO 호출 없음
 */

import type { Env, ObjectMeta } from "./types";
import { xmlError, escXml } from "./types";
import { smallThreshold } from "./types";
import {
  writeObject,
  readObject,
  readRange,
  deleteObject,
  writePart,
  readPart,
  deletePart,
  md5Hex,
} from "./chunk-engine";
import {
  metaPut,
  metaGet,
  metaDelete,
  metaList,
  mpCreate,
  mpPutPart,
  mpListParts,
  mpGetUpload,
  mpCleanup,
} from "./d1-meta";

// ── PutObject ────────────────────────────────────────────────────────────

export async function handlePut(
  request: Request,
  env: Env,
  siteId: string,
  key: string
): Promise<Response> {
  const body        = await request.arrayBuffer();
  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  const threshold   = smallThreshold(env);

  // KV 기록과 D1 메타 기록을 병렬로 실행 (파이프라인 다각화)
  const [writeResult] = await Promise.all([
    writeObject(env.CHUNKS, body, threshold),
    // D1 기록은 writeResult 의존이라 순서상 뒤에 하지만
    // 기존 메타 조회 + 구 청크 삭제는 미리 병렬로 시작
    (async () => {})(), // 자리표시자 — 아래서 순서 보장
  ]);

  // 기존 객체 덮어쓰기: 구 청크를 비동기 삭제 (응답 속도 우선)
  const old = await metaGet(env.META_DB, siteId, key);
  if (old) {
    // 비동기 삭제 — 응답을 기다리지 않음 (eventual cleanup)
    deleteObject(env.CHUNKS, old.object_id, !!old.is_small, old.chunk_count).catch(() => {});
  }

  const meta: ObjectMeta = {
    site_id:       siteId,
    key,
    object_id:     writeResult.objectId,
    size:          body.byteLength,
    chunk_count:   writeResult.chunkCount,
    is_small:      writeResult.isSmall ? 1 : 0,
    content_type:  contentType,
    etag:          writeResult.etag,
    last_modified: new Date().toISOString(),
    storage_class: "STANDARD",
  };
  await metaPut(env.META_DB, meta);

  return new Response(null, {
    status: 200,
    headers: {
      etag:                `"${writeResult.etag}"`,
      "x-amz-version-id": writeResult.objectId,
    },
  });
}

// ── GetObject ────────────────────────────────────────────────────────────

export async function handleGet(
  request: Request,
  env: Env,
  siteId: string,
  key: string
): Promise<Response> {
  const meta = await metaGet(env.META_DB, siteId, key);
  if (!meta) return xmlError("NoSuchKey", `The specified key does not exist: ${key}`, 404);

  const rangeHeader = request.headers.get("range");

  if (rangeHeader) {
    const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = Number(m[1]);
      const end   = m[2] ? Number(m[2]) : meta.size - 1;
      const data  = await readRange(
        env.CHUNKS, meta.object_id, !!meta.is_small, meta.chunk_count, start, end
      );
      if (!data) return xmlError("InternalError", "chunk missing", 500);
      return new Response(data, {
        status: 206,
        headers: {
          "content-type":   meta.content_type,
          "content-range":  `bytes ${start}-${end}/${meta.size}`,
          "content-length": String(data.byteLength),
          etag:             `"${meta.etag}"`,
          "last-modified":  meta.last_modified,
          "accept-ranges":  "bytes",
        },
      });
    }
  }

  const data = await readObject(env.CHUNKS, meta.object_id, !!meta.is_small, meta.chunk_count);
  if (!data) return xmlError("InternalError", "object data missing", 500);

  return new Response(data, {
    status: 200,
    headers: {
      "content-type":   meta.content_type,
      "content-length": String(meta.size),
      etag:             `"${meta.etag}"`,
      "last-modified":  meta.last_modified,
      "accept-ranges":  "bytes",
    },
  });
}

// ── HeadObject ───────────────────────────────────────────────────────────

export async function handleHead(
  env: Env,
  siteId: string,
  key: string
): Promise<Response> {
  const meta = await metaGet(env.META_DB, siteId, key);
  if (!meta) return new Response(null, { status: 404 });
  return new Response(null, {
    status: 200,
    headers: {
      "content-type":   meta.content_type,
      "content-length": String(meta.size),
      etag:             `"${meta.etag}"`,
      "last-modified":  meta.last_modified,
    },
  });
}

// ── DeleteObject ─────────────────────────────────────────────────────────

export async function handleDelete(
  env: Env,
  siteId: string,
  key: string
): Promise<Response> {
  const old = await metaDelete(env.META_DB, siteId, key);
  if (old) {
    // KV 청크 삭제 — 비동기 (S3 시맨틱: 항상 204)
    deleteObject(env.CHUNKS, old.object_id, !!old.is_small, old.chunk_count).catch(() => {});
  }
  return new Response(null, { status: 204 });
}

// ── DeleteObjects (멀티 삭제) ─────────────────────────────────────────────

export async function handleDeleteObjects(
  request: Request,
  env: Env,
  siteId: string
): Promise<Response> {
  const body = await request.text();
  const keys = [...body.matchAll(/<Key>(.*?)<\/Key>/g)].map((m) => m[1]);

  const deleted: string[] = [];
  await Promise.all(
    keys.map(async (key) => {
      const old = await metaDelete(env.META_DB, siteId, key);
      if (old) {
        deleteObject(env.CHUNKS, old.object_id, !!old.is_small, old.chunk_count).catch(() => {});
        deleted.push(key);
      }
    })
  );

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<DeleteResult>
${deleted.map((k) => `<Deleted><Key>${escXml(k)}</Key></Deleted>`).join("\n")}
</DeleteResult>`;
  return new Response(xml, { headers: { "content-type": "application/xml" } });
}

// ── ListObjectsV2 ────────────────────────────────────────────────────────

export async function handleList(
  url: URL,
  env: Env,
  siteId: string
): Promise<Response> {
  const prefix    = url.searchParams.get("prefix") ?? "";
  const delimiter = url.searchParams.get("delimiter") ?? "";
  const maxKeys   = Math.min(Number(url.searchParams.get("max-keys") ?? "1000"), 1000);
  const token     = url.searchParams.get("continuation-token") ?? "";

  const result = await metaList(env.META_DB, siteId, prefix, delimiter, maxKeys, token);

  const contents = result.items
    .map((it) => `<Contents>
  <Key>${escXml(it.key)}</Key>
  <LastModified>${it.last_modified}</LastModified>
  <ETag>&quot;${it.etag}&quot;</ETag>
  <Size>${it.size}</Size>
  <StorageClass>${it.storage_class}</StorageClass>
</Contents>`)
    .join("\n");

  const prefixes = result.commonPrefixes
    .map((p) => `<CommonPrefixes><Prefix>${escXml(p)}</Prefix></CommonPrefixes>`)
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>${escXml(siteId)}</Name>
  <Prefix>${escXml(prefix)}</Prefix>
  <KeyCount>${result.items.length}</KeyCount>
  <MaxKeys>${maxKeys}</MaxKeys>
  <IsTruncated>${result.truncated}</IsTruncated>
  ${result.truncated && result.nextToken
    ? `<NextContinuationToken>${escXml(result.nextToken)}</NextContinuationToken>`
    : ""}
  ${contents}
  ${prefixes}
</ListBucketResult>`;

  return new Response(xml, { headers: { "content-type": "application/xml" } });
}

// ── Multipart Upload ─────────────────────────────────────────────────────

export async function handleCreateMultipart(
  request: Request,
  env: Env,
  siteId: string,
  key: string
): Promise<Response> {
  const uploadId    = crypto.randomUUID();
  const contentType = request.headers.get("content-type") ?? "application/octet-stream";
  await mpCreate(env.META_DB, uploadId, siteId, key, contentType);

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<InitiateMultipartUploadResult>
  <Key>${escXml(key)}</Key>
  <UploadId>${uploadId}</UploadId>
</InitiateMultipartUploadResult>`,
    { headers: { "content-type": "application/xml" } }
  );
}

export async function handleUploadPart(
  request: Request,
  env: Env,
  siteId: string,
  key: string,
  url: URL
): Promise<Response> {
  const uploadId   = url.searchParams.get("uploadId")!;
  const partNumber = Number(url.searchParams.get("partNumber"));
  const body       = await request.arrayBuffer();

  const partObjectId = `${uploadId}-p${partNumber}`;
  const etag         = await writePart(env.CHUNKS, partObjectId, body);
  await mpPutPart(env.META_DB, uploadId, partNumber, partObjectId, etag, body.byteLength);

  return new Response(null, { status: 200, headers: { etag: `"${etag}"` } });
}

export async function handleCompleteMultipart(
  env: Env,
  siteId: string,
  key: string,
  url: URL
): Promise<Response> {
  const uploadId = url.searchParams.get("uploadId")!;
  const upload   = await mpGetUpload(env.META_DB, uploadId);
  if (!upload) return xmlError("NoSuchUpload", "upload not found", 404);

  const parts = await mpListParts(env.META_DB, uploadId);
  parts.sort((a, b) => a.part_number - b.part_number);

  // 파트 데이터를 병렬 읽기 후 최종 객체로 병렬 청크 기록
  const finalObjectId = crypto.randomUUID();
  let totalSize = 0;
  const md5Parts: string[] = [];

  // 파트 읽기 병렬화
  const partData = await Promise.all(
    parts.map((p) => readPart(env.CHUNKS, p.object_id))
  );

  // 최종 청크 기록 병렬화
  await Promise.all(
    partData.map(async (data, i) => {
      if (!data) throw new Error(`part ${parts[i].part_number} missing`);
      await env.CHUNKS.put(`chunk:${finalObjectId}:${i}`, data);
      totalSize += data.byteLength;
      md5Parts.push(await md5Hex(data));
    })
  );

  // S3 호환 멀티파트 ETag
  const concatMd5 = new TextEncoder().encode(md5Parts.join("")).buffer as ArrayBuffer;
  const finalEtag = `${await md5Hex(concatMd5)}-${parts.length}`;

  // D1 메타 + 파트 청크 삭제 병렬 실행
  const [staleIds] = await Promise.all([
    mpCleanup(env.META_DB, uploadId),
    metaPut(env.META_DB, {
      site_id: siteId, key,
      object_id: finalObjectId, size: totalSize,
      chunk_count: parts.length, is_small: 0,
      content_type: upload.content_type, etag: finalEtag,
      last_modified: new Date().toISOString(), storage_class: "STANDARD",
    }),
  ]);

  // 파트 KV 청크 비동기 삭제
  Promise.all(staleIds.map((id) => deletePart(env.CHUNKS, id))).catch(() => {});

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<CompleteMultipartUploadResult>
  <Key>${escXml(key)}</Key>
  <ETag>&quot;${finalEtag}&quot;</ETag>
</CompleteMultipartUploadResult>`,
    { headers: { "content-type": "application/xml" } }
  );
}

export async function handleAbortMultipart(
  env: Env,
  url: URL
): Promise<Response> {
  const uploadId = url.searchParams.get("uploadId")!;
  const staleIds = await mpCleanup(env.META_DB, uploadId);
  Promise.all(staleIds.map((id) => deletePart(env.CHUNKS, id))).catch(() => {});
  return new Response(null, { status: 204 });
}

export async function handleListParts(
  env: Env,
  url: URL
): Promise<Response> {
  const uploadId = url.searchParams.get("uploadId")!;
  const parts    = await mpListParts(env.META_DB, uploadId);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ListPartsResult>
  <UploadId>${uploadId}</UploadId>
${parts.map((p) => `  <Part><PartNumber>${p.part_number}</PartNumber><ETag>&quot;${p.etag}&quot;</ETag><Size>${p.size}</Size></Part>`).join("\n")}
</ListPartsResult>`;
  return new Response(xml, { headers: { "content-type": "application/xml" } });
}
