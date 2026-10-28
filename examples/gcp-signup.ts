/**
 * Minimal Google Cloud Marketplace sign-up endpoint (Next.js App Router style, but it's just Request → Response).
 *
 * Flow Google expects:
 *   1. Buyer clicks "Register with <you>" → Google POSTs x-gcp-marketplace-token here.
 *   2. You verify the JWT, show a registration PAGE (company, contact), and only after the buyer submits it
 *      do you call procurement accounts.approve.
 */
import { gcp } from "cloud-marketplace-saas";

const AUDIENCE = process.env.APP_URL!;                          // the domain you registered in Producer Portal
const PROVIDER_ID = process.env.MARKETPLACE_PROVIDER_ID!;

export async function POST(req: Request): Promise<Response> {
  const token = await gcp.extractMarketplaceToken(req);
  if (!token) return new Response("missing x-gcp-marketplace-token", { status: 400 });
  let claims: gcp.MarketplaceClaims;
  try { claims = await gcp.verifyMarketplaceToken(token, { audience: AUDIENCE }); }
  catch (e: any) { return new Response(`invalid marketplace token: ${e.message}`, { status: 401 }); }

  // Persist procurementAccountId however you like, then render your registration page.
  // Keep the verified id in a short-lived, httpOnly cookie so the form POST can reference it.
  const html = `<!doctype html><title>Complete your registration</title>
  <form method="post" action="/marketplace/complete">
    <input type="hidden" name="acct" value="${claims.procurementAccountId}">
    <label>Company <input name="company" required></label>
    <label>Contact e-mail <input name="email" type="email" required></label>
    <button>Activate</button>
  </form>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": `mp_acct=${claims.procurementAccountId}; HttpOnly; Secure; SameSite=Lax; Max-Age=1800; Path=/` } });
}

/** Called by the registration form above. */
export async function complete(procurementAccountId: string, orgId: string) {
  // 1) link procurementAccountId ↔ orgId in your DB
  // 2) attach any entitlements that already arrived for this account (they often do, before sign-up)
  // 3) tell Google the account is approved
  const api = await gcp.procurementClient(PROVIDER_ID);
  await api.approveAccount(procurementAccountId);
}
