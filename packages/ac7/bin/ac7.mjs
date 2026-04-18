#!/usr/bin/env node
// Thin re-entry to @ac7/cli so the bin gets linked on
// `npm install -g @ac7/ac7`. npm only links bins declared on the
// top-level package being installed, not on its transitive deps, so a
// meta-package without its own `bin` entries wouldn't expose anything.
await import('@ac7/cli');
