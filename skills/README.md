# Aimashi Skills

This directory contains Aimashi-owned official skills shown in the Aimashi skill library.

- `pet-generator/` is the general desktop pet generation skill source, adapted from the Codex `hatch-pet` workflow.
- Runtime pet generation outputs do not belong here. Generated prompts, logs, decoded images, QA media, and temporary manifests are written under the app runtime `pet-jobs/` directory.
- Installed pet packages do not belong here. Final `pet.json` and spritesheets are written under the app runtime `pets/` directory.

Packaged builds copy this directory to the app `Resources/skills` folder so external scripts can read the Python files and assets from normal filesystem paths.
