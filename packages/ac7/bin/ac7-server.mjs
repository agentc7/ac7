#!/usr/bin/env node
// Thin re-entry to @ac7/server's bin entry so the binary gets
// linked on `npm install -g @ac7/ac7`. Imports the bin subpath
// explicitly (the package's root export is the library entry).
await import('@ac7/server/bin');
