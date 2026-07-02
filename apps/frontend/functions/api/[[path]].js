/**
 * CloudPress Bridge — /api/* 프록시 Function
 * ------------------------------------------------
 * apps/frontend(js/common.js)는 상대경로 `/api/...` 로만 요청을 보낸다.
 * 하지만 실제 API는 별도 서브도메인(api.cloud-press.co.kr)의 Worker다.
 *
 * 브라우저 입장에서 cloud-press.co.kr(프론트) → api.cloud-press.co.kr(API)는
 * "다른 오리진"이라 세션 쿠키(cp_session)가 안 붙고 CORS 에러가 난다.
 *
 * 그래서 Pages Function으로 같은 오리진(cloud-press.co.kr)에서 요청을 받아
 * 내부적으로 api.cloud-press.co.kr 로 그대로 전달(proxy)한다.
 * → 브라우저는 항상 cloud-press.co.kr 하고만 통신 = 쿠키/CORS 문제 없음.
 *
 * 배포 위치: apps/frontend/functions/api/[[path]].js
 * (Cloudflare Pages는 /functions 디렉토리를 자동으로 Pages Functions로 인식한다)
 */

const API_ORIGIN = "https://api.cloud-press.co.kr";

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  // /api/xxx → https://api.cloud-press.co.kr/api/xxx (경로 그대로 전달)
  const targetUrl = new URL(url.pathname + url.search, API_ORIGIN);

  const proxiedRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
    redirect: "manual",
  });

  try {
    const apiResponse = await fetch(proxiedRequest);

    // Set-Cookie 등 헤더 그대로 전달. Set-Cookie에 Domain이 명시되어 있지 않으므로
    // 브라우저는 현재 요청 오리진(cloud-press.co.kr) 기준으로 쿠키를 저장한다.
    const headers = new Headers(apiResponse.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");

    return new Response(apiResponse.body, {
      status: apiResponse.status,
      statusText: apiResponse.statusText,
      headers,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: "API 프록시 요청 실패", detail: String(err) }), {
      status: 502,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
}
