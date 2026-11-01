#!/usr/bin/env node
// The command: `zeenly-os` starts the pages and the scheduler; see
// src/cli/index.ts for the subcommands. tsx runs the TypeScript source, so
// the repository and the published package share one entry point.
import { register } from "tsx/esm/api";

register();
await import("../src/cli/index.ts");
