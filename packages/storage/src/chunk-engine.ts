/**
 * Chunk Engine v2
 * ───────────────
 * 파이프라인 다각화:
 *   ① 소용량 (≤ threshold, 기본 64KB): KV 단일 키 직접 PUT/GET — 청크 오버헤드 없음
 *   ② 대용량 (> threshold): 4MB 청크 분할 — KV 병렬 PUT으로 최대 처리량 확보
 *   ③ 멀티파트 파트: 파트당 단일 청크 키 (part ObjectId:0)
 *
 * KV 키 규칙:
 *   소용량: obj:{objectId}          → raw bytes
 *   대용량: chunk:{objectId}:{n}    → raw bytes (4MB 단위)
 */

export const CHUNK_SIZE   = 4 * 1024 * 1024; // 4MB
export const SMALL_PREFIX = "obj:";
export const CHUNK_PREFIX = "chunk:";

// ── 쓰기 ─────────────────────────────────────────────────────────────────

export interface WriteResult {
  objectId: string;
  chunkCount: number;
  isSmall: boolean;
  etag: string;
}

/**
 * 객체를 크기에 따라 자동으로 경로 선택해 KV에 저장.
 * 파이프라인: 대용량은 청크를 Promise.all로 병렬 기록.
 */
export async function writeObject(
  kv: KVNamespace,
  data: ArrayBuffer,
  threshold: number
): Promise<WriteResult> {
  const objectId = crypto.randomUUID();
  const etag = await md5Hex(data);

  if (data.byteLength <= threshold) {
    // ① 소용량 — 단일 KV PUT
    await kv.put(`${SMALL_PREFIX}${objectId}`, data);
    return { objectId, chunkCount: 1, isSmall: true, etag };
  }

  // ② 대용량 — 4MB 청크 병렬 PUT
  const chunkCount = Math.max(1, Math.ceil(data.byteLength / CHUNK_SIZE));
  const writes: Promise<void>[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const start = i * CHUNK_SIZE;
    const slice = data.slice(start, Math.min(start + CHUNK_SIZE, data.byteLength));
    writes.push(kv.put(`${CHUNK_PREFIX}${objectId}:${i}`, slice));
  }
  await Promise.all(writes);
  return { objectId, chunkCount, isSmall: false, etag };
}

// ── 읽기 ─────────────────────────────────────────────────────────────────

/** 전체 객체 조립 — 소용량/대용량 자동 분기 */
export async function readObject(
  kv: KVNamespace,
  objectId: string,
  isSmall: boolean,
  chunkCount: number
): Promise<ArrayBuffer | null> {
  if (isSmall) {
    return kv.get(`${SMALL_PREFIX}${objectId}`, "arrayBuffer");
  }
  return readChunkedObject(kv, objectId, chunkCount);
}

/**
 * Range 읽기 — 대용량 전용. 필요한 청크만 선택적으로 가져온다.
 * 소용량은 단일 버퍼에서 slice.
 */
export async function readRange(
  kv: KVNamespace,
  objectId: string,
  isSmall: boolean,
  chunkCount: number,
  rangeStart: number,
  rangeEnd: number
): Promise<ArrayBuffer | null> {
  if (isSmall) {
    const buf = await kv.get(`${SMALL_PREFIX}${objectId}`, "arrayBuffer");
    return buf ? buf.slice(rangeStart, rangeEnd + 1) : null;
  }

  // 필요한 청크 범위만 병렬 로드
  const firstChunk = Math.floor(rangeStart / CHUNK_SIZE);
  const lastChunk  = Math.min(Math.floor(rangeEnd  / CHUNK_SIZE), chunkCount - 1);

  const fetches = Array.from({ length: lastChunk - firstChunk + 1 }, (_, i) =>
    kv.get(`${CHUNK_PREFIX}${objectId}:${firstChunk + i}`, "arrayBuffer")
  );
  const buffers = await Promise.all(fetches);
  if (buffers.some((b) => b === null)) return null;

  const parts: ArrayBuffer[] = [];
  for (let i = 0; i < buffers.length; i++) {
    const buf       = buffers[i]!;
    const chunkIdx  = firstChunk + i;
    const chunkBase = chunkIdx * CHUNK_SIZE;
    const sliceFrom = Math.max(0, rangeStart - chunkBase);
    const sliceTo   = Math.min(buf.byteLength, rangeEnd - chunkBase + 1);
    parts.push(buf.slice(sliceFrom, sliceTo));
  }
  return concatBuffers(parts);
}

