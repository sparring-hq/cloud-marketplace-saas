# cloud-marketplace-saas

Google Cloud Marketplace **and** AWS Marketplace integration helpers for SaaS sellers, extracted from two listings we actually
shipped and got reviewed (a conversation-assurance product on Google Cloud Marketplace and an AI gateway on both). Everything
here is a thing the official docs under-explain and that cost us a review round or a day of debugging.

No database, no framework. Plain functions you call from your own routes (Next.js, Express, Hono, Cloud Run, Lambda…).

```bash
npm i cloud-marketplace-saas jose googleapis            # Google Cloud
npm i cloud-marketplace-saas @aws-sdk/client-marketplace-metering @aws-sdk/client-marketplace-entitlement-service   # AWS
```

---

## Google Cloud Marketplace (integrated SaaS)

### What Google actually sends to your Sign-up URL

Google **POSTs a form** (`application/x-www-form-urlencoded`) with one field, `x-gcp-marketplace-token`, a JWT. It is **not a header**.
Reviewers' test tools sometimes send it as JSON or in the query string. If your sign-up endpoint returns JSON instead of a
registration *page*, the technical-integration review bounces it ("Sign Up URL isn't correct") — the sign-up URL must render a page
that collects the customer's contact details, because Google does not share buyer PII with you.

```ts
import { gcp } from "cloud-marketplace-saas";

export async function POST(req: Request) {
  const token = await gcp.extractMarketplaceToken(req);                 // form | multipart | JSON | query
  const claims = await gcp.verifyMarketplaceToken(token, { audience: "https://app.example.com" });
  // claims.procurementAccountId  → store it, render your registration form, keep the token/claims in a short-lived cookie
  // claims.roles                 → ["account_admin"] means the buyer administers the billing account
  // claims.userIdentity          → OPAQUE id (use as OAuth login_hint); it is NOT an e-mail
}
```

`verifyMarketplaceToken` checks exactly what the frontend-integration doc requires: RS256 signature against Google's JWKS, `exp`,
`iss` (`…/cloud-commerce-partner@system.gserviceaccount.com`), `aud` (your registered domain) and a non-empty `sub`.

### After the customer finishes your registration page

```ts
const api = await gcp.procurementClient(process.env.MARKETPLACE_PROVIDER_ID!);
await api.approveAccount(claims.procurementAccountId);                // idempotent; "already approved" is swallowed
```

### Pub/Sub entitlement events

Google pushes `ENTITLEMENT_CREATION_REQUESTED`, `ENTITLEMENT_ACTIVE`, `…_PLAN_CHANGE_REQUESTED`, `…_CANCELLED`, `ACCOUNT_DELETED`…
to the Pub/Sub topic `projects/cloudcommerceproc-prod/topics/<provider-id>`.

```ts
const ev = gcp.decodePubSubEvent(await req.json());                   // base64 envelope → event object
if (ev.eventType === "ENTITLEMENT_CREATION_REQUESTED") await api.approveEntitlement(ev.entitlement!.id);
if (ev.eventType === "ENTITLEMENT_PLAN_CHANGE_REQUESTED") await api.approvePlanChange(ev.entitlement!.id, ev.entitlement!.newPendingPlan!);
const detail = await api.getEntitlement(ev.entitlement!.id);          // → usageReportingId, plan, state
```

**Ordering gotcha we hit on the first real purchase:** entitlement events arrive *right after the order*, while the buyer reaches
your sign-up page *later*. If you key entitlements to an organisation at event time, the first ones land with no owner. Store
them by `procurementAccountId` and attach them when `approveAccount` runs (and again from an hourly job as a safety net).

### Usage metering (Service Control)

```ts
await gcp.reportUsage(process.env.MARKETPLACE_SERVICE_NAME!, [{
  operationId: gcp.newOperationId(), operationName: "requests",
  consumerId: detail.usageReportingId!,                                 // "project_number:123…"
  metric: "requests_team",                                              // metric id as approved in Producer Portal
  value: 1234, startTime: hourStart, endTime: hourEnd,
}]);
```

