# OpenCode runtime baseline

Z Kernel Copy uses the official OpenCode runtime as its only Agent execution authority.

- Upstream: https://github.com/anomalyco/opencode
- Release: `v1.18.11`
- Tag commit: `012c2f57f976489d88bd4598a056b4bdcdd428ee`
- Runtime package: `opencode-ai@1.18.11`
- SDK package: `@opencode-ai/sdk@1.18.11`
- License: MIT (retained in this directory)

The executable and generated SDK are installed from the pinned official npm packages. At startup Z derives a verified runtime copy with the file-tool registry and Windows process lifecycle patches below. Z's Electron frontend connects to an authenticated loopback OpenCode server through `lib/opencode-sidecar.js`; it does not implement or fall back to the deleted Z V1/V2 Agent loop.

## Z integration boundaries

- OpenCode data, config, cache, state, logs, and sessions are isolated below Z's own `ZData/opencode-runtime` directory through XDG path variables.
- OpenCode's perceived home directory is pinned to `ZData/opencode-runtime/home` with the `OPENCODE_TEST_HOME` hook available in the pinned `v1.18.11` source. This prevents global `.agents`, `.claude`, and `.opencode` content from entering Z's runtime while leaving the real shell environment unchanged.
- `OPENCODE_DISABLE_EXTERNAL_SKILLS=true` and `OPENCODE_DISABLE_PROJECT_CONFIG=true` disable external Agent Skill discovery and workspace OpenCode configuration. Z supplies only its bundled `lib/skills` and `ZData/skills` roots explicitly.
- Z bundles the official `skills@1.5.21` CLI and exposes it only through the built-in `z_skills` MCP. Search and installation run inside an isolated staging project below `ZData/SkillStore`; complete validated packages are then atomically placed in `ZData/skills`. Blank never receives general file-write or shell permission for Skill management.
- Blank Skill invocation is available through OpenCode's native Skill tool and the `z_skills.read_skill` fallback. Deletion is limited to direct children of `ZData/skills` and moves removed packages into Z quarantine instead of touching any external Agent directory.
- Every run receives a compact catalog of Z-installed Skills and enabled MCP servers. The catalog guides capability selection; the native Skill tool, Z Skills MCP result, and live MCP tool schemas remain the authoritative execution instructions.
- `z_browser` is a built-in MCP backed by an authenticated loopback bridge to Z's visible browser WebView. Ordinary browsing, research, local previews, and web verification route there first; Playwright is reserved for isolated scripted testing and Chrome is the final fallback for explicit profile, login, or extension requirements.
- The home-isolation hook is upstream-internal rather than a public compatibility promise. Every OpenCode upgrade must re-audit `packages/core/src/global.ts`, `packages/opencode/src/effect/runtime-flags.ts`, and `packages/opencode/src/skill/index.ts` before changing the pinned version.
- Runtime configuration is supplied through `OPENCODE_CONFIG_CONTENT` when the authenticated sidecar starts.
- The upstream `packages/opencode/src/tool/registry.ts` makes file tools mutually exclusive by model name. Z removes that filter with `all-file-tools.patch`, so all model IDs can use the native `write`, `edit`, and `apply_patch` tools. Session/agent permissions and Plan/Blank restrictions still apply.
- Z does not call OpenCode's per-directory `config.update` endpoint: in this pinned upstream release that endpoint persists its payload into `<workspace>/config.json`, which is not an acceptable place for Z provider credentials or runtime policy.
- A configuration change restarts the sidecar only when no Agent run is active; an in-flight run is never silently moved onto another provider, model, permission set, or MCP configuration.

## Native runtime patches

`lib/opencode-runtime.js` prepares the runtime before every actual kernel startup. The official npm executable is never overwritten. The Windows x64 build is pinned by its full SHA-256 in `runtime-patch.json`; the generated copy lives under `ZData/opencode-runtime/bin/all-file-tools-v1-shell-lifecycle-v2-<hash>/opencode.exe`. A new revision has its own directory and never overwrites an active older runtime.

The official Bun executable embeds JavaScript source without bytecode. The adapter replaces the unique 155-byte minified model-filter block with equal-length spaces and applies one padded 2,263-byte process lifecycle replacement. Every byte outside these two non-overlapping blocks and every bundled offset is preserved. It verifies the complete source hash, generated hash, and staged file hash before execution. Existing cache entries are verified and corrupt entries are regenerated. Concurrent preparations in one process share a promise; independent app processes publish through temporary files and tolerate another process winning the race.

The process lifecycle patch separates parent exit from inherited pipe closure. After parent exit, it allows up to 500 ms to drain output, then settles even if a background child retains the pipe. An exited parent is never used to trigger tree termination. Foreground timeout and cancellation use bounded termination and report failure explicitly. Very large or slowly consumed trailing output can be truncated at the drain deadline; background jobs should use their own log files. See [Windows process lifecycle patch](windows-process-lifecycle.md) for the complete rationale, calibration, and verification.

This is a version-specific executable-source patch, not a rebuilt upstream release. The manifest currently supports the shipped `opencode-windows-x64@1.18.11` binary (and the identical `opencode-ai/bin/opencode.exe` fallback). Unknown Windows binaries fail explicitly; other platforms retain the official runtime. An upstream upgrade or additional architecture needs reviewed source blocks, new source/output hashes, and the native execution tests below. `all-file-tools.patch` is the equivalent registry source change and can be applied with `git apply --unidiff-zero` when rebuilding upstream; `runtime-patch.json` also records the complete original and replacement process lifecycle source.

Verification:

```powershell
node --test test/opencode-runtime.test.cjs test/opencode-permission.test.cjs test/opencode-dsml.test.cjs test/opencode-kernel-pool.test.cjs
node test/opencode-file-tools.e2e.cjs
node test/opencode-shell-lifecycle.e2e.cjs
node test/provider-runtime.e2e.cjs
```

The native test inspects both registry output and outbound provider schemas, executes all three native tools for GPT, DeepSeek, Claude, Gemini, Qwen and custom model IDs, and verifies read-only/Plan restrictions. It uses a local scripted provider and does not call external model APIs. Packaged-provider verification also stages the patched runtime and checks all three schemas.
