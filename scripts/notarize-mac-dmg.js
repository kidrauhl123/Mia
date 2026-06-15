const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const productName = pkg.productName || pkg.build?.productName || "Mia";
const version = pkg.version || "0.0.0";
const releaseDir = path.join(root, "release");
const profile = String(process.env.MIA_NOTARY_PROFILE || "mia").trim();
const inputs = process.argv.slice(2).filter(Boolean);
const targets = inputs.length > 0 ? inputs : ["Apple-Silicon"];

if (process.platform !== "darwin") {
  throw new Error("notarize-mac-dmg.js only runs on macOS.");
}

if (!profile) {
  throw new Error("Set MIA_NOTARY_PROFILE to a notarytool keychain profile name.");
}

function displayArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function run(command, args) {
  console.log(`$ ${command} ${args.map(displayArg).join(" ")}`);
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

function resolveDmg(input) {
  if (/\.dmg$/i.test(input)) return path.resolve(root, input);
  return path.join(releaseDir, `${productName}-${version}-${input}.dmg`);
}

for (const input of targets) {
  const dmg = resolveDmg(input);
  if (!fs.existsSync(dmg)) {
    throw new Error(`Missing DMG: ${path.relative(root, dmg)}`);
  }

  run("xcrun", ["notarytool", "submit", dmg, "--keychain-profile", profile, "--wait"]);
  run("xcrun", ["stapler", "staple", dmg]);
  run("xcrun", ["stapler", "validate", dmg]);
  run("spctl", ["--assess", "-vvv", "--type", "install", dmg]);
}
