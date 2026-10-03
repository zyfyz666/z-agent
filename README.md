# Z

Z is a desktop coding agent based on [Yan-Agent](https://github.com/ViaTumLab/Yan-Agent)
by ViaTum Lab, with [thrash-watchdog](https://github.com/zyfyz666/thrash-watchdog)
built into its OpenCode runtime and a dedicated Observer panel in the interface.

Almost everything here is Yan-Agent's work: the Electron desktop client, the task and
review workflow, model adapters, skills, MCP and the rest. While
a run is busy, a deterministic watchdog judges the agent's tool-call pattern and, when it is
looping, delivers a one-sentence nudge through Yan's existing runtime interjection channel.
For what the desktop client itself can do, read the
[upstream README](https://github.com/ViaTumLab/Yan-Agent#readme) and
[documentation](https://viatumlab.inkmindspace.com/yagent/).

## What the fork changes

| file | change |
|---|---|
| `lib/vendor/thrash-watchdog/` | the thrash-watchdog core, vendored unmodified (see `VENDORED.md`) |
| `lib/thrash-watchdog.js` | Yan adapter: uses Yan's own `verificationRecord` to decide what counts as a check |
| `lib/opencode-sidecar.js` | judges each poll while the run is busy; delivers via `deliverInterjection`; emits `yan.thrash.watchdog` events; writes a hash-chained audit to `<workspace>/.yanagent/thrash-audit.jsonl` |
| `test/thrash-watchdog.test.cjs` | adapter tests |
| `package.json`, `main.js` | Z app branding and build names; the existing app id and profile directories are preserved |
| `renderer/` | Z interface and the Observer panel for the current task's watchdog status and intervention history |

## Observer (观察者)

The **Observer** panel opens by default at startup and shows the watchdog's state
for the selected task and the interventions it has reported. You can close it and
reopen it from the sidebar; task updates do not force it open again. The observer watches tool-call patterns for repeated work without
progress and can send a short reminder through the runtime's interjection channel.
The panel reports actual runtime events; it does not make an additional model request
or grade the quality of an answer. A quiet watchdog is not proof that a task is correct.

## Existing settings and sessions

Z keeps the former WD Agent profile directories in place, so renaming the app does not
hide existing settings, model connections, memories, or conversations. Nothing is moved
or copied during this rename:

- Windows/Linux source runs keep `<appData>/wd-agent`.
- Packaged runs keep `<appData>/WD Agent`; macOS source runs also keep this directory,
  matching the previous app behavior.
- The `YanData` subdirectory, workspace `.yanagent` evidence, existing `YAN_*`
  environment variables, and app id `io.github.zyfyz666.wdagent` remain compatible.

On Windows, `<appData>` is normally `%APPDATA%`. The explicit E2E profile override
continues to take precedence, keeping tests isolated from personal data. These profiles
remain separate from an installed upstream Yan Agent.

## Watchdog settings

| variable | default | effect |
|---|---|---|
| `WD_WATCHDOG` | on | `0` disables the watchdog |
| `WD_WATCHDOG_N` | `6` | judge every N tool calls |
| `WD_WATCHDOG_HALT` | off | `1` lets persistent thrashing request the run to finish |

The rules, the evidence behind them and their limits are documented in the
[thrash-watchdog README](https://github.com/zyfyz666/thrash-watchdog#the-rules).

## Run from source

Windows x64 or macOS arm64, Node.js 22 (as in CI):

```bash
npm ci
npm start       # or: npm run dev
npm test
```

Build targets are unchanged from upstream (`npm run build`, `build:portable`, `build:mac`).
Build outputs are named Z. There are no official Z installers; build your own.

## License and credits

MIT, as upstream. The original copyright notice is kept in [LICENSE](LICENSE). Third-party
code, skills, fonts and assets keep their own licenses, listed in
[lib/THIRD_PARTY_NOTICES.md](lib/THIRD_PARTY_NOTICES.md). Issues with the desktop client
itself are best reported [upstream](https://github.com/ViaTumLab/Yan-Agent/issues).
