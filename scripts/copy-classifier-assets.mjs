#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const srcDir = join(process.cwd(), "src/classifiers");
const outDir = join(process.cwd(), "dist/src/classifiers");

if (!existsSync(srcDir)) process.exit(0);
mkdirSync(outDir, { recursive: true });

for (const entry of readdirSync(srcDir)) {
  const classifierDir = join(srcDir, entry);
  if (!statSync(classifierDir).isDirectory()) continue;
  const outClassifierDir = join(outDir, entry);
  mkdirSync(outClassifierDir, { recursive: true });
  for (const filename of ["manifest.json", "prompt.md", "output.schema.json"]) {
    const source = join(classifierDir, filename);
    if (existsSync(source)) {
      cpSync(source, join(outClassifierDir, filename));
    }
  }
}
