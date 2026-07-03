import type { Env } from "../common";
import { errorResponse, json, uuid, getPayPalCreds, logActivity } from "../common";
import type { AuthedUser } from "../auth-middleware";

const PAYPAL_BASE: Record<"sandbox" | "live", string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

async function paypalAuth(env: Env): Promise<{ base: string; accessToken: string }> {
  const creds = await getPayPalCreds(env);
  const base = PAYPAL_BASE[creds.env];
  const credentials = btoa(`${creds.clientId}:${creds.clientSecret}`);
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = (await res.json()) as { access_token: string };
  return { base, accessToken: data.access_token };
}

/** 호스팅 플랜에 대한 PayPal 주문(1회성 결제, 월 단위 청구를 단순 주문 반복으로 처리) 생성 */
export async function handleCreatePayment(
  request: Request,
  env: Env,
  user: AuthedUser,
  hostingId: string
): Promise<Response> {
  const hosting = await env.DB.prepare(
    `SELECT h.id as id, h.plan_id as plan_id, p.price_usd_cents as price_usd_cents, p.name as plan_name
     FROM hostings h JOIN plans p ON p.id = h.plan_id
     WHERE h.id = ? AND h.user_id = ?`
  )
    .bind(hostingId, user.id)
    .first<{ id: string; plan_id: string; price_usd_cents: number; plan_name: string }>();
  if (!hosting) return errorResponse("hosting not found", 404);

  // 관리자가 결제 없이 발급한 호스팅은 결제 흐름 자체가 필요 없다
  const subscription = await env.DB.prepare(
    "SELECT granted_by_admin FROM subscriptions WHERE hosting_id = ?"
  )
    .bind(hostingId)
    .first<{ granted_by_admin: number }>();
  if (subscription?.granted_by_admin) {
    return errorResponse("this hosting was granted by an admin and does not require payment", 400);
  }

  const { base, accessToken } = await paypalAuth(env);
  const amount = (hosting.price_usd_cents / 100).toFixed(2);

  const orderRes = await fetch(`${base}/v2/checkout/orders`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [
        {
          custom_id: hostingId,
          description: `CloudPress Bridge - ${hosting.plan_name} 플랜 (${hostingId})`,
          amount: { currency_code: "USD", value: amount },
        },
      ],
    }),
  });
  const orderData = (await orderRes.json()) as { id: string; status: string };

  let sub = await env.DB.prepare("SELECT id FROM subscriptions WHERE hosting_id = ?")
    .bind(hostingId)
    .first<{ id: string }>();

  if (!sub) {
    const subId = uuid();
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, hosting_id, plan_id, status) VALUES (?, ?, ?, 'pending')`
    )
      .bind(subId, hostingId, hosting.plan_id)
      .run();
    sub = { id: subId };
  }

  const invoiceId = uuid();
  await env.DB.prepare(
    `INSERT INTO invoices (id, subscription_id, amount_usd_cents, paypal_order_id, status)
     VALUES (?, ?, ?, ?, 'unpaid')`
  )
    .bind(invoiceId, sub.id, hosting.price_usd_cents, orderData.id)
    .run();

  return json({ orderId: orderData.id, invoiceId, amountUsd: amount }, 201);
}

/** 클라이언트가 PayPal 결제 승인을 완료한 뒤 호출 — 서버에서 캡처 확정 */
export async function handleCapturePayment(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { orderId?: string } | null;
  if (!body?.orderId) return errorResponse("orderId is required");

  const invoice = await env.DB.prepare(
    `SELECT i.id as id, i.subscription_id as subscription_id, i.status as status
     FROM invoices i WHERE i.paypal_order_id = ?`
  )
    .bind(body.orderId)
    .first<{ id: string; subscription_id: string; status: string }>();
  if (!invoice) return errorResponse("invoice not found", 404);
  if (invoice.status === "paid") return json({ status: "paid" });

  const { base, accessToken } = await paypalAuth(env);
  const captureRes = await fetch(`${base}/v2/checkout/orders/${body.orderId}/capture`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
  });
  const captureData = (await captureRes.json()) as { status: string };

  if (captureData.status !== "COMPLETED") {
    await env.DB.prepare("UPDATE invoices SET status = 'failed' WHERE id = ?").bind(invoice.id).run();
    return errorResponse("payment capture failed", 402);
  }

  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  await env.DB.batch([
    env.DB.prepare("UPDATE invoices SET status = 'paid', paid_at = datetime('now') WHERE id = ?").bind(invoice.id),
    env.DB.prepare("UPDATE subscriptions SET status = 'active', current_period_end = ? WHERE id = ?").bind(
      periodEnd.toISOString(),
      invoice.subscription_id
    ),
  ]);

  return json({ status: "paid" });
}

/** PayPal 웹훅 수신 — 환불/구독 취소 등 비동기 이벤트 반영 (서명 검증은 배포 시 PAYPAL webhook id로 보강 필요) */
export async function handlePayPalWebhook(request: Request, env: Env): Promise<Response> {
  const event = (await request.json().catch(() => null)) as {
    event_type?: string;
    resource?: { id?: string };
  } | null;
  if (!event?.event_type) return errorResponse("invalid webhook payload");

  if (event.event_type === "PAYMENT.CAPTURE.REFUNDED") {
    const orderId = event.resource?.id;
    if (orderId) {
      await env.DB.prepare("UPDATE invoices SET status = 'refunded' WHERE paypal_order_id = ?")
        .bind(orderId)
        .run();
    }
  }

  return json({ received: true });
}

// ── 결제 수단 등록 (PayPal Vault v3) ─────────────────────────────────────────
// 프론트엔드는 PayPal JS SDK로 setup_token을 먼저 발급받아 사용자 승인을 받은 뒤,
// 승인된 setup_token을 이 엔드포인트로 넘겨 실제 결제 토큰(payment token)으로 교환한다.
export async function handleCreateSetupToken(env: Env, user: AuthedUser): Promise<Response> {
  const { base, accessToken } = await paypalAuth(env);
  const res = await fetch(`${base}/v3/vault/setup-tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      customer: { id: user.id },
      payment_source: { paypal: { usage_pattern: "IMMEDIATE", experience_context: { return_url: "https://cloud-press.co.kr/dashboard/billing.html" } } },
    }),
  });
  if (!res.ok) return errorResponse("failed to create paypal setup token", 502);
  const data = (await res.json()) as { id: string; links: Array<{ href: string; rel: string }> };
  const approveUrl = data.links.find((l) => l.rel === "approve")?.href ?? null;
  return json({ setupTokenId: data.id, approveUrl });
}