Things that are true but hard to find:
- Metric ids must be **unique per plan** in Producer Portal (`requests_team`, `requests_business`…), so your code maps plan → metric.
- Check the service config for the metric's `valueType`: `DOUBLE` metrics with unit `1` take a fractional `doubleValue`; if your Portal
  price is e.g. US$1.05 per unit of "provider list price", report the raw USD — the markup lives in the Portal price, not in your code.
- Service Control de-duplicates on `operationId`; a retry with the same id is silently ignored (good) — so **mark your rows as
  reported only after** `reportErrors` is empty, and reconcile the other direction on the next run.
- Run the hourly report from **Cloud Scheduler → an HTTP endpoint**, not from a `setInterval` in a Cloud Run service: with
  `minScale: 0` the process is not running between requests and the timer never fires (ours silently didn't, for a week).

---

## AWS Marketplace (SaaS, Concurrent Agreements)

Sellers registered from mid-2026 are on the **Concurrent Agreements** contract. The classic examples (CustomerIdentifier + ProductCode
in every call, SNS topics for subscription events) don't apply:

| Classic | Concurrent Agreements (this library) |
|---|---|
| `ResolveCustomer` → `CustomerIdentifier` | → `CustomerAWSAccountId` + **`LicenseArn`** |
| `BatchMeterUsage` with `ProductCode` | **no `ProductCode`** — the `LicenseArn` identifies product + agreement; sending both double-bills |
| `GetEntitlements` by `CUSTOMER_IDENTIFIER` | by `CUSTOMER_AWS_ACCOUNT_ID` (the `LICENSE_ARN` filter alone returned nothing on a real purchase) |
| SNS topics `aws-mp-subscription-notification` | **EventBridge**, `source: aws.agreement-marketplace`, delivered to an API destination |

```ts
import { aws } from "cloud-marketplace-saas";
const cfg = { productCode: process.env.AWS_MP_PRODUCT_CODE! };

// Fulfillment URL (AWS POSTs x-amzn-marketplace-token as a form field)
const token = await aws.extractRegistrationToken(req);
const customer = await aws.resolveCustomer(cfg, token);                // { licenseArn, awsAccountId, productCode, customerId|null }

// Which contract dimension does the buyer hold?
const ents = await aws.getActiveEntitlements(cfg, customer.licenseArn, customer.awsAccountId);
const plan = aws.pickContractDimension(ents, ["business_annual", "team_annual"]);   // → { dimension, expires }

// Hourly metering — send a 0 record when there was no traffic (seller guide asks for an hourly heartbeat)
await aws.meterUsage(cfg, [{ licenseArn: customer.licenseArn, awsAccountId: customer.awsAccountId,
  dimension: "requests_team_overage", quantity: overage, timestamp: aws.hourFloor() }]);

// EventBridge → API destination (API_KEY auth header you configure on the connection)
const ev = await aws.readAgreementEvent(req, process.env.AWS_MP_EVENTS_TOKEN!);   // throws on bad token / wrong source
```

Catalog API facts that bit us (no code, just so you don't repeat them):
- Usage dimensions (`ExternallyMetered`) **must be created in the same change set as the product**; you cannot add them to an existing
  SaaS product later — we had to create a v2 product.
- `Description` ≤ 90 chars, `Name` ≤ 80; `ReleaseProduct` needs EULA + refund policy **+ a renewal term** in the offer.
- Metering/entitlement APIs are **us-east-1** regardless of where you run.
- A `$1` self-directed private offer is the cheapest way to make a real end-to-end purchase of your own listing before requesting Public.

---

## Status

Used in production for two listings since October 2026. API is small and may still move before 1.0; pin a minor version.

Contributions welcome — especially corrections where Google/AWS behaviour differs from what's described here. Open an issue with the
exact error text and the API call; that is the only kind of evidence that settles these questions.

## License

MIT © Carnegie Intelligent Technology Limited
