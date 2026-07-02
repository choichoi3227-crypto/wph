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
import { handleCreatePayment, handleCapturePayment, handlePayPalWebhook } from "./routes/payments";

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

      // /api/domains/{id}/dns
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

      // /api/hostings/{id}/payment
      const paymentMatch = path.match(/^\/api\/hostings\/([^/]+)\/payment$/);
      if (paymentMatch && method === "POST") {
        return handleCreatePayment(request, env, user, paymentMatch[1]);
      }
      if (path === "/api/payments/capture" && method === "POST") {
        return handleCapturePayment(request, env, user);
      }

      return errorResponse("not found", 404);
    } catch (err: any) {
      return errorResponse(err?.message ?? "internal error", 500);
    }
  },
};
