#!/usr/bin/env node

import { runCronSmoke } from "./smoke-cron-job.mjs";

console.log(JSON.stringify(runCronSmoke({ name: "Weekly overview with OpenClaw" }), null, 2));
