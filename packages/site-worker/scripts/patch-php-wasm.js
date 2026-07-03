#!/usr/bin/env node
/**
 * patch-php-wasm.js
 * ==================
 * @php-wasm/web-8-2/asyncify/php_8_2.js 는 파일 맨 위에
 *   import dependencyFilename from './8_2_30/php_8_2.wasm';
 * 라는 정적 import를 갖고 있다. wrangler(esbuild)는 이 import를 추적해
 * 21MB짜리 php_8_2.wasm 전체를 Worker 스크립트 번들에 포함시켜버리고,
 * 그 결과 "Worker exceeded size limit" (code: 10027) 로 배포가 실패한다.
 *
 * 하지만 php-runtime-do.ts는 loadPHPRuntime()에 커스텀 instantiateWasm
 * 콜백을 넘겨 자체 스토리지에서 받아온 wasm 바이트로 직접 인스턴스화한다.
 * Emscripten은 Module.instantiateWasm이 주어지면 dependencyFilename을
 * 통한 기본 fetch 기반 로딩 경로(locateFile(dependencyFilename))를
 * 전혀 실행하지 않으므로, dependencyFilename의 실제 값은 사용되지 않는다
 * (타입만 string이면 충분).
 *
 * 따라서 빌드 시점에 정적 wasm import를 동일 타입의 문자열 상수로
 * 치환해 esbuild가 21MB 바이너리를 추적/번들링하지 않도록 만든다.
 * node_modules는 git에 커밋되지 않고 매 빌드마다 새로 설치되므로,
 * 이 스크립트는 `npm run build` 단계에서 매번 실행된다 (멱등적).
 */

const fs = require("fs");
const path = require("path");

const CANDIDATE_PATHS = [
  // monorepo root node_modules (bun/npm workspace hoist)
  path.join(__dirname, "..", "..", "..", "node_modules", "@php-wasm", "web-8-2", "asyncify", "php_8_2.js"),
  // package-local node_modules (nested install)
  path.join(__dirname, "..", "node_modules", "@php-wasm", "web-8-2", "asyncify", "php_8_2.js"),
];

const IMPORT_LINE = "import dependencyFilename from './8_2_30/php_8_2.wasm';";
const PATCHED_LINE = "const dependencyFilename = './8_2_30/php_8_2.wasm';";

let patchedAny = false;

for (const filePath of CANDIDATE_PATHS) {
  if (!fs.existsSync(filePath)) continue;

  const src = fs.readFileSync(filePath, "utf8");

  if (src.includes(PATCHED_LINE)) {
    console.log(`[patch-php-wasm] 이미 패치됨: ${filePath}`);
    patchedAny = true;
    continue;
  }

  if (!src.includes(IMPORT_LINE)) {
    console.warn(
      `[patch-php-wasm] 예상한 import 라인을 찾지 못함 (패키지 버전이 바뀌었을 수 있음): ${filePath}`
    );
    continue;
  }

  const patched = src.replace(IMPORT_LINE, PATCHED_LINE);
  fs.writeFileSync(filePath, patched, "utf8");
  console.log(`[patch-php-wasm] 21MB 정적 wasm import 제거 완료: ${filePath}`);
  patchedAny = true;
}

if (!patchedAny) {
  console.warn(
    "[patch-php-wasm] 패치 대상 파일을 찾지 못했습니다 (node_modules 미설치?). " +
      "wrangler deploy 시 'Worker exceeded size limit' 오류가 재발할 수 있습니다."
  );
  // 빌드를 막지는 않는다 — 로컬 dev 환경 등에서 node_modules 구조가 다를 수 있음.
}
