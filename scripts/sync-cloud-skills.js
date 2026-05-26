#!/usr/bin/env node

// Sync the skills-catalog/ folder into a cloud `skills` table.
//
//   node scripts/sync-cloud-skills.js [--prune] [--dry-run]
//
// Target DB is chosen by MIA_CLOUD_DATA (defaults to ~/.mia-cloud). Run it
// where the cloud DB lives — locally, or on the VPS against the production
// data dir. Upsert preserves each skill's install_count; --prune removes
// catalog-absent skills; --dry-run prints the plan without writing.

const os = require("node:os");
const path = require("node:path");

function req(rel) {
  try {
    return require(`../src/cloud/${rel}`);
  } catch {
    return require(`./src/cloud/${rel}`);
  }
}
const { createCloudStore } = req("sqlite-store.js");
const { createSkillsStore } = req("skills-store.js");
const { loadSkillsCatalog, defaultCatalogDir } = req("skills-catalog.js");

function main() {
  const args = process.argv.slice(2);
  const prune = args.includes("--prune");
  const dryRun = args.includes("--dry-run");
  const dataDir = process.env.MIA_CLOUD_DATA || path.join(os.homedir(), ".mia-cloud");

  const catalog = loadSkillsCatalog();
  if (!catalog.length) {
    console.error(`[sync-cloud-skills] no skills found in ${defaultCatalogDir()}`);
    process.exit(1);
  }

  const store = createCloudStore({ dataDir });
  const skills = createSkillsStore(store.getDb());
  const existingIds = new Set(skills.listSkills({ limit: 1000 }).map((s) => s.id));
  const catalogIds = new Set(catalog.map((s) => s.id));

  let upserted = 0;
  for (const skill of catalog) {
    const verb = existingIds.has(skill.id) ? "update" : "add";
    console.log(`[sync-cloud-skills] ${dryRun ? "(dry-run) " : ""}${verb}: ${skill.id} [${skill.category}]`);
    if (!dryRun) skills.upsertSkill(skill);
    upserted += 1;
  }

  let pruned = 0;
  if (prune) {
    for (const id of existingIds) {
      if (catalogIds.has(id)) continue;
      console.log(`[sync-cloud-skills] ${dryRun ? "(dry-run) " : ""}remove: ${id}`);
      if (!dryRun) skills.deleteSkill(id);
      pruned += 1;
    }
  }

  console.log(
    `[sync-cloud-skills] done — ${upserted} upserted${prune ? `, ${pruned} pruned` : ""}` +
    `${dryRun ? " (dry-run, no writes)" : ""} → ${path.join(dataDir, "cloud.sqlite")}`
  );
}

main();