// ── 삭제 ─────────────────────────────────────────────────────────────────

/** 객체 데이터 삭제 — 소용량/대용량 자동 분기, 청크 병렬 삭제 */
export async function deleteObject(
  kv: KVNamespace,
  objectId: string,
  isSmall: boolean,
  chunkCount: number
): Promise<void> {
  if (isSmall) {
    await kv.delete(`${SMALL_PREFIX}${objectId}`);
    return;
  }
  await Promise.all(
    Array.from({ length: chunkCount }, (_, i) =>
      kv.delete(`${CHUNK_PREFIX}${objectId}:${i}`)
    )
  );
}

// ── 멀티파트 파트 전용 ────────────────────────────────────────────────────

/** 멀티파트 파트를 단일 청크(KV)로 저장 */
export async function writePart(
  kv: KVNamespace,
  partObjectId: string,
  data: ArrayBuffer
): Promise<string> {
  await kv.put(`${CHUNK_PREFIX}${partObjectId}:0`, data);
  return md5Hex(data);
}

/** 멀티파트 파트 읽기 */
export async function readPart(
  kv: KVNamespace,
  partObjectId: string
): Promise<ArrayBuffer | null> {
  return kv.get(`${CHUNK_PREFIX}${partObjectId}:0`, "arrayBuffer");
}

/** 멀티파트 파트 삭제 */
export async function deletePart(kv: KVNamespace, partObjectId: string): Promise<void> {
  await kv.delete(`${CHUNK_PREFIX}${partObjectId}:0`);
}

// ── 내부 유틸 ─────────────────────────────────────────────────────────────

async function readChunkedObject(
  kv: KVNamespace,
  objectId: string,
  chunkCount: number
): Promise<ArrayBuffer | null> {
  const fetches = Array.from({ length: chunkCount }, (_, i) =>
    kv.get(`${CHUNK_PREFIX}${objectId}:${i}`, "arrayBuffer")
  );
  const buffers = await Promise.all(fetches);
  if (buffers.some((b) => b === null)) return null;
  return concatBuffers(buffers as ArrayBuffer[]);
}

function concatBuffers(buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((s, b) => s + b.byteLength, 0);
  const out   = new Uint8Array(total);
  let offset  = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out.buffer;
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return toHex(digest);
}

export async function md5Hex(data: ArrayBuffer): Promise<string> {
  return md5(new Uint8Array(data));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 순수 JS MD5 (S3 ETag 호환, 보안 목적 아님)
function md5(input: Uint8Array): string {
  const s = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const msgLen = input.length;
  const padded = new Uint8Array(((msgLen + 8) >> 6) * 64 + 64);
  padded.set(input);
  padded[msgLen] = 0x80;
  const bitLen = BigInt(msgLen) * 8n;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, Number(bitLen & 0xffffffffn), true);
  dv.setUint32(padded.length - 4, Number((bitLen >> 32n) & 0xffffffffn), true);
  for (let off = 0; off < padded.length; off += 64) {
    const M = new Int32Array(16);
    for (let j = 0; j < 16; j++) M[j] = dv.getInt32(off + j * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0, g = 0;
      if (i < 16)      { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5*i+1)%16; }
      else if (i < 48) { F = B ^ C ^ D;           g = (3*i+5)%16; }
      else             { F = C ^ (B | ~D);         g = (7*i)%16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D; D = C; C = B;
      B = (B + ((F << s[i]) | (F >>> (32 - s[i])))) | 0;
    }
    a0=(a0+A)|0; b0=(b0+B)|0; c0=(c0+C)|0; d0=(d0+D)|0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setInt32(0,a0,true); ov.setInt32(4,b0,true); ov.setInt32(8,c0,true); ov.setInt32(12,d0,true);
  return [...out].map((b) => b.toString(16).padStart(2,"0")).join("");
}
