#!/usr/bin/env node

import fs from "node:fs";

const target =
  process.env.OPENCLAW_TELEGRAM_RUNTIME ||
  "/docker/openclaw-pma3/data/.npm-global/lib/node_modules/openclaw/dist/auth-profiles-DDVivXkv.js";

const marker = 'bot.on("poll_answer", async (ctx) => {';
const needle = 'bot.on("message", async (ctx) => {';

if (!fs.existsSync(target)) {
  throw new Error(`runtime file not found: ${target}`);
}

const source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) {
  console.log(JSON.stringify({ ok: true, patched: false, reason: "already-patched", target }, null, 2));
  process.exit(0);
}

if (!source.includes(needle)) {
  throw new Error(`could not find injection point in ${target}`);
}

const injection = `bot.on("poll_answer", async (ctx) => {
\t\ttry {
\t\t\tif (shouldSkipUpdate(ctx)) return;
\t\t\tconst answer = ctx.update?.poll_answer;
\t\t\tif (!answer?.poll_id) return;
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
\t\t} catch (err) {
\t\t\truntime.error?.(danger(\`[telegram] poll_answer handler failed: \${String(err)}\`));
\t\t}
\t});
\t`;

const patched = source.replace(needle, `${injection}${needle}`);
fs.writeFileSync(target, patched);

console.log(JSON.stringify({ ok: true, patched: true, target }, null, 2));
