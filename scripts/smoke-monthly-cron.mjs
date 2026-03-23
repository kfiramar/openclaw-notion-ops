#!/usr/bin/env node

import { runCronSmoke } from "./smoke-cron-job.mjs";

console.log(JSON.stringify(runCronSmoke({ name: "Lifestyle monthly review" }), null, 2));
