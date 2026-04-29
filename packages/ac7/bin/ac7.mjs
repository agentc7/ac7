#!/usr/bin/env node
// Thin re-entry to @agentc7/cli so the bin gets linked on
// `npm install -g @agentc7/ac7`. npm only links bins declared on the
// top-level package being installed, not on its transitive deps, so a
// meta-package without its own `bin` entries wouldn't expose anything.
await import('@agentc7/cli');
