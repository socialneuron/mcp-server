/**
 * Full content planning workflow: create plan → review → approve → schedule.
 *
 * Run: npx tsx examples/sdk/02-content-plan-workflow.ts
 */

import { SocialNeuron } from "@socialneuron/sdk";

const sn = new SocialNeuron({
  apiKey: process.env.SOCIALNEURON_API_KEY!,
});

// 1. Create a weekly content plan
console.log("Creating content plan...");
const plan = await sn.plans.create({
  topic: "AI tools for small businesses",
  platforms: ["youtube", "tiktok", "linkedin"],
  days: 7,
});

const planId = plan.data.plan_id;
if (!planId) {
  throw new Error("Plan response did not include plan_id");
}
console.log(`Plan created: ${planId}`);

// 2. Review the plan
const details = await sn.plans.get(planId);
for (const post of details.data.plan.posts ?? []) {
  console.log(`  Day ${post.day} | ${post.platform} | ${post.title}`);
}

// 3. Submit and approve the plan
await sn.plans.submitForApproval(planId);
const approvals = await sn.plans.approvals(planId);
for (const item of approvals.data.items) {
  await sn.plans.respondApproval(item.id, { decision: "approved" });
}
console.log("Plan approvals completed");

// 4. Schedule all posts (auto-selects optimal time slots)
const scheduled = await sn.plans.schedule(planId, { auto_slot: true });
console.log("All posts scheduled:", scheduled.data);
