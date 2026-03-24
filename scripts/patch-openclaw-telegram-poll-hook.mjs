#!/usr/bin/env node

import fs from "node:fs";

const explicitTarget = process.env.OPENCLAW_TELEGRAM_RUNTIME || "";
const targets = explicitTarget
  ? [explicitTarget]
  : [
      "/docker/openclaw-pma3/data/.npm-global/lib/node_modules/openclaw/dist/auth-profiles-DDVivXkv.js",
      "/docker/openclaw-pma3/data/.npm-global/lib/node_modules/openclaw/dist/auth-profiles-DRjqKE3G.js",
      "/docker/openclaw-pma3/data/.npm-global/lib/node_modules/openclaw/dist/reply-Bm8VrLQh.js",
      "/docker/openclaw-pma3/data/.npm-global/lib/node_modules/openclaw/dist/model-selection-CU2b7bN6.js",
      "/docker/openclaw-pma3/data/.npm-global/lib/node_modules/openclaw/dist/model-selection-46xMp11W.js",
      "/docker/openclaw-pma3/data/.npm-global/lib/node_modules/openclaw/dist/discord-CcCLMjHw.js"
    ];

const marker = 'bot.use(async (ctx, next) => {\n\t\ttry {\n\t\t\tconst answer = ctx.update?.poll_answer;';
const needle = 'bot.on("message", async (ctx) => {';
const injection = `bot.use(async (ctx, next) => {
\t\ttry {
\t\t\tconst answer = ctx.update?.poll_answer;
\t\t\tif (answer?.poll_id) {
\t\t\tconst accountKey = accountId ?? "default";
\t\t\tconst filePath = \`/data/.openclaw/telegram/poll-answers-\${accountKey}.jsonl\`;
\t\t\tconst row = {
\t\t\t\trecorded_at: new Date().toISOString(),
\t\t\t\taccount_id: accountKey,
\t\t\t\tpoll_id: answer.poll_id,
\t\t\t\tuser_id: answer.user?.id != null ? String(answer.user.id) : null,
\t\t\t\toption_ids: Array.isArray(answer.option_ids) ? answer.option_ids : [],
\t\t\t\tupdate_id: ctx.update?.update_id ?? null
\t\t\t};
\t\t\tawait fs$1.mkdir("/data/.openclaw/telegram", { recursive: true });
\t\t\tawait fs$1.appendFile(filePath, \`\${JSON.stringify(row)}\\n\`);
\t\t\t}
\t\t} catch (err) {
\t\t\truntime.error?.(danger(\`[telegram] poll_answer handler failed: \${String(err)}\`));
\t\t}
\t\tawait next();
\t});
\t`;

const results = [];

for (const target of targets) {
  if (!fs.existsSync(target)) {
    results.push({ ok: false, target, reason: "missing" });
    continue;
  }

  const source = fs.readFileSync(target, "utf8");
  if (source.includes(marker)) {
    results.push({ ok: true, patched: false, reason: "already-patched", target });
    continue;
  }

  if (!source.includes(needle)) {
    results.push({ ok: false, target, reason: "needle-not-found" });
    continue;
  }

  const patched = source.replace(needle, `${injection}${needle}`);
  fs.writeFileSync(target, patched);
  results.push({ ok: true, patched: true, target });
}

console.log(JSON.stringify({ ok: true, results }, null, 2));
