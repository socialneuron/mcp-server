---
name: social-neuron
description: Use when the user asks to post, publish, schedule, write, plan, or analyse social media content, or mentions Instagram, TikTok, LinkedIn, X, YouTube, Facebook, a caption, carousel, reel, image or video generation, a content plan, brand voice, connected accounts, post analytics, credits, a generation job id, an expired media or download link, connecting an account, a plan limit, or an interactive content calendar or analytics view.
---

# Social Neuron

These tools act on a real brand's public social accounts and spend real credits. Every request
follows the same shape: **ground → act → hand back**.

## 1. Ground before you produce

| The request involves… | Call first | Then |
|---|---|---|
| Writing any copy — caption, post, hook, script, carousel text | `get_brand_profile` (or `get_brand_runtime`) | Write in that voice: its tone, spelling, and blocked terms |
| Any named platform — post, schedule, plan, "can I post to…" | `list_connected_accounts` | Name every platform that is not `active` and what the user must do |
| Anything that spends credits — image, video, carousel imagery, voiceover | `get_credit_balance` | Say the likely cost when it is a large share of the balance |
| "What worked / what should I post next" | `fetch_analytics` or `get_performance_insights` | Keep observed results separate from recommendations |

If the requested account is missing or expired, discover `start_platform_connection` by its exact
name using the host tool search if it is not visible, then call it for that platform and project.
Share its returned URL and use `wait_for_connection` briefly. Starting a connection requires
distribution permission; if unavailable, give the supported Settings connection path instead. A URL is not proof of connection;
refresh `list_connected_accounts` before publishing. While waiting, prepare useful draft text
without paid media or publishing. If multiple projects/accounts match, ask which one to use.

## 2. Publishing needs approval of the exact post

`schedule_post`, `schedule_content_plan` and `reschedule_post` have no confirmation field — the
check is yours. This also applies to publishing through recipes, pipelines, or app actions.

- **A request to post is not approval** — "post this now", "publish this to LinkedIn", "schedule
  this for 9am", even with the exact text included. Reply with the preview — account, exact text,
  media, time — and ask. Do not call a publishing tool in that turn.
- **Approval** is either of these — then check the connection and publish once, without asking
  again:
  - the user confirms a preview you showed ("yes", "go ahead", "publish it"), or
  - the user's message states they have reviewed the exact post and confirms it ("confirmed",
    "I've reviewed it", "this is my go-ahead") alongside the exact text. This counts even as the
    first message of a conversation.

"They said *now*" and "the text is already final" are not approval — preview first. "No preview has
passed between us yet" is not a reason to ask again when the user has stated they reviewed it.
- The user wants to review a plan → `plan_content_week` saves it and returns `plan_id`; pass that
  `plan_id` to `submit_content_plan_for_approval`. Never schedule it.

Approval binds to the exact account, text, media and time. A change to any of these needs a new
preview and approval. Preserve the approved text verbatim.

Receipt after publishing = the status the tool returned (`accepted`, `queued`, `scheduled`) + the
post id + anything still pending. `accepted` means accepted for processing, not live. Say "live"
only after `list_recent_posts` confirms publication. If a publishing response times out, report
the outcome as unknown and reconcile through a read. An empty or inconclusive recent-posts
result does not prove the first attempt failed: stop and hand back the uncertainty; do not
submit again in that turn. Any later authorized retry must preserve the complete original
payload and idempotency key, including leaving the key omitted if originally omitted. Adding
a new key after a timeout can create a duplicate. Carry these rules into any delegated task.

## 3. Carousels: text first

`generate_carousel` returns slide text only — use it by default and show the slides for review.
`create_carousel` also generates slide images and spends credits. Use it only after the user
approves the text, and call it so the text is composited rather than baked into the image: pass
`template_pack_id: "sn_signal_carousel_v1"`, no `template_id`, and any `image_model` except
`midjourney`. Those inputs alone do not prove composite rendering is enabled on the hosted
server. Inspect the returned slides and treat text fidelity as unverified until reviewed.

## 4. Async jobs: start once, poll briefly, hand back

`generate_*`, `create_carousel` and `render_*` return a `job_id`. Call `check_status` at most twice.
Still `queued` or `processing` → stop, and tell the user the job id, the expected wait, and that you
can check again. Never start a second job for the same request.

Expired or lost media link → `get_media_url` with the `job_id` (or `r2_key`) the user gave you or a
tool returned. Never regenerate or re-upload existing media.

## 5. When a tool errors

Read `error_type` and `hint`. Correct invalid inputs before retrying validation errors; stop
on credit or entitlement limits. For uncertain publishing outcomes use the timeout rule above:
changing a key or payload to obtain a success response can duplicate the original action.

## 6. Learn, handle limits, and use interactive views

For the next content decision, cite the observed analytics period and result that supports your
recommendation. Empty or stale analytics means there is no proven winner: propose a small
measurable experiment. Claim a measurement or learning task is scheduled only if a tool confirms it.

On an entitlement or credit limit, explain the returned limit once, offer a draft or lower-cost
path, and share an upgrade link only when the tool returns one. Do not retry the same spend,
change the subscription, or claim an upgrade completed.

When the user requests an interactive calendar or analytics view, select the matching available
app tool. Tool selection does not prove the UI rendered. If unsupported, use read tools for a
grounded text fallback; retain the same approval rules for any subsequent write.
