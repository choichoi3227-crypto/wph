import type { Env } from "../common";
import { errorResponse, json, uuid } from "../common";
import type { AuthedUser } from "../auth-middleware";

const PAYPAL_BASE: Record<Env["PAYPAL_ENV"], string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  live: "https://api-m.paypal.com",
};

async function getPayPalAccessToken(env: Env): Promise<string> {
  const base = PAYPAL_BASE[env.PAYPAL_ENV];
  const credentials = btoa(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`);
  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${credentials}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
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

  const base = PAYPAL_BASE[env.PAYPAL_ENV];
  const accessToken = await getPayPalAccessToken(env);
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

  let subscription = await env.DB.prepare("SELECT id FROM subscriptions WHERE hosting_id = ?")
    .bind(hostingId)
    .first<{ id: string }>();

  if (!subscription) {
    const subId = uuid();
    await env.DB.prepare(
      `INSERT INTO subscriptions (id, hosting_id, plan_id, status) VALUES (?, ?, ?, 'pending')`
    )
      .bind(subId, hostingId, hosting.plan_id)
      .run();
    subscription = { id: subId };
  }

  const invoiceId = uuid();
  await env.DB.prepare(
    `INSERT INTO invoices (id, subscription_id, amount_usd_cents, paypal_order_id, status)
     VALUES (?, ?, ?, ?, 'unpaid')`
  )
    .bind(invoiceId, subscription.id, hosting.price_usd_cents, orderData.id)
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

  const base = PAYPAL_BASE[env.PAYPAL_ENV];
  const accessToken = await getPayPalAccessToken(env);
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
    env.DB.prepare(
      "UPDATE subscriptions SET status = 'active', current_period_end = ? WHERE id = ?"
    ).bind(periodEnd.toISOString(), invoice.subscription_id),
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
