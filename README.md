# WD Agent

A fork of [Yan-Agent](https://github.com/ViaTumLab/Yan-Agent) by ViaTum Lab, with
[thrash-watchdog](https://github.com/zyfyz666/thrash-watchdog) built into its opencode sidecar.

Almost everything here is Yan-Agent's work: the Electron desktop client, the task and
review workflow, model adapters, skills, MCP and the rest. This fork adds one thing: while
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
| `package.json`, `main.js` | own app id, product name and profile directory (`WD Agent` when packaged, `wd-agent` when run from source; `main.js` pins it on macOS), so the fork never shares settings with an installed Yan Agent |

In-app strings still say Yan Agent; the fork keeps its diff against upstream small on purpose.

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
There are no official WD Agent installers; build your own.

## License and credits

MIT, as upstream. The original copyright notice is kept in [LICENSE](LICENSE). Third-party
code, skills, fonts and assets keep their own licenses, listed in
[lib/THIRD_PARTY_NOTICES.md](lib/THIRD_PARTY_NOTICES.md). Issues with the desktop client
itself are best reported [upstream](https://github.com/ViaTumLab/Yan-Agent/issues).
