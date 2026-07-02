import type { Env } from "../common";
import { json } from "../common";

export async function handleListPlans(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT id, name, price_usd_cents, features_json FROM plans ORDER BY price_usd_cents ASC"
  ).all<{ id: string; name: string; price_usd_cents: number; features_json: string }>();

  const plans = results.map((r) => ({
    id: r.id,
    name: r.name,
    priceUsd: r.price_usd_cents / 100,
    features: JSON.parse(r.features_json),
  }));

  return json({ plans });
}
