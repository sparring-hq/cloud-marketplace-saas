/**
 * AWS Marketplace — SaaS integration helpers (Concurrent Agreements contract, 2026+).
 *
 * What changed for sellers registered after mid-2026 and why this module exists:
 *   - `ResolveCustomer` returns `CustomerAWSAccountId` + `LicenseArn` (the `CustomerIdentifier` is optional/legacy).
 *   - `BatchMeterUsage` records carry `LicenseArn` and MUST NOT include `ProductCode` (it would double-bill).
 *   - `GetEntitlements` filtered by `LICENSE_ARN` can return nothing while `CUSTOMER_AWS_ACCOUNT_ID` returns the row
 *     (observed on a real purchase 2026-10-26). `getActiveEntitlements()` queries by account first, then matches the ARN.
 *   - New sellers get no SNS topics; subscription changes arrive via EventBridge (`source: aws.agreement-marketplace`).
 *   - The seller guide asks for an hourly metering call even with zero usage ("send … usage of 0").
 *
 * Nothing here touches a database. Persist the license/account mapping however you like; see examples/.
 */
import { MarketplaceMeteringClient, ResolveCustomerCommand, BatchMeterUsageCommand, type UsageRecord } from "@aws-sdk/client-marketplace-metering";
import { MarketplaceEntitlementServiceClient, GetEntitlementsCommand, type Entitlement } from "@aws-sdk/client-marketplace-entitlement-service";

export type AwsMarketplaceConfig = {
  /** Product code from the Catalog API / AMMP (e.g. `5ts5xmgjy8fcxwq941r08mf9k`). Used for entitlements and token sanity checks. */
  productCode: string;
  /** Metering/entitlement APIs live in us-east-1 for every product. */
  region?: string;
};

export type AwsCustomer = {
  licenseArn: string;
  awsAccountId: string;
  productCode: string;
  /** Legacy identifier — absent under Concurrent Agreements. */
  customerId: string | null;
};

const clients = (cfg: AwsMarketplaceConfig) => {
  const region = cfg.region ?? "us-east-1";
  return { metering: new MarketplaceMeteringClient({ region }), entitlements: new MarketplaceEntitlementServiceClient({ region }) };
};

/** Read `x-amzn-marketplace-token` from the fulfillment-URL POST (form body, JSON body or query string). */
export async function extractRegistrationToken(req: Request): Promise<string> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  const raw = await req.text().catch(() => "");
  let token = "";
  if (ct.includes("json") || raw.trim().startsWith("{")) { try { const j = JSON.parse(raw); token = String(j?.["x-amzn-marketplace-token"] ?? j?.token ?? ""); } catch { /* fall through */ } }
  if (!token) { try { token = new URLSearchParams(raw).get("x-amzn-marketplace-token") ?? ""; } catch { /* ignore */ } }
  if (!token) token = new URL(req.url).searchParams.get("x-amzn-marketplace-token") ?? "";
  return token.trim();
}

/** Exchange the registration token for the buyer's identity. Throws if the token belongs to another product. */
export async function resolveCustomer(cfg: AwsMarketplaceConfig, token: string): Promise<AwsCustomer> {
  const r = await clients(cfg).metering.send(new ResolveCustomerCommand({ RegistrationToken: token }));
  if (!r.LicenseArn || !r.CustomerAWSAccountId) throw new Error("ResolveCustomer returned no LicenseArn/CustomerAWSAccountId");
  if (r.ProductCode && cfg.productCode && r.ProductCode !== cfg.productCode) throw new Error("registration token is for a different product");
  return { licenseArn: r.LicenseArn, awsAccountId: r.CustomerAWSAccountId, productCode: r.ProductCode ?? cfg.productCode, customerId: r.CustomerIdentifier ?? null };
}

/**
 * Active (non-expired) entitlements for a license. Queries by `CUSTOMER_AWS_ACCOUNT_ID` first and matches the ARN in the
 * result, falling back to `LICENSE_ARN` — the ARN filter alone has been observed to return an empty list.
 */
