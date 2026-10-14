// Preserve pre-existing incomplete contracts without preventing server startup.
// Missing implementations fail explicitly if that imported feature is called.
import fs from "node:fs";
const changes = {
  "artifacts/api-server/src/imported/analytics/events/route.ts": {
    "@workspace/zipy/analytics/guideMetrics": ["aggregateGuideMetrics"],
    "@workspace/zipy/analytics/dropoff": ["aggregateDropoff"],
    "@workspace/zipy/analytics/searchAnalytics": ["aggregateSearchAnalytics"],
    "@workspace/zipy/analytics/feedback": ["aggregateFeedback"],
    "@workspace/zipy/analytics/teamMetrics": ["aggregateTeamMetrics"],
  },
  "artifacts/api-server/src/imported/billing/usage/route.ts": {
    "@workspace/zipy/billing/plans": ["resolvePlan", "planCatalog"],
    "@workspace/zipy/billing/metering": ["readUsageSnapshot"],
    "@workspace/zipy/billing/referrals": ["readReferralSummary"],
  },
  "artifacts/api-server/src/imported/guides/[id]/export/route.ts": {
    "@workspace/zipy/export/index": ["renderGuideDocx", "renderGuideImagePack"],
  },
  "artifacts/api-server/src/imported/screenshots/[id]/redact/route.ts": {
    "@workspace/zipy/images/piiDetect": ["detectPiiRegionsFromBytes"],
    "@workspace/zipy/images/redact": ["redactImage"],
  },
  "artifacts/api-server/src/imported/v1/guides/route.ts": {
    "@workspace/zipy/templates/library": ["tryGetTemplate"],
  },
};
for (const [file, modules] of Object.entries(changes)) {
  let text = fs.readFileSync(file, "utf8");
  let additions = '\nimport { requireImportedFunction } from "@/lib/import-contract";\n';
  let count = 0;
  for (const [module, missing] of Object.entries(modules)) {
    const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`import \\{([^}]+)\\} from "${escaped}";`);
    const match = pattern.exec(text);
    if (!match) continue;
    const retained = match[1].split(",").map(x => x.trim()).filter(x => x && !missing.includes(x));
    const namespace = `importedContract${count++}`;
    text = text.replace(pattern,
      `${retained.length ? `import { ${retained.join(", ")} } from "${module}";\n` : ""}import * as ${namespace} from "${module}";`);
    for (const name of missing) {
      if (name === "planCatalog") {
        additions += `const planCatalog = (${namespace} as unknown as Record<string, any>).planCatalog;\n`;
      } else {
        additions += `const ${name} = requireImportedFunction(${namespace}, "${name}", "${module}");\n`;
      }
    }
  }
  fs.writeFileSync(file, text + additions);
}
