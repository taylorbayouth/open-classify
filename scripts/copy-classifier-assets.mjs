#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const srcDir = join(process.cwd(), "src/classifiers");
const outDir = join(process.cwd(), "dist/src/classifiers");

if (!existsSync(srcDir)) process.exit(0);
mkdirSync(outDir, { recursive: true });

for (const kind of readdirSync(srcDir)) {
  const kindSrc = join(srcDir, kind);
  if (!statSync(kindSrc).isDirectory()) continue;
  const kindOut = join(outDir, kind);
  mkdirSync(kindOut, { recursive: true });
  const promptsDir = join(kindSrc, "prompts");
  if (existsSync(promptsDir)) {
    cpSync(promptsDir, join(kindOut, "prompts"), { recursive: true });
  }
  for (const entry of readdirSync(kindSrc)) {
    if (entry === "prompts") continue;
    const classifierDir = join(kindSrc, entry);
    if (!statSync(classifierDir).isDirectory()) continue;
    const outClassifierDir = join(kindOut, entry);
    mkdirSync(outClassifierDir, { recursive: true });
    for (const filename of ["manifest.json", "prompt.md", "output.schema.json"]) {
      const source = join(classifierDir, filename);
      if (existsSync(source)) {
        cpSync(source, join(outClassifierDir, filename));
      }
    }
  }
}
