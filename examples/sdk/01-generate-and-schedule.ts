/**
 * Generate a video, wait for completion, and schedule it to multiple platforms.
 *
 * Run: npx tsx examples/sdk/01-generate-and-schedule.ts
 * Requires: @socialneuron/sdk, SOCIALNEURON_API_KEY env var
 */

import { SocialNeuron } from "@socialneuron/sdk";

const sn = new SocialNeuron({
  apiKey: process.env.SOCIALNEURON_API_KEY!,
});

// 1. Generate a video
console.log("Generating video...");
const video = await sn.content.generateVideo({
  prompt: "A timelapse of a sunrise over mountains with fog",
  model: "veo3-fast",
  aspect_ratio: "9:16",
});

// 2. Wait for completion (polls automatically with exponential backoff)
console.log(`Job ${video.data.taskId} started, waiting...`);
const result = await sn.jobs.waitForCompletion(video.data.taskId);
console.log("Video ready:", result.data.resultUrl);

// 3. Schedule to platforms
const post = await sn.posts.schedule({
  media_url: result.data.resultUrl!,
  caption: "Morning views #sunrise #nature #timelapse",
  title: "Sunrise Timelapse",
  platforms: ["youtube", "tiktok", "instagram"],
  scheduled_at: new Date(Date.now() + 3600_000).toISOString(), // 1 hour from now
});

console.log("Post scheduled:", post.data);
