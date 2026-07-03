# Cloud Claude Code Sandbox Plan

Date: 2026-07-02

## Decision

Mia Cloud Agent no longer defaults to a long-lived per-user Hermes gateway/container. The new default runtime kind is `cloud-claude-code`:

- Mia keeps the existing control plane: accounts, bots, conversations, tasks, run records, attachments, events, and billing stores.
- Claude Code is used as the agent execution shell through `@anthropic-ai/claude-agent-sdk`.
- DeepSeek is used as the Anthropic-compatible model endpoint via `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`.
- Every active run gets a short-lived working directory under `MIA_CLOUD_AGENT_ROOT`, plus Claude Code sandbox settings. The first implementation uses the SDK sandbox path; the provider boundary can later move execution to E2B, Daytona, or Kubernetes without changing the Mia conversation layer.

## References

- DeepSeek Anthropic API: https://api-docs.deepseek.com/guides/anthropic_api
- DeepSeek Claude Code integration: https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code
- Anthropic Claude Code sandboxing overview: https://www.anthropic.com/engineering/claude-code-sandboxing
- Anthropic experimental Sandbox Runtime: https://github.com/anthropic-experimental/sandbox-runtime
- E2B Claude Code sandbox guide: https://e2b.dev/docs/agents/claude-code
- Daytona sandbox runtime: https://github.com/daytonaio/daytona

## Runtime Shape

Cloud server bootstrap:

1. `MIA_CLOUD_AGENT_MODE=disabled` keeps cloud agent off.
2. Any non-disabled mode defaults to `createCloudClaudeCodeSandboxManager` and `createCloudClaudeCodeClient`.
3. Legacy Hermes modes remain opt-in for migration only: `static`, `docker`, or `hermes:*`.

Model flow:

1. UI/API runtime config stores the Mia-facing model value such as `mia-auto`.
2. Dispatcher maps `mia-auto` to the Claude Code model name at call time.
3. Claude Code sends Anthropic-format requests to DeepSeek.

Run isolation:

1. Per-user directories: `home`, `workspace`, `attachments`, `logs`.
2. Claude config is isolated with `HOME` and `CLAUDE_CONFIG_DIR`.
3. Claude Code SDK sandbox is enabled by default and required by default.
4. Valid cloud run ids are prefixed: `cc:<id>` for Claude Code, `gw:<id>` for legacy Hermes.

## Required Server Config

```bash
MIA_CLOUD_AGENT_MODE=claude-code
MIA_DEEPSEEK_API_KEY=...
MIA_CLOUD_AGENT_ROOT=/opt/mia-cloud/agent-runs
MIA_CLOUD_CLAUDE_CODE_SANDBOX=1
MIA_CLOUD_CLAUDE_CODE_SANDBOX_REQUIRED=1
```

Linux hosts need the sandbox dependencies expected by Claude Code SDK. If those dependencies are missing and `MIA_CLOUD_CLAUDE_CODE_SANDBOX_REQUIRED` is not disabled, runs fail rather than silently executing unsandboxed.

## Follow-Up Options

- Stronger isolation: implement the same `agentClient` boundary using E2B or Daytona sandbox SDKs.
- Cloud billing: keep runtime config as `mia-auto`, and meter DeepSeek usage through the model gateway once an Anthropic-format internal proxy is added.
- Schema cleanup: rename `cloud_agent_runs.hermes_run_id` to `runtime_run_id` in a later migration.
- Legacy removal: remove Hermes gateway files from the cloud release once no deployment uses `MIA_CLOUD_AGENT_MODE=static/docker/hermes:*`.
