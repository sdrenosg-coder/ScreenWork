/**
 * The imported schema, for development setup only.
 * No startup/publish migration hooks: Replit Publish manages production schema.
 */
import { CREATE_USERS_SQL } from "@workspace/zipy/db/schema/users";
import { CREATE_WORKSPACES_SQL } from "@workspace/zipy/db/schema/workspaces";
import { CREATE_JOBS_SQL } from "@workspace/zipy/jobs/queue";
import { CREATE_SOURCES_SQL } from "@workspace/zipy/db/schema/sources";
import { CREATE_ARTIFACTS_SQL } from "@workspace/zipy/db/schema/artifacts";
import { CREATE_CANONICAL_ITEMS_SQL } from "@workspace/zipy/db/schema/canonicalItems";

export const importedSchema = [
  CREATE_USERS_SQL, CREATE_WORKSPACES_SQL, CREATE_JOBS_SQL,
  CREATE_SOURCES_SQL, CREATE_ARTIFACTS_SQL, CREATE_CANONICAL_ITEMS_SQL,
].join("\n");

if (process.argv.includes("--print")) process.stdout.write(importedSchema);
