/**
 * Hourly AWS Marketplace metering job (run it from EventBridge Scheduler / Cloud Scheduler / cron → an HTTP endpoint).
 * Assumes you store, per customer: licenseArn, awsAccountId, plan dimension, monthly allowance already consumed.
 */
import { aws } from "cloud-marketplace-saas";

const cfg: aws.AwsMarketplaceConfig = { productCode: process.env.AWS_MP_PRODUCT_CODE! };

type Customer = { orgId: string; licenseArn: string; awsAccountId: string; tier: "team" | "business"; includedPerMonth: number; usedThisMonth: number };

export async function meterHour(customers: Customer[], countUnreportedRequests: (orgId: string, before: Date) => Promise<number>) {
  const hour = aws.hourFloor();
  for (const c of customers) {
    const total = await countUnreportedRequests(c.orgId, hour);
    const free = Math.max(0, Math.min(total, c.includedPerMonth - c.usedThisMonth));
    const overage = Math.max(0, total - free);
    // Seller guide: send a record every hour even when usage is 0.
    await aws.meterUsage(cfg, [{ licenseArn: c.licenseArn, awsAccountId: c.awsAccountId, dimension: `requests_${c.tier}_overage`, quantity: overage, timestamp: hour }]);
    // then: mark those requests as reported and add `free` to usedThisMonth — in ONE transaction, after meterUsage succeeded
  }
}

/** Safety net behind EventBridge: re-check every license hourly. Cancelled contracts stop appearing in GetEntitlements. */
export async function resync(customers: Customer[]) {
  for (const c of customers) {
    const ents = await aws.getActiveEntitlements(cfg, c.licenseArn, c.awsAccountId);
    const plan = aws.pickContractDimension(ents, ["business_annual", "team_annual"]);
    if (!plan) { /* mark cancelled */ } else { /* update tier + expiry */ }
  }
}
