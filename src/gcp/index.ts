/**
 * Google Cloud Marketplace — SaaS integration helpers.
 *
 * Covers the three legs Google requires of an integrated SaaS listing and that are undocumented or
 * under-documented in practice:
 *   1. Sign-up URL: Google POSTs `x-gcp-marketplace-token` (a JWT) as a *form field* (not a header).
 *      `extractMarketplaceToken()` reads it from a form body, multipart body, JSON body or query string.
 *   2. JWT verification against Google's Marketplace JWKS with the issuer/audience the frontend-integration
 *      doc specifies (`verifyMarketplaceToken()`), returning the procurement account id and roles.
 *   3. Procurement API (`accounts.approve`, `entitlements.get/approve/approvePlanChange`) and
 *      Service Control `services.report` for usage metering — both with Application Default Credentials.
 *
 * Nothing here touches a database. Persist accounts/entitlements however you like; see examples/.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

export const GOOGLE_MARKETPLACE_JWKS_URL =
  "https://www.googleapis.com/robot/v1/metadata/jwk/cloud-commerce-partner@system.gserviceaccount.com";
export const GOOGLE_MARKETPLACE_ISSUER =
  "https://www.googleapis.com/robot/v1/metadata/x509/cloud-commerce-partner@system.gserviceaccount.com";

/** Google's documented transport is the POST form body; reviewers' tools and tests use JSON or the query string. Accept all. */
export async function extractMarketplaceToken(req: Request): Promise<string> {
  const ct = (req.headers.get("content-type") ?? "").toLowerCase();
  const raw = await req.text().catch(() => "");
  const fromForm = (s: string) => { try { return new URLSearchParams(s).get("x-gcp-marketplace-token") ?? ""; } catch { return ""; } };
  let token = "";
  if (ct.includes("multipart/form-data")) {
    const m = raw.match(/name="x-gcp-marketplace-token"\r?\n\r?\n([^\r\n]+)/); token = m?.[1]?.trim() ?? "";
  } else if (ct.includes("json") || raw.trim().startsWith("{")) {
    try { const j = JSON.parse(raw); token = String(j?.["x-gcp-marketplace-token"] ?? j?.token ?? ""); } catch { /* fall through */ }
  }
  if (!token) token = fromForm(raw);
  if (!token) token = new URL(req.url).searchParams.get("x-gcp-marketplace-token") ?? "";
  return token.trim();
}

export type MarketplaceClaims = {
  /** `sub` — the procurement account id (`providers/<id>/accounts/<sub>`). */
  procurementAccountId: string;
  /** `google.user_identity` — an OPAQUE obfuscated id usable as OAuth `login_hint`. Never an e-mail. */
  userIdentity?: string;
  /** `google.roles` — e.g. `account_admin` (billing-account admin) or `project_editor`. */
  roles: string[];
  orders?: string[];
  payload: JWTPayload;
};

export type VerifyOptions = {
  /** The partner domain / URL registered in Producer Portal (JWT `aud`). Pass several if you serve more than one host. */
  audience: string | string[];
  /** Override only for tests (mint JWTs with your own key and serve a matching JWKS). */
  jwksUrl?: string;
  issuer?: string;
};

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function jwks(url: string) {
  let k = jwksCache.get(url); if (!k) { k = createRemoteJWKSet(new URL(url)); jwksCache.set(url, k); } return k;
}

/** Verify exactly what the frontend-integration doc requires: RS256 signature, `exp`, `iss`, `aud`, non-empty `sub`. */
export async function verifyMarketplaceToken(token: string, opts: VerifyOptions): Promise<MarketplaceClaims> {
  const { payload } = await jwtVerify(token, jwks(opts.jwksUrl ?? GOOGLE_MARKETPLACE_JWKS_URL), {
    issuer: opts.issuer ?? GOOGLE_MARKETPLACE_ISSUER, audience: opts.audience, algorithms: ["RS256"],
  });
  const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
  if (!sub) throw new Error("JWT sub (procurement account id) is empty");
  const g = (payload as any).google ?? {};
  const ui = g.user_identity;
  const userIdentity = typeof ui === "string" ? ui : typeof ui === "object" && ui ? String(ui.id ?? ui.sub ?? "") || undefined : undefined;
  return {
    procurementAccountId: sub, userIdentity,
    roles: Array.isArray(g.roles) ? g.roles.map(String) : [],
    orders: Array.isArray(g.orders) ? g.orders.map(String) : undefined,
    payload,
  };
}

/* ------------------------------------------------------------------------------------------------ Procurement API */

export type ProcurementEntitlement = {
  name: string; account: string; provider: string; product: string; plan: string; state: string;
  usageReportingId?: string; newPendingPlan?: string; newPendingOffer?: string; createTime?: string; updateTime?: string;
  [k: string]: unknown;
};

