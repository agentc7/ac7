#!/usr/bin/env node
// Thin re-entry to @agentc7/server's bin entry so the binary gets
// linked on `npm install -g @agentc7/ac7`. Imports the bin subpath
// explicitly (the package's root export is the library entry).
await import('@agentc7/server/bin');
