const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  diagnoseDeploySsh,
  filterSshAuthTrace,
  parseArgs,
  renderDiagnosis,
  summarizeSshAgent
} = require("../scripts/diagnose-deploy-ssh.js");

test("filterSshAuthTrace keeps only authentication evidence", () => {
  const filtered = filterSshAuthTrace([
    "debug1: Local version string SSH-2.0",
    "debug1: identity file /Users/jung/.ssh/id_ed25519 type 3",
    "debug1: Offering public key: /Users/jung/.ssh/id_ed25519 ED25519 SHA256:test agent",
    "debug3: send packet: type 50",
    "debug1: Authentications that can continue: publickey,password",
    "root@example.com: Permission denied (publickey,password)."
  ].join("\n"));
  assert.match(filtered, /identity file/);
  assert.match(filtered, /Offering public key/);
  assert.match(filtered, /Authentications that can continue/);
  assert.match(filtered, /Permission denied/);
  assert.doesNotMatch(filtered, /send packet/);
  assert.doesNotMatch(filtered, /Local version string/);
});

test("summarizeSshAgent reports loaded and empty identities without private keys", () => {
  assert.equal(
    summarizeSshAgent("256 SHA256:abc claude-code (ED25519)\n", true),
    "ssh-agent identities: 1 loaded\n256 SHA256:abc claude-code (ED25519)"
  );
  assert.equal(
    summarizeSshAgent("The agent has no identities.\n", false),
    "ssh-agent identities: none loaded"
  );
  assert.doesNotMatch(summarizeSshAgent("256 SHA256:abc claude-code (ED25519)\n", true), /PRIVATE KEY/);
});

test("parseArgs accepts remote and timeout", () => {
  assert.deepEqual(parseArgs(["deploy@example.com", "--timeout", "4"]), {
    help: false,
    remote: "deploy@example.com",
    timeoutSeconds: 4
  });
  assert.throws(() => parseArgs(["--timeout", "0"]), /positive/);
});

test("diagnoseDeploySsh runs BatchMode verbose ssh and renders actionable failure", async () => {
  const calls = [];
  const result = await diagnoseDeploySsh({
    remote: "root@example.com",
    timeoutSeconds: 3,
    runCommandImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "ssh-add") {
        return { ok: true, code: 0, stdout: "256 SHA256:abc claude-code (ED25519)\n", stderr: "" };
      }
      return {
        ok: false,
        code: 255,
        stdout: "",
        stderr: [
          "debug1: identity file /Users/jung/.ssh/id_ed25519 type 3",
          "debug1: Offering public key: /Users/jung/.ssh/id_ed25519 ED25519 SHA256:abc agent",
          "debug1: Authentications that can continue: publickey,password",
          "debug1: No more authentication methods to try.",
          "root@example.com: Permission denied (publickey,password)."
        ].join("\n")
      };
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 255);
  assert.match(result.trace, /Offering public key/);
  assert.match(result.trace, /Permission denied/);
  assert.deepEqual(calls[1].args, [
    "-vvv",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=3",
    "root@example.com",
    "true"
  ]);
  const rendered = renderDiagnosis(result);
  assert.match(rendered, /Mia Cloud SSH deploy diagnosis/);
  assert.match(rendered, /fix VPS authorized_keys or sshd policy/);
  assert.doesNotMatch(rendered, /PRIVATE KEY|BEGIN OPENSSH PRIVATE KEY/);
});