export async function getActiveEntitlements(cfg: AwsMarketplaceConfig, licenseArn: string, awsAccountId?: string | null): Promise<Entitlement[]> {
  const svc = clients(cfg).entitlements;
  const q = async (Filter: Record<string, string[]>) => (await svc.send(new GetEntitlementsCommand({ ProductCode: cfg.productCode, Filter }))).Entitlements ?? [];
  let ents = awsAccountId ? await q({ CUSTOMER_AWS_ACCOUNT_ID: [awsAccountId] }) : [];
  if (ents.length) { const mine = ents.filter((e) => !e.LicenseArn || e.LicenseArn === licenseArn); if (mine.length) ents = mine; }
  if (!ents.length) ents = await q({ LICENSE_ARN: [licenseArn] });
  const now = Date.now();
  return ents.filter((e) => !e.ExpirationDate || e.ExpirationDate.getTime() > now);
}

/** Pick the contract dimension the customer holds (e.g. `team_annual` vs `business_annual`) by a priority list. */
export function pickContractDimension(ents: Entitlement[], priority: string[]): { dimension: string; expires: Date | null } | null {
  const dims = new Set(ents.map((e) => e.Dimension ?? ""));
  for (const d of priority) if (dims.has(d)) return { dimension: d, expires: ents.find((e) => e.Dimension === d)?.ExpirationDate ?? null };
  return null;
}

export type MeterRecord = { licenseArn: string; awsAccountId: string; dimension: string; quantity: number; timestamp: Date };

/**
 * Send usage. Records are rounded to integers (AWS requires whole units — price a `model_access_usd` dimension per cent and send cents).
 * Pass a zero-quantity record for the hourly heartbeat when there was no traffic. `ProductCode` is intentionally NOT sent.
 * Throws if AWS reports unprocessed records (caller decides whether to retry; records are idempotent per Timestamp+Dimension).
 */
export async function meterUsage(cfg: AwsMarketplaceConfig, records: MeterRecord[]) {
  if (!records.length) return { results: [], unprocessed: [] };
  const UsageRecords: UsageRecord[] = records.map((r) => ({
    CustomerAWSAccountId: r.awsAccountId, LicenseArn: r.licenseArn, Dimension: r.dimension, Quantity: Math.max(0, Math.round(r.quantity)), Timestamp: r.timestamp,
  }));
  const res = await clients(cfg).metering.send(new BatchMeterUsageCommand({ UsageRecords }));
  const unprocessed = res.UnprocessedRecords ?? [];
  if (unprocessed.length) throw new Error(`BatchMeterUsage unprocessed: ${unprocessed.map((u) => u.Dimension).join(",")}`);
  return { results: res.Results ?? [], unprocessed };
}

/** Hour-aligned timestamp (AWS accepts up to 6 h in the past; align to the hour so retries de-duplicate). */
export const hourFloor = (d = new Date()) => { const h = new Date(d); h.setMinutes(0, 0, 0); return h; };

/* ------------------------------------------------------------------------------------------------ EventBridge */

export type AgreementEvent = {
  id: string; time: string; source: string; "detail-type": string;
  detail: { agreementId?: string; status?: string; acceptor?: { accountId?: string }; proposer?: { accountId?: string }; [k: string]: unknown };
  [k: string]: unknown;
};

/**
 * Validate an EventBridge → API-destination delivery. API destinations authenticate with a static header you configure
 * (`API_KEY` auth type); compare it in constant time. Returns the parsed event or throws.
 */
export async function readAgreementEvent(req: Request, expectedToken: string, headerName = "x-marketplace-events-token"): Promise<AgreementEvent> {
  const got = req.headers.get(headerName) ?? "";
  if (!expectedToken || !timingSafeEqual(got, expectedToken)) throw new Error("bad events token");
  const ev = (await req.json()) as AgreementEvent;
  if (ev.source !== "aws.agreement-marketplace" && ev.source !== "aws.marketplace") throw new Error(`unexpected event source ${ev.source}`);
  return ev;
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0;
}
