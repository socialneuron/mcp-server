/**
 * Fetch analytics, get AI insights, and find best posting times.
 *
 * Run: npx tsx examples/sdk/03-analytics-insights.ts
 */

import { SocialNeuron } from "@socialneuron/sdk";

const sn = new SocialNeuron({
  apiKey: process.env.SOCIALNEURON_API_KEY!,
});

// 1. Fetch performance analytics
const analytics = await sn.analytics.fetch({ days: 30, platform: "youtube" });
console.log("=== YouTube Analytics (30 days) ===");
console.log(analytics.data);

// 2. Get AI-generated insights
const insights = await sn.analytics.insights({ days: 30 });
console.log("\n=== AI Insights ===");
console.log(insights.data);

// 3. Find best posting times per platform
for (const platform of ["youtube", "tiktok", "instagram"] as const) {
  const times = await sn.analytics.postingTimes({ platform });
  console.log(`\n=== Best times for ${platform} ===`);
  console.log(times.data);
}

// 4. Check credit usage
const credits = await sn.account.credits();
console.log("\n=== Credits ===");
console.log(credits.data);
