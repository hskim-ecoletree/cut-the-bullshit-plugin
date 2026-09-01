#!/usr/bin/env node

// Claude Code compatibility entry point. The host-neutral tally implementation
// lives in the distributable plugin and is shared with Codex.
await import("../plugins/cut-the-bullshit/scripts/tally.mjs");
