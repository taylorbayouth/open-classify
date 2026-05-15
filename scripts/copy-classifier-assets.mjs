#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const srcDir = join(process.cwd(), "src/classifiers");
const outDir = join(process.cwd(), "dist/src/classifiers");

if (!existsSync(srcDir)) process.exit(0);
mkdirSync(outDir, { recursive: true });

// Copy `_prompts/` (shared base markdown) and every classifier directory.
// Underscore-prefixed entries (like `_prompts/`) are shared assets, not
// classifiers, and the loader skips them at startup. Everything else is a
// classifier and must carry its `manifest.json` + `prompt.md`.
for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const fromDir = join(srcDir, entry.name);
  const toDir = join(outDir, entry.name);

  if (entry.name.startsWith("_")) {
    cpSync(fromDir, toDir, { recursive: true });
    continue;
  }

  mkdirSync(toDir, { recursive: true });
  for (const filename of ["manifest.json", "prompt.md"]) {
    const source = join(fromDir, filename);
    if (existsSync(source)) {
      cpSync(source, join(toDir, filename));
    }
  }
}

void statSync;
