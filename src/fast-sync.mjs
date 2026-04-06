#!/usr/bin/env node

import { clearFastSyncPending, fastSyncPending, runBoardMirrorSync } from "./notion.mjs";

try {
  do {
    clearFastSyncPending();
    runBoardMirrorSync();
  } while (fastSyncPending());
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
