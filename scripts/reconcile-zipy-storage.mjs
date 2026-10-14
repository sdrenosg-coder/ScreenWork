import fs from "node:fs";
import path from "node:path";
function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
for (const file of [...files("artifacts/api-server/src/imported"), "lib/zipy/src/web/public-guide.ts"]) {
  if (!file.endsWith(".ts")) continue;
  const text = fs.readFileSync(file, "utf8");
  let updated = text.replaceAll('from "@workspace/zipy/storage/objectStore"', 'from "@workspace/zipy/storage/routeStore"');
  if (file.endsWith("sources/file/route.ts")) {
    updated = updated.replace("import { getObjectStore, type ObjectStore }", "import { forWorkspace, type ObjectStore }")
      .replace("objectStore = getObjectStore();", "objectStore = await forWorkspace(workspaceId);")
      .replace("const storageKey = buildUploadStorageKey({", 'const storageKey = workspaceId + "/" + buildUploadStorageKey({');
  }
  fs.writeFileSync(file, updated);
}
