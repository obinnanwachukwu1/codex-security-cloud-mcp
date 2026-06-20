# Codex Security Cloud MCP

MCP server for the Codex Security Cloud service exposed by ChatGPT/Codex Cloud.

The server assumes the user already has Codex installed and authenticated. It reads the existing Codex auth file and does not implement a separate login flow. By default it reads `~/.codex/auth.json`; set `CODEX_AUTH_JSON_PATH` only if your Codex auth file lives somewhere else. It never asks users to paste tokens.

## Install

Prerequisites:

- Node.js 20 or newer
- Codex installed and authenticated with `codex login`
- Access to Codex Security Cloud for the repositories you want to inspect

Install for Codex:

```bash
codex mcp add codex-security-cloud -- npx -y codex-security-cloud-mcp@latest
```

Manual Codex configuration:

```toml
[mcp_servers.codex-security-cloud]
command = "npx"
args = ["-y", "codex-security-cloud-mcp@latest"]
enabled = true
```

For other MCP clients, configure a stdio server command:

```bash
npx -y codex-security-cloud-mcp@latest
```

Quick smoke test after installing:

```text
Use the Codex Security Cloud MCP to list one open finding for my repositories.
```

## Safety

This MCP can read Codex Security Cloud findings, close/reopen findings, request site-side PRs, and apply generated patches to local git repositories. `apply_generated_patch` refuses staged changes, refuses touched files with local changes, runs `git apply --check` first, and creates a local commit for rollback if the patch applies.

## Tools

- `list_security_metadata`: lists accessible repos and author filters.
- `list_findings`: lists open or closed findings with repo, severity, patch, author, sort, cursor, and limit filters.
- `get_finding`: fetches normalized finding detail, including generated patch metadata when present.
- `close_finding`: closes a finding as `fixed`, `wontfix`, `duplicate`, or `false_positive`.
- `reopen_finding`: reopens a closed finding as `new`.
- `request_site_pr`: asks the cloud service to start its site-side patch/PR workflow, then briefly polls the finding for PR URL/state metadata.
- `apply_generated_patch`: applies an already-generated patch locally, commits it, and optionally closes the finding as fixed.

Use the `findingId` returned by `list_findings` for `get_finding`, close/reopen, PR, and patch tools. The MCP intentionally omits backend-only ids and raw payloads from normal responses.

`list_findings` is intentionally compact so an agent can choose what to inspect without loading every finding body. `get_finding` is also compact by default: it includes a derived `summary`, compact relevant-line locations, generated patch metadata, and site PR metadata. The summary is extracted from an explicit `Summary`/`Overview` section when present, otherwise from the first paragraph with a bounded length. Use `includeDescription: true` when an agent needs the exact full description from the endpoint. Use `includePatchDiff: true` only when an agent needs to inspect or manually repair the generated patch. Use `includeEvidence: true` only when an agent needs relevant-line source content, validation/fix reports, or attack-path evidence. `apply_generated_patch` fetches the generated diff internally, so applying a clean generated patch does not require loading the diff into model context.

`apply_generated_patch` fails before applying if the generated patch is missing, the repository has staged changes, the patch touches dirty files, or `git apply --check` fails. On failure it returns the phase, a compact finding reference, current HEAD, expected base commit, touched files, git stderr, and the suggested commit message so an agent can take over manually.

If `autoClose` is true, the close happens only after a successful local commit. The close reason uses neutral wording:

```text
An agent applied and committed the generated patch on <date time>.
Commit: <sha>
```

## Development

```bash
npm install
npm run build
node ./dist/server.js
```