/** Thin Procurement API client over googleapis' auth (ADC). The service is not bundled in googleapis' typings, so we call REST. */
export async function procurementClient(providerId: string) {
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const base = "https://cloudcommerceprocurement.googleapis.com/v1";
  const call = async <T,>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
    const r = (await client.request({ url: `${base}/${path}`, method, data: body })) as { data: T }; return r.data;
  };
  const P = `providers/${providerId}`;
  return {
    /** Approve the procurement account after the buyer completed your sign-up page. Idempotent ("already approved" is swallowed). */
    approveAccount: (procurementAccountId: string, approvalName = "signup") =>
      call("POST", `${P}/accounts/${procurementAccountId}:approve`, { approvalName }).catch((e: any) => {
        if (!/already/i.test(String(e?.message))) throw e;
      }),
    getEntitlement: (id: string) => call<ProcurementEntitlement>("GET", `${P}/entitlements/${id}`),
    approveEntitlement: (id: string) => call("POST", `${P}/entitlements/${id}:approve`, {}),
    approvePlanChange: (id: string, pendingPlanName: string) =>
      call("POST", `${P}/entitlements/${id}:approvePlanChange`, { pendingPlanName }),
    listEntitlements: (filter?: string) =>
      call<{ entitlements?: ProcurementEntitlement[] }>("GET", `${P}/entitlements${filter ? `?filter=${encodeURIComponent(filter)}` : ""}`),
  };
}

/* ------------------------------------------------------------------------------------------------ Pub/Sub events */

export type ProcurementEvent = {
  eventId: string;
  /** ACCOUNT_ACTIVE | ACCOUNT_DELETED | ENTITLEMENT_CREATION_REQUESTED | ENTITLEMENT_ACTIVE | ENTITLEMENT_PLAN_CHANGE_REQUESTED |
   *  ENTITLEMENT_PLAN_CHANGED | ENTITLEMENT_PENDING_CANCELLATION | ENTITLEMENT_CANCELLATION_REVERTED | ENTITLEMENT_CANCELLED |
   *  ENTITLEMENT_DELETED | ENTITLEMENT_OFFER_ACCEPTED | ENTITLEMENT_OFFER_ENDED … */
  eventType: string;
  account?: { id: string; updateTime?: string };
  entitlement?: { id: string; updateTime?: string; newPlan?: string; newPendingPlan?: string; newPendingOfferDuration?: string; newPendingOffer?: string; newOffer?: string };
};

/** Decode a Pub/Sub push body (`{ message: { data: base64 } }`) or a pull message into the event object. */
export function decodePubSubEvent(body: unknown): ProcurementEvent {
  const b: any = body;
  const data: string | undefined = b?.message?.data ?? b?.data;
  if (!data) throw new Error("Pub/Sub body has no message.data");
  const json = Buffer.from(data, "base64").toString("utf8");
  return JSON.parse(json) as ProcurementEvent;
}

/** The state string you probably want to store: `ENTITLEMENT_PLAN_CHANGE_REQUESTED` → `plan_change_requested`. */
export const entitlementStateOf = (eventType: string) => eventType.replace("ENTITLEMENT_", "").toLowerCase();

/* ------------------------------------------------------------------------------------------------ Service Control */

export type UsageOperation = {
  operationId: string;
  /** Free-form label, shows in Service Control logs. */
  operationName: string;
  /** `usageReportingId` from the entitlement (`project_number:…`). */
  consumerId: string;
  /** Metric id as approved in Producer Portal, e.g. `conversation_units_team`. The service name prefix is added for you. */
  metric: string;
  /** DOUBLE metrics (unit "1") take a number; INT64 metrics take an integer. Check your service config. */
  value: number;
  startTime: Date; endTime: Date;
  labels?: Record<string, string>;
};

export type ReportResult = { ok: boolean; reportErrors: unknown[]; raw: unknown };

/**
 * Report usage to Service Control. One call may carry many operations (different consumers/metrics).
 * `serviceName` is the Portal service, e.g. `yourproduct.endpoints.<project>.cloud.goog`.
 * Values are sent as `doubleValue` by default; pass `int64` for INT64 metrics.
 */
export async function reportUsage(serviceName: string, ops: UsageOperation[], valueType: "double" | "int64" = "double"): Promise<ReportResult> {
  if (!ops.length) return { ok: true, reportErrors: [], raw: null };
  const { google } = await import("googleapis");
  const auth = new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/servicecontrol"] });
  const sc = google.servicecontrol({ version: "v1", auth: (await auth.getClient()) as any });
  const operations = ops.map((o) => ({
    operationId: o.operationId, operationName: o.operationName, consumerId: o.consumerId,
    startTime: o.startTime.toISOString(), endTime: o.endTime.toISOString(), labels: o.labels,
    metricValueSets: [{ metricName: `${serviceName}/${o.metric}`, metricValues: [valueType === "double" ? { doubleValue: o.value } : { int64Value: String(Math.round(o.value)) }] }],
  }));
  const res = await sc.services.report({ serviceName, requestBody: { operations } });
  const reportErrors = ((res.data as any)?.reportErrors ?? []) as unknown[];
  return { ok: reportErrors.length === 0, reportErrors, raw: res.data };
}

/** A collision-free operation id (Service Control de-duplicates on it; reuse = silently ignored). */
export const newOperationId = () => `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
