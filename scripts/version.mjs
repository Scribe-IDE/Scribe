#!/usr/bin/env node
// Sets the app's version everywhere it is written: package.json, tauri.conf.json, Cargo.toml and
// Cargo.lock. Then add the version's section to CHANGELOG.md, commit, and tag it vX.Y.Z.
//
//   node scripts/version.mjs 0.2.0
import fs from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? "")) {
  console.error("Usage: node scripts/version.mjs 0.2.0");
  process.exit(1);
}
const edit = (file, fn) => fs.writeFileSync(file, fn(fs.readFileSync(file, "utf8")));
edit("package.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("package-lock.json", (s) => s.replace(/("name": "scribe",\s*"version": )"[^"]+"/g, `$1"${version}"`));
edit("src-tauri/tauri.conf.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${version}"`));
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = "[^"]+"/m, `version = "${version}"`));
edit("src-tauri/Cargo.lock", (s) => s.replace(/(name = "scribe"\nversion = )"[^"]+"/, `$1"${version}"`));
const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
console.log(`Version ${version} set.`);
if (!new RegExp(`^## ${version.replace(/\./g, "\\.")}\\b`, "m").test(changelog)) console.log(`CHANGELOG.md has no "## ${version}" section yet: the release notes come from it.`);
console.log(`Then: git commit -am "Version ${version}" && git tag v${version} && git push && git push origin v${version}`);
