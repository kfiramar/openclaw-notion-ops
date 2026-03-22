#!/usr/bin/env node

import { runBoardMirrorSync } from "./notion.mjs";

try {
  runBoardMirrorSync();
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
