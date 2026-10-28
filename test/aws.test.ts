import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRegistrationToken, pickContractDimension, hourFloor, readAgreementEvent } from "../src/aws/index.js";

test("extractRegistrationToken reads form, JSON and query", async () => {
  const form = new Request("https://x.test/register", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "x-amzn-marketplace-token=tok-form" });
  assert.equal(await extractRegistrationToken(form), "tok-form");
  const json = new Request("https://x.test/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ "x-amzn-marketplace-token": "tok-json" }) });
  assert.equal(await extractRegistrationToken(json), "tok-json");
  const q = new Request("https://x.test/register?x-amzn-marketplace-token=tok-q", { method: "POST", body: "" });
  assert.equal(await extractRegistrationToken(q), "tok-q");
  assert.equal(await extractRegistrationToken(new Request("https://x.test/register", { method: "POST", body: "" })), "");
});

test("pickContractDimension follows priority and returns expiry", () => {
  const exp = new Date("2027-10-27T00:00:00Z");
  const ents: any[] = [{ Dimension: "team_annual", ExpirationDate: exp }, { Dimension: "requests_team_overage" }];
  assert.deepEqual(pickContractDimension(ents, ["business_annual", "team_annual"]), { dimension: "team_annual", expires: exp });
  assert.equal(pickContractDimension(ents, ["business_annual"]), null);
});

test("hourFloor aligns to the hour", () => {
  const d = new Date("2026-10-28T09:41:52.123Z"); assert.equal(hourFloor(d).toISOString(), "2026-10-28T09:00:00.000Z");
});

test("readAgreementEvent checks the API-destination token and the event source", async () => {
  const ev = { id: "1", time: "2026-10-28T00:00:00Z", source: "aws.agreement-marketplace", "detail-type": "Agreement Status Change", detail: { agreementId: "agmt-1", status: "ACTIVE" } };
  const ok = new Request("https://x.test/events", { method: "POST", headers: { "x-marketplace-events-token": "secret" }, body: JSON.stringify(ev) });
  assert.equal((await readAgreementEvent(ok, "secret")).detail.agreementId, "agmt-1");
  const bad = new Request("https://x.test/events", { method: "POST", headers: { "x-marketplace-events-token": "nope" }, body: JSON.stringify(ev) });
  await assert.rejects(readAgreementEvent(bad, "secret"), /token/);
  const wrongSrc = new Request("https://x.test/events", { method: "POST", headers: { "x-marketplace-events-token": "secret" }, body: JSON.stringify({ ...ev, source: "aws.ec2" }) });
  await assert.rejects(readAgreementEvent(wrongSrc, "secret"), /source/);
  const noSecret = new Request("https://x.test/events", { method: "POST", headers: { "x-marketplace-events-token": "secret" }, body: JSON.stringify(ev) });
  await assert.rejects(readAgreementEvent(noSecret, ""), /token/);
});
