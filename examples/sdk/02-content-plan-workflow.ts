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

const planId = plan.data.id ?? plan.data.planId;
console.log(`Plan created: ${planId}`);

// 2. Review the plan
const details = await sn.plans.get(planId);
for (const post of details.data.posts ?? []) {
  console.log(`  Day ${post.day} | ${post.platform} | ${post.title}`);
}

// 3. Approve the plan
await sn.plans.approve(planId, { action: "approve" });
console.log("Plan approved");

// 4. Schedule all posts (auto-selects optimal time slots)
const scheduled = await sn.plans.schedule(planId, { auto_slot: true });
console.log("All posts scheduled:", scheduled.data);
