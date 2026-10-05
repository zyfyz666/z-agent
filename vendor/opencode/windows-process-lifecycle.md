# Windows process lifecycle patch

OpenCode 1.18.11's Windows process adapter resolved its process-exit deferred
only from Node's `close` event. A PowerShell `Start-Process` child can inherit
pipe handles even when its own standard output/error are redirected. The
PowerShell parent exits, but `close` waits for the background child. A shell
tool therefore remained running for hours after printing the child's PID.
Its timeout and scope finalizer also awaited that same deferred indefinitely.

The patch changes the pinned adapter, not the shell command, user script,
permission check, Observer prompt, or official executable:

1. Record the parent's `exit` event. Prefer `close` when it follows promptly;
   otherwise allow 500 ms to drain output, then destroy the parent's remaining
   pipe handles and resolve its recorded exit status.
2. Never kill a process tree after the parent is already confirmed exited.
   A successfully launched background job survives the shell tool's return.
3. For a still-running foreground process, retain tree termination on Windows
   and process-group termination elsewhere. Bound `taskkill` itself to three
   seconds, bound the initial termination wait to `forceKillAfter` (three
   seconds by default), and bound the forced retry to a further three seconds.
   Failure to terminate remains an explicit error, not a successful timeout.
4. Use the same bounded termination helper for explicit tool cancellation and
   scoped process cleanup. After termination, the parent-exit drain deadline
   prevents an inherited handle from blocking completion.

Normal output continues to drain until `close`; only an exited parent's pipe
that remains open beyond 500 ms is closed. Output written by a background job
after that point belongs in that job's own log files.

## Calibration and integrity

The official `opencode-windows-x64@1.18.11` source is 174,182,280 bytes:

- Source SHA-256: `578d7eb3fff2c807fc0dedaab5e5d9177713a9560fa4304db6a0161111e9cc35`
- Patched SHA-256: `cf4b60a444d956526e921cffee593d71a195df61e0b59cd763610059c27253f3`
- Revision: `all-file-tools-v1-shell-lifecycle-v2`

`runtime-patch.json` contains the complete 2,263-byte original adapter block
and its 2,044-byte reviewed replacement, padded with spaces. The corresponding
block starts at byte 107,050,918 in this exact source. Its Node process adapter
imports the Effect process service from `chunk-t0q73gd0.js`; the patched block
is the Windows implementation using `cross-spawn`, not the other bundled
implementation with similar function names.

The existing 155-byte model-dependent file-tool filter removal is preserved.
Staging checks the complete input fingerprint, unique non-overlapping source
blocks, replacement lengths, complete output fingerprint, and written-file
fingerprint. Every byte outside those two blocks remains unchanged. Unknown
Windows binaries fail closed. The new revision/hash creates a separate cache
directory; npm's executable and old staged runtimes are never overwritten.

## Verification

```powershell
node --test test/opencode-runtime.test.cjs
node test/opencode-shell-lifecycle.e2e.cjs
```

The native test uses an isolated profile, temporary workspaces and a local
scripted model provider. It verifies `Start-Process` with both `-NoNewWindow`
and `-WindowStyle Hidden`: the shell returns and the model performs its next
tool call while the background child remains alive, then the child writes its
completion marker. It also verifies a foreground timeout, cancellation with
inherited pipes, another model turn after cancellation, and stdout/stderr tails.
No real model API or existing user process is used.
