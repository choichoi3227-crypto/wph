/**
 * cloudpress-bridge 엔트리 워커
 * =============================
 * Workers 정적 자산(_redirects)은 "상대 경로"만 허용하며
 * (호스트를 바꾸는 www → apex 리다이렉트는 표현 불가),
 * 이를 시도하면 배포 시 "Only relative URLs are allowed" [code: 100324] 오류가 난다.
 *
 * 프론트엔드(sign-up.html 등)는 CORS를 피하려고 같은 호스트로
 * /api/... 상대 경로를 호출하는데, cloudpress-bridge는 정적 자산만
 * 서빙하는 워커라 그대로 두면 ASSETS.fetch가 매칭되는 파일을 못 찾아
 * 404를 반환한다. /api/*는 cloudpress-api로 서비스 바인딩 프록시한다.
 *
 * 우선순위: www 리다이렉트 → /api 프록시 → 정적 자산.
 */

const WWW_HOST = "www.cloud-press.co.kr";
const APEX_HOST = "cloud-press.co.kr";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.hostname === WWW_HOST) {
      url.hostname = APEX_HOST;
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname.startsWith("/api/")) {
      return env.API_WORKER.fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
};
