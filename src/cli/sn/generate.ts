/**
 * CLI commands for content generation.
 *
 * sn generate --prompt <text> [--platform <name>] [--type <type>] [--tone <tone>]
 * sn video --prompt <text> [--model <model>] [--aspect-ratio <ratio>]
 * sn image --prompt <text> [--model <model>] [--aspect-ratio <ratio>]
 */

import { callEdgeFunction } from '../../lib/edge-function.js';
import { getDefaultUserId } from '../../lib/supabase.js';
import type { SnArgs } from './types.js';
import { emitSnResult } from './parse.js';

export async function handleGenerate(args: SnArgs, asJson: boolean): Promise<void> {
  const prompt = (args.prompt as string) ?? args._[0];
  if (!prompt) {
    console.error('Error: --prompt is required');
    console.error('Usage: sn generate --prompt "Write a TikTok script about..." [--platform tiktok] [--type script]');
    process.exit(1);
  }

  const userId = await getDefaultUserId();
  const { data, error } = await callEdgeFunction('social-neuron-ai', {
    type: (args.type as string) ?? 'generation',
    prompt,
    platform: args.platform as string,
    tone: args.tone as string,
    userId,
  });

  if (error) {
    if (asJson) {
      emitSnResult({ ok: false, error }, asJson);
    } else {
      console.error(`Error: ${error}`);
    }
    process.exit(1);
  }

  if (asJson) {
    emitSnResult({ ok: true, content: data }, asJson);
  } else {
    const text = typeof data === 'object' && data !== null && 'text' in data
      ? (data as { text: string }).text
      : JSON.stringify(data, null, 2);
    process.stdout.write(text + '\n');
  }
}

export async function handleVideo(args: SnArgs, asJson: boolean): Promise<void> {
  const prompt = (args.prompt as string) ?? args._[0];
  if (!prompt) {
    console.error('Error: --prompt is required');
    console.error('Usage: sn video --prompt "A timelapse of..." [--model veo3-fast] [--aspect-ratio 16:9]');
    process.exit(1);
  }

  const userId = await getDefaultUserId();
  const { data, error } = await callEdgeFunction('kie-video-generate', {
    prompt,
    model: (args.model as string) ?? 'veo3-fast',
    aspectRatio: (args['aspect-ratio'] as string) ?? '16:9',
    duration: args.duration ? parseInt(args.duration as string, 10) : 5,
    userId,
  });

  if (error) {
    if (asJson) {
      emitSnResult({ ok: false, error }, asJson);
    } else {
      console.error(`Error: ${error}`);
    }
    process.exit(1);
  }

  const result = data as Record<string, unknown>;
  const jobId = result?.asyncJobId ?? result?.taskId;

  if (asJson) {
    emitSnResult({ ok: true, jobId, ...result }, asJson);
  } else {
    console.log(`Video generation started.`);
    console.log(`Job ID: ${jobId}`);
    console.log(`Model: ${result?.model ?? args.model ?? 'veo3-fast'}`);
    if (result?.creditsDeducted) console.log(`Credits: ${result.creditsDeducted}`);
    console.log(`\nPoll status: sn status --job-id ${jobId}`);
  }
}

export async function handleImage(args: SnArgs, asJson: boolean): Promise<void> {
  const prompt = (args.prompt as string) ?? args._[0];
  if (!prompt) {
    console.error('Error: --prompt is required');
    console.error('Usage: sn image --prompt "A mountain landscape..." [--model flux-pro] [--aspect-ratio 1:1]');
    process.exit(1);
  }

  const userId = await getDefaultUserId();
  const { data, error } = await callEdgeFunction('kie-image-generate', {
    prompt,
    model: (args.model as string) ?? 'flux-pro',
    aspectRatio: (args['aspect-ratio'] as string) ?? '1:1',
    style: args.style as string,
    negativePrompt: args['negative-prompt'] as string,
    userId,
  });

  if (error) {
    if (asJson) {
      emitSnResult({ ok: false, error }, asJson);
    } else {
      console.error(`Error: ${error}`);
    }
    process.exit(1);
  }

  const result = data as Record<string, unknown>;
  const jobId = result?.asyncJobId ?? result?.taskId;

  if (asJson) {
    emitSnResult({ ok: true, jobId, ...result }, asJson);
  } else {
    console.log(`Image generation started.`);
    console.log(`Job ID: ${jobId}`);
    console.log(`Model: ${result?.model ?? args.model ?? 'flux-pro'}`);
    console.log(`\nPoll status: sn status --job-id ${jobId}`);
  }
}
