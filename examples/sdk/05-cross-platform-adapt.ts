/**
 * Generate content for one platform, then adapt it for others.
 *
 * Run: npx tsx examples/sdk/05-cross-platform-adapt.ts
 */

import { SocialNeuron } from "@socialneuron/sdk";

const sn = new SocialNeuron({
  apiKey: process.env.SOCIALNEURON_API_KEY!,
});

// 1. Generate original content for YouTube
console.log("Generating YouTube script...");
const original = await sn.content.generate({
  prompt: "Why every business needs an AI content strategy in 2026",
  platform: "youtube",
  content_type: "script",
});

console.log("Original script:", original.data);

// 2. Adapt for other platforms
console.log("\nAdapting for TikTok, LinkedIn, and Twitter...");
const adapted = await sn.content.adapt({
  content: JSON.stringify(original.data),
  source_platform: "youtube",
  target_platforms: ["tiktok", "linkedin", "twitter"],
});

console.log("Adapted versions:", adapted.data);
