/**
 * cloudpress-bridge 엔트리 워커
 * =============================
 * Workers 정적 자산(_redirects)은 "상대 경로"만 허용하며
 * (호스트를 바꾸는 www → apex 리다이렉트는 표현 불가),
 * 이를 시도하면 배포 시 "Only relative URLs are allowed" [code: 100324] 오류가 난다.
 *
 * 따라서 호스트 기반 리다이렉트는 여기서 직접 처리하고,
 * 그 외 모든 요청은 정적 자산(env.ASSETS)으로 그대로 넘긴다.
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

    return env.ASSETS.fetch(request);
  },
};
