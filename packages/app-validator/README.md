# kepcup-app

`kepcup-app validate` checks a KepCup **connector manifest** (an MCP Registry `server.json` with the
`_meta["app.kepcup/connector"]` extension, see `docs/design/29-connected-apps.md` section 4) and the
remote MCP server it points at, the same way KepCup itself will connect to it. Run it before you submit
an app to the KepCup directory (design 29 section 11.5, step 2).

```sh
pnpm --filter @kepcup/app-validator build
node packages/app-validator/dist/cli.js validate ./server.json
# or, linked as a bin:  kepcup-app validate https://example.com/server.json --auth
```

## Usage

```
kepcup-app validate <server.json path | https URL | plugin directory | .kepcup file> [options]
kepcup-app init plugin <directory> [--id <id>] [--name <name>] [--force]
kepcup-app pack <directory> [--out <file>] [--json]
```

| Option | Meaning |
| --- | --- |
| `--auth` | Run one real interactive authorization with **KepCup's client identity** (the CIMD document `https://kepcup.com/oauth/client.json`; dynamic registration when the server has no CIMD support), then list and check the tools. Opens your browser; the token lives in memory only and is revoked at the end when the server has a revocation endpoint. |
| `--json` | Print the machine-readable report (below) on stdout instead of text. Progress goes to stderr and is silenced in this mode. |
| `--timeout <ms>` | Per-request timeout (default 10000; the privacy policy fetch never waits longer than 10 s). |
| `--no-browser` | With `--auth`: only print the authorization URL, do not try to open a browser. |

What happens without `--auth`:

- a server that answers unauthenticated requests (public / open) is fully checked, tools included;
- a server that requires authorization gets the reachability and OAuth discovery checks, and the
  authorization / tool checks are **skipped** (`auth.skipped`, an `info`). Re-run with `--auth`.

Plain `http://` is accepted only for loopback hosts (local development); everything else must be `https`.

