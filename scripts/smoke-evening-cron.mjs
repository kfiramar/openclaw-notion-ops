#!/usr/bin/env node

import { runCronSmoke } from "./smoke-cron-job.mjs";

console.log(JSON.stringify(runCronSmoke({ name: "Daily overview with OpenClaw" }), null, 2));
