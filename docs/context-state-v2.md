# Conversation context and rewind

The desktop archive and the model context have different purposes. The archive
keeps messages, tool evidence, Observer records and display boundaries. It must
not be converted into a replacement model prompt after rewind.

## Authority

Desktop turns use `contextV2`. A bound native session is the execution context;
an immutable native snapshot is the only authority for reconstructing it.
`contextState.head` points to that snapshot. `contextState.points` records
before-user, after-user, before-guidance and after-run boundaries. Only main
process runtime receipts may advance these references. Renderer saves cannot
replace the head, import a reference or bind another native session.

Snapshots retain the effective completed compaction and its tail. Pruned tool
outputs remain cleared. Unfinished tools at a branch boundary become historical
interruption records; restoring them cannot resume those tools or roll back
files. Earlier request billing is retained in the desktop archive, but cleared
from restored native messages because it does not measure their new occupancy.

## Persistence and restore

`context-store/v2/messages` contains immutable content-addressed native message
objects; `snapshots` contains manifests referencing them. Transport IDs are
normalized, so native reimport does not duplicate otherwise identical objects.
Objects are flushed into temporary files, atomically published without replacing
an existing object, and hash-verified. Manifests carry an estimated token count;
actual runtime usage replaces this estimate once the model responds.

Rewind resolves the target before writing either conversation. It saves the
complete original in a separate backup, then atomically changes the original
conversation's archive and head. Revision checks reject delayed receipts/saves.
The user message being edited is outside the restored head. A user-inclusive
fork uses its separate after-user boundary. Guidance records freeze the visible
text and known tool results when submitted, including unfinished tool evidence.

Restore creates a new native session with a one-use import nonce. A SQLite
transaction inserts the saved messages only if the session belongs to that
import, has the expected directory and contains no messages. Readback through
the native API must match the content digest before a prompt is submitted.
The original native session and project files are never edited by restore.

## Legacy conversations and failures

Legacy migration reads original native records using exact part/call IDs,
conversation ownership and directory checks. It does not replay the UI archive
or attempt to validate an old archive-seed encoding. If native provenance is
missing, rewind fails before changing the conversation. There is no fallback
that serializes the entire desktop history into model input.

Snapshot failures before sending block submission. Failures after sending are
reported separately and never cause prompt replay or discard completed work.
The asynchronous native submission acknowledgement does not prove the user
message has been committed. User and guidance parts receive explicit identities;
the receipt reader waits for that message and every submitted part, with a
bounded read-only wait. If visibility is delayed beyond the wait, settled native
history fills in the boundary before finalization. A transient 404 is not a
failed send, and repairing the receipt never resubmits the model prompt.
Legacy checkpoint helpers remain for utility/compatibility callers; desktop
v2 runs neither restore nor generate those checkpoints.

## Verification

- `test/context-state.test.cjs`: immutable storage, compaction, pruning, token
  accounting, transactional import, detached guidance and boundary inheritance.
- `test/context-state.e2e.cjs`: pinned native runtime with a loopback-only model;
  five identical rewinds produce identical wire sizes, summary/tail appears
  once, pruned output and future guidance output are absent, files/source remain
  unchanged, legacy native provenance can be migrated without archive replay.
- `test/context-desktop.e2e.cjs`: real isolated Electron profile, message-menu
  rewind, editable resend, restart, repeated rewind, backup restore and rejection
  of forged renderer context pointers.

All tests use temporary profiles and local fixtures. No real model credentials,
user task executions or live native databases are used for these test runs.