When the target is a directory or ends with `.kepcup`, the validator switches to **plugin mode**
(see [Plugin mode](#plugin-mode)). The mode is decided from the target alone; `--auth` is ignored
there because plugin validation is fully offline.

Network safety (the CLI follows URLs a submission controls):

- A call that starts on a public URL (manifest, privacy policy) can follow redirects to other public hosts, but never to `localhost`, loopback or private-range IP literals. The remote MCP server and the OAuth metadata it advertises may use loopback only when the remote URL itself is loopback (local development). A public name that *resolves* to a private address is not caught: run the CLI on untrusted submissions in a network-isolated sandbox.
- With `--auth`, the authorization, token and registration endpoints are checked before any request: they must be `https` (loopback `http` only for a loopback server). A `file:`, `smb:`, `javascript:` or custom-protocol endpoint fails `auth.flow` and nothing is opened; the browser is only ever pointed at a validated web URL.
- Reports (text and `--json`) show URLs as origin + path only: query strings and credentials are removed.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No `error` findings (warnings and infos do not fail the run). |
| `1` | At least one `error` finding. |
| `2` | Usage error (bad arguments) or an internal failure of the tool itself. |

### JSON output

`--json` prints one object. `schemaVersion` changes only on breaking changes.

```jsonc
{
  "schemaVersion": 1,
  "mode": "connector",                 // "connector" | "plugin"
  "target": "./server.json",          // the argument as given
  "remote": "https://mcp.example.com/mcp", // probed MCP endpoint, or null
  "auth": false,                       // --auth was requested
  "summary": { "errors": 0, "warnings": 2, "infos": 21 },
  "exitCode": 0,                       // 0 | 1 (2 never appears in a report)
  "checks": [
    {
      "id": "tool.title",              // stable id, see the list below
      "severity": "warn",              // "error" | "warn" | "info"
      "message": "Tool has no title.",
      "hint": "Set a human-readable title ...", // absent for passing checks
      "doc": "tool-title",             // anchor in this README
      "subject": "get_issue",          // optional: the tool / UI resource concerned
      "details": { }                   // optional: extra facts (varies per id)
    }
  ]
}
```

Passing checks are reported as `info`, so the report shows what was verified.

## Plugin mode

A KepCup plugin is a declaration-only package: a `plugin.json` manifest plus skills,
connectors, MCP servers (embedded `.mcpb` or public https) and mail templates. `validate`
accepts either an unpacked development directory or a packed `.kepcup` archive and checks it
**without network access and without executing package code**. The package layer is the same
`@kepcup/package-guard` used by the installer.

```sh
kepcup-app init plugin ./my-plugin --id io.github.alice/my-plugin
kepcup-app validate ./my-plugin
kepcup-app pack ./my-plugin --out ./my-plugin.kepcup
kepcup-app validate ./my-plugin.kepcup
```

- `init plugin` writes `plugin.json`, `README.md` and one sample skill. It refuses a non-empty
  directory unless `--force` is given; the id defaults to `io.github.your-name/<directory name>`.
- `pack` collects the directory minus `.git/`, `node_modules/`, `.DS_Store`, `*.kepcup`,
  `.kepcup-ignore` and the paths listed in `.kepcup-ignore` (one relative path or `directory/`
  per line, `#` comments, no wildcards), builds the archive with sorted entries and fixed
  timestamps, and validates **the archive** through the same package-guard path the installer
  uses before writing it. Nothing is written when that validation reports an error, and the
  excluded trees may contain anything (symlinks, junk) — only what ships is judged. Packing the
  same directory twice yields the same sha256 (on the same Node / zlib version).
- `validate <directory>` checks the directory as-is, with the same rules as KepCup's "install
  from folder" (no exclusions, symlinks rejected). For a development checkout with
  `node_modules`, validate the `pack` output instead.
- `--json` prints the same report object as connector mode, with `"mode": "plugin"`.

The full developer guide is [docs/guides/write-a-plugin.md](../../docs/guides/write-a-plugin.md).

## Running in CI

```sh
pnpm --filter @kepcup/app-validator build
node packages/app-validator/dist/cli.js validate server.json --json > report.json   # exit 1 fails the job
```

- Without `--auth` the run is non-interactive and fine for CI (open servers are fully checked; servers
  that need OAuth get discovery checks only). `--auth` needs a person at a browser: run it locally.
- Treat `report.json` as the artifact; fail on `exitCode !== 0`, and surface `warn` findings as annotations.
- The validator fetches whatever URLs the manifest names (remote, privacy policy). When you run it on
  submissions you do not control, run it in a network-isolated sandbox.

## Checks

Every finding has a stable id. Severity is the highest the check produces; the message says which
applies. Anchors below match each finding's `doc` field.

### Manifest (`server.json`)

- <a id="manifest-load"></a>`manifest.load` (error): the file / URL could not be read (or answered non-200).
- <a id="manifest-json"></a>`manifest.json` (error): not valid JSON / not a JSON object.
- <a id="manifest-schema"></a>`manifest.schema`: valid `server.json` subset (`name` as `namespace/name`, `title`, `description`, `version`, `remotes[]`, ...). Error on violations, info when valid.
- <a id="manifest-meta-missing"></a>`manifest.meta-missing` (error): `_meta["app.kepcup/connector"]` is absent.
- <a id="manifest-meta"></a>`manifest.meta` (error): an unrecognised field of the extension is invalid.
- <a id="manifest-slug"></a>`manifest.slug`: 2-16 lower-case letters or digits, no underscore (tools appear as `app_{slug}_*`).
- <a id="manifest-icon"></a>`manifest.icon` (error): a plain file name ending in `.svg` or `.png`.
- <a id="manifest-category"></a>`manifest.category` (error): one of the known categories.
- <a id="manifest-tier"></a>`manifest.tier`: `builtin` is an error for third parties; `verified` / `developer` warn (assigned by review / local only); `community` is the submission tier.
- <a id="manifest-auth"></a>`manifest.auth`: `auth.kind` / `registration` / `clientRef` consistency (error); info when `kind` is not `oauth` (OAuth checks are skipped).
- <a id="manifest-tool-policy"></a>`manifest.tool-policy`: shape of `toolPolicy` (error); warning when it names tools the server does not list.
- <a id="manifest-skills"></a>`manifest.skills`: shape of the bundled skills list (error); info with the count. An entry is `{ name, source, description?, ref?, subdirectory? }`: `source` is an https git repository URL (the same sources `skills.import` accepts), `name` must equal the `name` in that skill's `SKILL.md`, and a repository with several skills needs `subdirectory`. After the user connects the app, KepCup offers to install the skills for the Bot through its normal skill-import approval card; nothing is installed without approval.
- <a id="manifest-ui"></a>`manifest.ui`: shape (error); warns when the `ui` flag disagrees with the tools that carry `_meta.ui.resourceUri`.
- <a id="manifest-whoami"></a>`manifest.whoami` (error): shape of the account-identification hint.
- <a id="manifest-release-gate"></a>`manifest.release-gate` (info): `releaseGate` is assigned by KepCup during review; a placeholder was used.
- <a id="manifest-remote"></a>`manifest.remote`: needs a `streamable-http` remote over https (error otherwise); plaintext loopback and leftover `sse` entries warn; a package-only (MCPB) entry skips remote checks.
- <a id="manifest-privacy-policy"></a>`manifest.privacy-policy`: https URL, reachable within 10 s, non-empty. Unreachable / empty / non-https is an error; a nearly empty page warns.

### Remote server and OAuth discovery

- <a id="remote-reachable"></a>`remote.reachable`: the endpoint answers a POST `initialize` (error when it does not, or answers something other than 401 / 2xx).
- <a id="remote-tls"></a>`remote.tls` (error): the TLS handshake failed (expired / untrusted / wrong-host certificate).
- <a id="remote-challenge"></a>`remote.challenge`: unauthenticated requests get `401` with a `WWW-Authenticate: Bearer` challenge (error otherwise); a challenge without `resource_metadata` warns (RFC 9728).
- <a id="remote-open"></a>`remote.open` (info): the server accepts unauthenticated requests, so OAuth checks are skipped.
- <a id="remote-prm"></a>`remote.prm` (error): protected resource metadata (RFC 9728) is published, its `resource` covers the MCP URL and it lists `authorization_servers`.
- <a id="remote-as-metadata"></a>`remote.as-metadata` (error): authorization server metadata (RFC 8414 / OIDC discovery) exists and its `issuer` matches.
- <a id="remote-endpoints-https"></a>`remote.endpoints-https` (error): all advertised OAuth endpoints use https.
- <a id="remote-pkce"></a>`remote.pkce` (error): `code_challenge_methods_supported` includes `S256`.
- <a id="remote-iss"></a>`remote.iss` (warn): `authorization_response_iss_parameter_supported` is true (RFC 9207).
- <a id="remote-client-registration"></a>`remote.client-registration`: the server supports **CIMD** (preferred; KepCup's id is `https://kepcup.com/oauth/client.json`) or **DCR** (error if neither, unless the manifest asks for a KepCup pre-registered client).
- <a id="remote-public-client"></a>`remote.public-client` (warn): `token_endpoint_auth_methods_supported` lacks `none` (KepCup is a public native client).
- <a id="remote-refresh-token"></a>`remote.refresh-token` (warn): the `refresh_token` grant is not advertised.
- <a id="remote-revocation"></a>`remote.revocation` (warn): no `revocation_endpoint` (disconnecting cannot invalidate tokens).

### Authorization (`--auth`)

- <a id="auth-skipped"></a>`auth.skipped` (info): authorization is required and `--auth` was not given.
- <a id="auth-cimd-document"></a>`auth.cimd-document`: KepCup's client identity document is reachable and self-consistent (error otherwise; this is KepCup infrastructure).
- <a id="auth-client"></a>`auth.client` (info): which client identity was used (CIMD or a dynamic registration).
- <a id="auth-callback-iss"></a>`auth.callback-iss`: the authorization response carries the right `iss` (error on mismatch, or when promised and missing; warning when not promised).
- <a id="auth-flow"></a>`auth.flow`: the interactive flow (PKCE S256, state, RFC 8707 resource, loopback callback with Host check, token exchange) completed (error with the reason otherwise).
- <a id="auth-token"></a>`auth.token`: a Bearer token with `expires_in` was issued (warnings otherwise).
- <a id="auth-refresh-token"></a>`auth.refresh-token` (warn): no refresh token was issued.
- <a id="auth-revoke"></a>`auth.revoke`: the validation token was revoked (warn when the endpoint failed).

### Tools

- <a id="tools-skipped"></a>`tools.skipped` (info): tool checks did not run (no usable endpoint, or authorization did not complete).
- <a id="mcp-session"></a>`mcp.session` (info): an MCP session was established.
- <a id="tools-list"></a>`tools.list`: `tools/list` works (error if it fails) and returns tools (warns if empty).
- <a id="tools-duplicate-name"></a>`tools.duplicate-name` (error): the same tool name is listed twice.
- <a id="tools-risk-summary"></a>`tools.risk-summary` (info): how KepCup's classifier sees the tools (`details.tools[]`: `name`, `risk`, `source`, short definition `hash`).
- <a id="tools-split"></a>`tools.split` (info): all-read, all-write or mixed server (a read tool set lets users allow reads without prompts).
- <a id="tool-title"></a>`tool.title` (warn): the tool has a `title` (or `annotations.title`).
- <a id="tool-description"></a>`tool.description` (warn): the tool has a description, at most 2000 characters.
- <a id="tool-input-schema"></a>`tool.input-schema` (error): `inputSchema` is a JSON Schema of type `object`.
- <a id="tool-annotations-missing"></a>`tool.annotations-missing` (warn): neither `readOnlyHint` nor `destructiveHint` is declared.
- <a id="tool-annotations-partial"></a>`tool.annotations-partial` (warn): a write-looking tool sets `destructiveHint` but not `readOnlyHint:false`.
- <a id="tool-write-unannotated"></a>`tool.write-unannotated` (error): the name says it writes (`create`, `update`, `delete`, `send`, ...) but there are no risk annotations at all.
- <a id="tool-readonly-claim"></a>`tool.readonly-claim` (error): `readOnlyHint:true` on a write-looking name (KepCup ignores the claim and treats the tool as destructive).
- <a id="tool-hints-contradict"></a>`tool.hints-contradict` (warn): `readOnlyHint` and `destructiveHint` are both true.
- <a id="tool-mixed-read-write"></a>`tool.mixed-read-write` (warn): a tool that reads and writes (`get_or_create_*`, `search_and_delete`), or whose description admits writing while `readOnlyHint:true`.
- <a id="tool-name-length"></a>`tool.name-length` (error): at most 64 characters.
- <a id="tool-name-chars"></a>`tool.name-chars`: only `[A-Za-z0-9_-]` (error for other characters, warning for `.`, which KepCup replaces with `_`).
- <a id="tool-name-prefixed"></a>`tool.name-prefixed` (warn): `app_{slug}_{name}` is over 50 characters, so KepCup exposes a truncated, hash-suffixed name.
- <a id="tool-name-collision"></a>`tool.name-collision` (warn): two names map to the same exposed name after sanitising.
- <a id="tool-injection-pattern"></a>`tool.injection-pattern` (warn): tool text (name, title, description, schema descriptions) contains patterns reviewers flag: `override-instructions`, `hidden-characters` (zero-width, bidi, Unicode tag characters), `closing-tag` (`</untrusted>`, role markers), `exfiltration`, `sensitive-path`, `url`. `details.findings[]` shows excerpts.

### MCP Apps (`_meta.ui.resourceUri`)

- <a id="ui-resource-uri"></a>`ui.resource-uri` (error): the URI is a `ui://` URI.
- <a id="ui-resource-missing"></a>`ui.resource-missing` (error): `resources/read` fails or returns nothing.
- <a id="ui-resource"></a>`ui.resource` (info): the resource is readable.
- <a id="ui-mime"></a>`ui.mime` (warn): mime type is `text/html;profile=mcp-app`.
- <a id="ui-html-size"></a>`ui.html-size`: non-empty, at most 10 MB (warning above 2 MB).
- <a id="ui-csp-missing"></a>`ui.csp-missing` (error): no `_meta.ui.csp` object (looked up on the resource contents, the read result, then the tool). `{}` is a valid declaration of "no external access".
- <a id="ui-csp"></a>`ui.csp` (info): explicit allowlists declared (`connectDomains`, `resourceDomains`, `frameDomains`, `baseUriDomains`).
- <a id="ui-csp-wildcard"></a>`ui.csp-wildcard` (error): `*`, a bare scheme (`https:`, `data:`) or a CSP keyword in an allowlist.
- <a id="ui-csp-invalid"></a>`ui.csp-invalid` (error): a list that is not an array of origins.
- <a id="ui-csp-broad"></a>`ui.csp-broad` (warn): wildcard host such as `https://*.example.com`.
- <a id="ui-csp-insecure"></a>`ui.csp-insecure` (warn): a non-loopback `http://` / `ws://` origin.
- <a id="ui-csp-undeclared-origin"></a>`ui.csp-undeclared-origin` (warn): the HTML references origins missing from the allowlists.

### Plugin packages

- <a id="plugin-manifest-read"></a>`plugin.manifest-read` (error): `plugin.json` is missing, larger than 64 KB or not valid JSON.
- <a id="plugin-manifest-format"></a>`plugin.manifest-format` (error): `format_version` is newer than the supported 1.
- <a id="plugin-manifest-schema"></a>`plugin.manifest-schema` (error): the manifest does not match the plugin schema (the first three issues are shown).
- <a id="plugin-manifest-namespace"></a>`plugin.manifest-namespace` (error): the id uses the builtin-only `com.kepcup` or `local.kepcup` namespace.
- <a id="plugin-manifest-metadata"></a>`plugin.manifest-metadata` (warn): `description`, `author`, `homepage` or `engines` is missing.
- <a id="plugin-readme"></a>`plugin.readme` (warn): the plugin has no `README.md`.
- <a id="plugin-files-path"></a>`plugin.files-path` (error): a contribution file or directory is missing, has the wrong type, is a symbolic link or escapes the plugin directory.
- <a id="plugin-files-limits"></a>`plugin.files-limits` (error): the directory exceeds the package limits (20,000 entries / 200 MB per file / 500 MB unpacked).
- <a id="plugin-package-entries"></a>`plugin.package-entries` (error): the `.kepcup` archive is unreadable or has an unsafe path, symlink, duplicate entry, encryption or ZIP64.
- <a id="plugin-skill-frontmatter"></a>`plugin.skill-frontmatter` (error): a skill's `SKILL.md` has no leading `---` frontmatter block, or the block lacks `name:` / `description:`. KepCup runs the full parser and sandbox-compatibility scan at install time.
- <a id="plugin-connector-entry"></a>`plugin.connector-entry`: the connector `server.json` fails the regular connector checks (findings are forwarded with the file path), or does not parse with the strict catalog-entry schema the installer uses (for example a missing `releaseGate`; plugin entries must be complete as written).
- <a id="plugin-connector-packages"></a>`plugin.connector-packages` (error): a connector entry inside a plugin declares `packages[]`; local execution belongs in an `mcp` contribution.
- <a id="plugin-connector-remote"></a>`plugin.connector-remote` (error): a connector remote is not a public https URL, or the entry has no remote at all.
- <a id="plugin-connector-icon"></a>`plugin.connector-icon` (error): the icon file is not next to `server.json`.
- <a id="plugin-mcpb-package"></a>`plugin.mcpb-package` (error): an embedded `.mcpb` is not a valid archive, lacks `manifest.json`, uses an unsupported `manifest_version`, or its `server.entry_point` (non-`uv`) is not in the bundle. Full validation runs at install time.
- <a id="plugin-mcp-http"></a>`plugin.mcp-http` (error): an `http` contribution URL is not a public https URL. Remote servers that need OAuth must be connector contributions.
- <a id="plugin-mail-host"></a>`plugin.mail-host` (error): a mail template host is an IP literal, `localhost`, has no dot, or uses a private suffix.
- <a id="plugin-permissions"></a>`plugin.permissions` (info): the derived permissions the consent card will show (hosts, OAuth scopes, MCPB `user_config` keys, mail templates).

## Library use

`import { validate, validateTarget, validatePlugin, checkManifest, checkTools, ... } from '@kepcup/app-validator'`. The `check*` functions are
pure (no I/O) and unit-testable; `validateTarget()` picks connector or plugin mode, and `validate()` / `validatePlugin()` do the I/O and return the report object above. The risk
classifier, tool-definition hash and `app_{slug}_` naming come from `@kepcup/shared` (`policy/`), so the
validator agrees with what the KepCup client will do.
