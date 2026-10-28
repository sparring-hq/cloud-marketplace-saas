import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { extractMarketplaceToken, verifyMarketplaceToken, decodePubSubEvent, entitlementStateOf, newOperationId, GOOGLE_MARKETPLACE_ISSUER } from "../src/gcp/index.js";

const AUD = "https://example.test";

async function mintAndServe() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "t1", alg: "RS256", use: "sig" };
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ keys: [jwk] })); });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const sign = (claims: Record<string, unknown>, aud: string | string[] = AUD, iss = GOOGLE_MARKETPLACE_ISSUER) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "t1" }).setIssuer(iss).setAudience(aud).setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return { jwksUrl: `http://127.0.0.1:${port}/jwks`, sign, close: () => server.close() };
}

test("extractMarketplaceToken reads form, multipart, JSON and query", async () => {
  const form = new Request("https://x.test/signup", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "x-gcp-marketplace-token=abc.def.ghi" });
  assert.equal(await extractMarketplaceToken(form), "abc.def.ghi");
  const noCt = new Request("https://x.test/signup", { method: "POST", body: "x-gcp-marketplace-token=no.ct.token" });
  assert.equal(await extractMarketplaceToken(noCt), "no.ct.token");
  const mp = new Request("https://x.test/signup", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=B" }, body: `--B\r\nContent-Disposition: form-data; name="x-gcp-marketplace-token"\r\n\r\nmp.tok.en\r\n--B--` });
  assert.equal(await extractMarketplaceToken(mp), "mp.tok.en");
  const json = new Request("https://x.test/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ "x-gcp-marketplace-token": "js.on.tok" }) });
  assert.equal(await extractMarketplaceToken(json), "js.on.tok");
  const q = new Request("https://x.test/signup?x-gcp-marketplace-token=qu.ery.tok", { method: "POST", body: "" });
  assert.equal(await extractMarketplaceToken(q), "qu.ery.tok");
});

test("verifyMarketplaceToken accepts a valid token and surfaces procurement account id + roles", async () => {
  const h = await mintAndServe();
  try {
    const tok = await h.sign({ sub: "acct-123", google: { roles: ["account_admin"], user_identity: "opaque-xyz", orders: ["o1"] } });
    const c = await verifyMarketplaceToken(tok, { audience: AUD, jwksUrl: h.jwksUrl });
    assert.equal(c.procurementAccountId, "acct-123");
    assert.deepEqual(c.roles, ["account_admin"]);
    assert.equal(c.userIdentity, "opaque-xyz");
    assert.deepEqual(c.orders, ["o1"]);
  } finally { h.close(); }
});

test("verifyMarketplaceToken rejects wrong audience, wrong issuer, empty sub", async () => {
  const h = await mintAndServe();
  try {
    await assert.rejects(verifyMarketplaceToken(await h.sign({ sub: "a" }, "https://other.test"), { audience: AUD, jwksUrl: h.jwksUrl }));
    await assert.rejects(verifyMarketplaceToken(await h.sign({ sub: "a" }, AUD, "https://evil.test"), { audience: AUD, jwksUrl: h.jwksUrl }));
    await assert.rejects(verifyMarketplaceToken(await h.sign({ sub: "  " }), { audience: AUD, jwksUrl: h.jwksUrl }), /sub/);
    await assert.rejects(verifyMarketplaceToken("not.a.jwt", { audience: AUD, jwksUrl: h.jwksUrl }));
  } finally { h.close(); }
});

test("verifyMarketplaceToken accepts any of several audiences", async () => {
  const h = await mintAndServe();
  try {
    const tok = await h.sign({ sub: "acct-9" }, "https://b.test");
    const c = await verifyMarketplaceToken(tok, { audience: ["https://a.test", "https://b.test"], jwksUrl: h.jwksUrl });
    assert.equal(c.procurementAccountId, "acct-9");
  } finally { h.close(); }
});

test("decodePubSubEvent handles push envelopes and state helper", () => {
  const ev = { eventId: "e1", eventType: "ENTITLEMENT_PLAN_CHANGE_REQUESTED", entitlement: { id: "ent-1", newPendingPlan: "team-P1Y" } };
  const body = { message: { data: Buffer.from(JSON.stringify(ev)).toString("base64"), messageId: "1" }, subscription: "s" };
  const got = decodePubSubEvent(body);
  assert.equal(got.eventType, ev.eventType); assert.equal(got.entitlement?.newPendingPlan, "team-P1Y");
  assert.equal(entitlementStateOf(got.eventType), "plan_change_requested");
  assert.throws(() => decodePubSubEvent({}), /message.data/);
});

test("newOperationId is unique", () => {
  const s = new Set(Array.from({ length: 1000 }, newOperationId)); assert.equal(s.size, 1000);
});
