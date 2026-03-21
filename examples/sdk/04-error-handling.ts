/**
 * Demonstrates error handling and rate limit retry patterns.
 *
 * Run: npx tsx examples/sdk/04-error-handling.ts
 */

import { SocialNeuron, SocialNeuronError } from "@socialneuron/sdk";

const sn = new SocialNeuron({
  apiKey: process.env.SOCIALNEURON_API_KEY!,
});

async function generateWithRetry(prompt: string, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await sn.content.generate({
        prompt,
        platform: "tiktok",
        content_type: "script",
      });
    } catch (err) {
      if (err instanceof SocialNeuronError) {
        // Rate limited — wait and retry
        if (err.status === 429 && err.retryAfter && attempt < maxRetries) {
          console.log(`Rate limited. Waiting ${err.retryAfter}s (attempt ${attempt}/${maxRetries})`);
          await new Promise((r) => setTimeout(r, err.retryAfter! * 1000));
          continue;
        }

        // Scope error — cannot retry
        if (err.status === 403) {
          console.error(`Insufficient scope: ${err.message}`);
          throw err;
        }

        // Validation error
        if (err.status === 400) {
          console.error(`Bad request: ${err.message}`);
          throw err;
        }

        console.error(`API error (${err.status}): ${err.message}`);
      }
      throw err;
    }
  }
}

const result = await generateWithRetry("3 tips for better Instagram reels");
console.log("Generated:", result?.data);