export async function handleRegisterPaymentMethod(request: Request, env: Env, user: AuthedUser): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { setupTokenId?: string } | null;
  if (!body?.setupTokenId) return errorResponse("setupTokenId is required");

  const { base, accessToken } = await paypalAuth(env);
  const res = await fetch(`${base}/v3/vault/payment-tokens`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ payment_source: { token: { id: body.setupTokenId, type: "SETUP_TOKEN" } } }),
  });
  if (!res.ok) return errorResponse("failed to register payment method", 502);
  const data = (await res.json()) as { id: string; payment_source?: { paypal?: { payer?: { email_address?: string } } } };

  const hasExisting = await env.DB.prepare("SELECT id FROM payment_methods WHERE user_id = ?").bind(user.id).first();
  const methodId = uuid();
  await env.DB.prepare(
    `INSERT INTO payment_methods (id, user_id, paypal_payment_token_id, payer_email, is_default)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(methodId, user.id, data.id, data.payment_source?.paypal?.payer?.email_address ?? null, hasExisting ? 0 : 1)
    .run();

  await logActivity(env, "account", user.id, "payment_method.registered");
  return json({ id: methodId, paypalPaymentTokenId: data.id }, 201);
}

export async function handleListPaymentMethods(env: Env, user: AuthedUser): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, payer_email, is_default, created_at FROM payment_methods WHERE user_id = ? ORDER BY created_at DESC"
  )
    .bind(user.id)
    .all();
  return json({ paymentMethods: results });
}

export async function handleDeletePaymentMethod(env: Env, user: AuthedUser, methodId: string): Promise<Response> {
  const method = await env.DB.prepare(
    "SELECT paypal_payment_token_id FROM payment_methods WHERE id = ? AND user_id = ?"
  )
    .bind(methodId, user.id)
    .first<{ paypal_payment_token_id: string }>();
  if (!method) return errorResponse("payment method not found", 404);

  const { base, accessToken } = await paypalAuth(env);
  await fetch(`${base}/v3/vault/payment-tokens/${method.paypal_payment_token_id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${accessToken}` },
  }).catch(() => null);

  await env.DB.prepare("DELETE FROM payment_methods WHERE id = ?").bind(methodId).run();
  return new Response(null, { status: 204 });
}

export async function handleSetDefaultPaymentMethod(env: Env, user: AuthedUser, methodId: string): Promise<Response> {
  const method = await env.DB.prepare("SELECT id FROM payment_methods WHERE id = ? AND user_id = ?")
    .bind(methodId, user.id)
    .first();
  if (!method) return errorResponse("payment method not found", 404);

  await env.DB.batch([
    env.DB.prepare("UPDATE payment_methods SET is_default = 0 WHERE user_id = ?").bind(user.id),
    env.DB.prepare("UPDATE payment_methods SET is_default = 1 WHERE id = ?").bind(methodId),
  ]);
  return json({ id: methodId, isDefault: true });
}
