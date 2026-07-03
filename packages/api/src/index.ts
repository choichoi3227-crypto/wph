import type { Env } from "./common";
import { errorResponse } from "./common";
import { authenticate } from "./auth-middleware";
import { handleSignUp, handleSignIn, handleSignOut, handleMe } from "./routes/auth";
import {
  handleCreateHosting,
  handleListHostings,
  handleGetHosting,
  handleDeleteHosting,
  handleUpdatePlan,
} from "./routes/hostings";
import {
  handleAddDomain,
  handleCheckDomainStatus,
  handleListDomains,
  handleDeleteDomain,
  handleAddDnsRecord,
  handleListDnsRecords,
  handleDeleteDnsRecord,
} from "./routes/dns";
import { handleListPlans } from "./routes/plans";
import {
  handleCreatePayment,
  handleCapturePayment,
  handlePayPalWebhook,
  handleCreateSetupToken,
  handleRegisterPaymentMethod,
  handleListPaymentMethods,
  handleDeletePaymentMethod,
  handleSetDefaultPaymentMethod,
} from "./routes/payments";
import {
  handleHostingOverview,
  handleHostingLogs,
  handleHostingStorageUsage,
  handleHostingDbQuery,
  handlePurgeWpCache,
  handlePurgeCloudflareCache,
  handleUpdatesCheck,
  handleUpdatesApply,
  handleCertificateStatus,
  handleCreateBackup,
  handleListBackups,
  handleRestoreBackup,
  handleTraffic,
  handleListSites,
  handleCreateSite,
  handleDeleteSite,
} from "./routes/hosting-detail";
import {
  handleGetAdminSettings,
  handleUpdateAdminSettings,
  handleAdminListUsers,
  handleAdminSetUserRole,
  handleAdminListHostings,
  handleAdminCreateHosting,
  handleAdminSuspendHosting,
  handleAdminReactivateHosting,
  handleAdminListInvoices,
} from "./routes/admin";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ---------- Public ----------
      if (path === "/api/auth/sign-up" && method === "POST") return handleSignUp(request, env);
      if (path === "/api/auth/sign-in" && method === "POST") return handleSignIn(request, env);
      if (path === "/api/auth/sign-out" && method === "POST") return handleSignOut(request, env);
      if (path === "/api/plans" && method === "GET") return handleListPlans(env);
      if (path === "/api/payments/webhook" && method === "POST") return handlePayPalWebhook(request, env);

      // ---------- Authenticated ----------
      const user = await authenticate(request, env);

      if (path === "/api/auth/me" && method === "GET") return handleMe(request, env);

      if (!user) return errorResponse("authentication required", 401);

      // /api/hostings
      if (path === "/api/hostings" && method === "POST") return handleCreateHosting(request, env, user);
      if (path === "/api/hostings" && method === "GET") return handleListHostings(env, user);

      const hostingMatch = path.match(/^\/api\/hostings\/([^/]+)$/);
      if (hostingMatch) {
        const [, hostingId] = hostingMatch;
        if (method === "GET") return handleGetHosting(env, user, hostingId);
        if (method === "DELETE") return handleDeleteHosting(env, user, hostingId);
        if (method === "PATCH") return handleUpdatePlan(request, env, user, hostingId);
      }

      // ---------- 호스팅 상세 페이지 하위 라우트 ----------
      const overviewMatch = path.match(/^\/api\/hostings\/([^/]+)\/overview$/);
      if (overviewMatch && method === "GET") return handleHostingOverview(env, user, overviewMatch[1]);

      const logsMatch = path.match(/^\/api\/hostings\/([^/]+)\/logs$/);
      if (logsMatch && method === "GET") {
        const limit = Number(url.searchParams.get("limit") ?? "100");
        return handleHostingLogs(env, user, logsMatch[1], limit);
      }

      const storageMatch = path.match(/^\/api\/hostings\/([^/]+)\/storage$/);
      if (storageMatch && method === "GET") return handleHostingStorageUsage(env, user, storageMatch[1]);

      const dbMatch = path.match(/^\/api\/hostings\/([^/]+)\/db\/query$/);
      if (dbMatch && method === "POST") return handleHostingDbQuery(request, env, user, dbMatch[1]);

      const purgeWpMatch = path.match(/^\/api\/hostings\/([^/]+)\/cache\/purge-wp$/);
      if (purgeWpMatch && method === "POST") return handlePurgeWpCache(env, user, purgeWpMatch[1]);

      const purgeCfMatch = path.match(/^\/api\/hostings\/([^/]+)\/cache\/purge-cloudflare$/);
      if (purgeCfMatch && method === "POST") return handlePurgeCloudflareCache(env, user, purgeCfMatch[1]);

      const updatesCheckMatch = path.match(/^\/api\/hostings\/([^/]+)\/updates$/);
      if (updatesCheckMatch && method === "GET") return handleUpdatesCheck(env, user, updatesCheckMatch[1]);
      if (updatesCheckMatch && method === "POST") return handleUpdatesApply(request, env, user, updatesCheckMatch[1]);

      const certMatch = path.match(/^\/api\/hostings\/([^/]+)\/certificates$/);
      if (certMatch && method === "GET") return handleCertificateStatus(env, user, certMatch[1]);

      const backupsMatch = path.match(/^\/api\/hostings\/([^/]+)\/backups$/);
      if (backupsMatch && method === "GET") return handleListBackups(env, user, backupsMatch[1]);
      if (backupsMatch && method === "POST") return handleCreateBackup(env, user, backupsMatch[1]);

      const backupRestoreMatch = path.match(/^\/api\/hostings\/([^/]+)\/backups\/([^/]+)\/restore$/);
      if (backupRestoreMatch && method === "POST") {
        return handleRestoreBackup(env, user, backupRestoreMatch[1], backupRestoreMatch[2]);
      }

      const trafficMatch = path.match(/^\/api\/hostings\/([^/]+)\/traffic$/);
      if (trafficMatch && method === "GET") return handleTraffic(env, user, trafficMatch[1]);

      // 멀티사이트
      const sitesMatch = path.match(/^\/api\/hostings\/([^/]+)\/sites$/);
      if (sitesMatch && method === "GET") return handleListSites(env, user, sitesMatch[1]);
      if (sitesMatch && method === "POST") return handleCreateSite(request, env, user, sitesMatch[1]);

      const siteMatch = path.match(/^\/api\/hostings\/([^/]+)\/sites\/([^/]+)$/);
      if (siteMatch && method === "DELETE") return handleDeleteSite(env, user, siteMatch[1], siteMatch[2]);

      // /api/hostings/{id}/domains
      const domainsMatch = path.match(/^\/api\/hostings\/([^/]+)\/domains$/);
      if (domainsMatch) {
        const [, hostingId] = domainsMatch;
        if (method === "POST") return handleAddDomain(request, env, user, hostingId);
        if (method === "GET") return handleListDomains(env, user, hostingId);
      }

      // /api/domains/{id}
      const domainMatch = path.match(/^\/api\/domains\/([^/]+)$/);
      if (domainMatch) {
        const [, domainId] = domainMatch;
        if (method === "DELETE") return handleDeleteDomain(env, user, domainId);
      }

      // /api/domains/{id}/status
      const domainStatusMatch = path.match(/^\/api\/domains\/([^/]+)\/status$/);
      if (domainStatusMatch && method === "GET") {
        return handleCheckDomainStatus(env, user, domainStatusMatch[1]);
      }

      // /api/domains/{id}/dns — "서브도메인" 탭: 사용자의 개인 도메인에 DNS 레코드(서브도메인) 생성
      const dnsListMatch = path.match(/^\/api\/domains\/([^/]+)\/dns$/);
      if (dnsListMatch) {
        const [, domainId] = dnsListMatch;
        if (method === "POST") return handleAddDnsRecord(request, env, user, domainId);
        if (method === "GET") return handleListDnsRecords(env, user, domainId);
      }

      // /api/domains/{id}/dns/{recordId}
      const dnsRecordMatch = path.match(/^\/api\/domains\/([^/]+)\/dns\/([^/]+)$/);
      if (dnsRecordMatch && method === "DELETE") {
        const [, domainId, recordId] = dnsRecordMatch;
        return handleDeleteDnsRecord(env, user, domainId, recordId);
      }

      // /api/hostings/{id}/payment — 비로그인 사용자는 이 지점에 도달하기 전에 프론트에서 로그인으로 리다이렉트됨
      const paymentMatch = path.match(/^\/api\/hostings\/([^/]+)\/payment$/);
      if (paymentMatch && method === "POST") {
        return handleCreatePayment(request, env, user, paymentMatch[1]);
      }
      if (path === "/api/payments/capture" && method === "POST") {
        return handleCapturePayment(request, env, user);
      }

      // ---------- 결제 수단 (PayPal Vault) ----------
      if (path === "/api/payment-methods/setup-token" && method === "POST") {
        return handleCreateSetupToken(env, user);
      }
      if (path === "/api/payment-methods" && method === "POST") {
        return handleRegisterPaymentMethod(request, env, user);
      }
      if (path === "/api/payment-methods" && method === "GET") {
        return handleListPaymentMethods(env, user);
      }
      const paymentMethodMatch = path.match(/^\/api\/payment-methods\/([^/]+)$/);
      if (paymentMethodMatch && method === "DELETE") {
        return handleDeletePaymentMethod(env, user, paymentMethodMatch[1]);
      }
      const paymentMethodDefaultMatch = path.match(/^\/api\/payment-methods\/([^/]+)\/default$/);
      if (paymentMethodDefaultMatch && method === "POST") {
        return handleSetDefaultPaymentMethod(env, user, paymentMethodDefaultMatch[1]);
      }

      // ---------- 어드민 전용 ----------
      if (path.startsWith("/api/admin/")) {
        if (!user.isAdmin) return errorResponse("admin access required", 403);

        if (path === "/api/admin/settings" && method === "GET") return handleGetAdminSettings(env);
        if (path === "/api/admin/settings" && method === "PATCH") return handleUpdateAdminSettings(request, env);

        if (path === "/api/admin/users" && method === "GET") return handleAdminListUsers(env, url);
        const userRoleMatch = path.match(/^\/api\/admin\/users\/([^/]+)\/role$/);
        if (userRoleMatch && method === "PATCH") return handleAdminSetUserRole(request, env, userRoleMatch[1]);

        if (path === "/api/admin/hostings" && method === "GET") return handleAdminListHostings(env, url);
        if (path === "/api/admin/hostings" && method === "POST") return handleAdminCreateHosting(request, env, user);

        const suspendMatch = path.match(/^\/api\/admin\/hostings\/([^/]+)\/suspend$/);
        if (suspendMatch && method === "POST") return handleAdminSuspendHosting(env, suspendMatch[1]);

        const reactivateMatch = path.match(/^\/api\/admin\/hostings\/([^/]+)\/reactivate$/);
        if (reactivateMatch && method === "POST") return handleAdminReactivateHosting(env, reactivateMatch[1]);

        // 삭제는 일반 삭제 로직(정리 로직 포함)을 그대로 재사용
        const adminDeleteMatch = path.match(/^\/api\/admin\/hostings\/([^/]+)$/);
        if (adminDeleteMatch && method === "DELETE") return handleDeleteHosting(env, user, adminDeleteMatch[1]);

        if (path === "/api/admin/invoices" && method === "GET") return handleAdminListInvoices(env, url);

        return errorResponse("not found", 404);
      }

      return errorResponse("not found", 404);
    } catch (err: any) {
      return errorResponse(err?.message ?? "internal error", 500);
    }
  },
};
