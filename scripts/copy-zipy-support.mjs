// Preserve imported worker, tests and operations notes without rerunning the port.
import fs from "node:fs";
import path from "node:path";
fs.mkdirSync("scripts/src/zipy-worker", { recursive: true });
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
for (const source of files(".migration-backup/apps/worker/src")) {
  const file = path.relative(".migration-backup/apps/worker/src", source);
  const text = fs.readFileSync(source, "utf8")
    .replace(/@zipy\/([^/"']+)(?=["'])/g, "@workspace/zipy/$1/index")
    .replaceAll("@zipy/", "@workspace/zipy/");
  const destination = `scripts/src/zipy-worker/${file}`;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, text);
}
fs.cpSync(".migration-backup/tests", "scripts/imported-tests", { recursive: true });
fs.cpSync(".migration-backup/docs", "docs/imported", { recursive: true });
