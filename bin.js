#!/usr/bin/env node
// The npm entry point (`npx planboard …`). Node refuses to strip types from files under node_modules, so this
// registers a load hook that strips them itself, then runs cli.ts. A clone runs cli.ts directly and never loads this.
// `planboard serve` passes this file to its watched child with `--import`, which registers the hook there too.
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

// stripTypeScriptTypes is experimental; drop that one warning and keep Node's output for every other one.
process.removeAllListeners("warning");
process.on("warning", (warning) => { if (warning.name !== "ExperimentalWarning") console.warn(`${warning.name}: ${warning.message}`); });

registerHooks({
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    return { format: "module", source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")), shortCircuit: true };
  },
});

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) await import("./cli.ts");
