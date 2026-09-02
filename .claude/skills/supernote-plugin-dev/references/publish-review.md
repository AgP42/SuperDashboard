# Publish Review: Self-Audit Before Submitting

Supernote reviews every plugin before it goes live. This is the actionable checklist derived from
Supernote's published Plugin Review Process & Publishing Requirements: run it against the repo
*before* submitting instead of finding out at rejection. If this file ever disagrees with
Supernote's current published policy, the policy wins.

## The review pipeline

`Submit → Basic inspection → Function verification → Security review → Publish`

Reviewers judge **actual runtime behaviour**, not the listing copy:

- Installs and runs normally.
- Actual function matches the plugin's description.
- Requested permissions match actual function (no over-asking, no under-declaring).
- No abnormal file/data operations.
- No unauthorized data upload or leakage.
- No malicious behaviour or security risk.
- Nothing that destabilizes the device or blocks normal use.

Passing is a gate, not a lifetime guarantee: Supernote can re-check, suspend, or pull a version
post-publish based on reports. Be ready to ship a fix.

## Permission matrix

| Permission | Covers |
|---|---|
| `plugin.permission.FILE:READ` | Read the six shared dirs: `Document`, `EXPORT`, `INBOX`, `MyStyle`, `Note`, `SCREENSHOT` |
| `plugin.permission.FILE:WRITE` | Write/modify those same six dirs |
| `plugin.permission.FILE:DELETE` | Delete content within those six dirs |
| `plugin.permission.INTERNET` | Any outbound network, from JS, RN, Android, or native C/C++ sockets alike |

The plugin's own private data dir (`getPluginDirPath()`) needs no permission; put caches, DBs and
sticker/thumbnail files there. Enforcement is at the OS layer, so even raw `java.io` and native
sockets are gated (see gotcha #38 and Pattern 17 in `patterns.md`). `/Recent` is **not** one of the
six dirs — reading `/Recent/Recent.txt` throws `AccessDeniedException` even with `FILE:READ`.

**Least privilege** is the rule reviewers apply, so self-apply it: a UI-only plugin shouldn't ask
for `FILE:READ`. Every permission in `uses-permissions` should map to a real
`hasPermission`/`requestPermission` call site. Declared-but-unused and used-but-undeclared are both
flags (and the undeclared case shows up as `PluginSec: DENY` in `adb logcat`).

## Self-review checklist

Each item is a concrete check, not a vibe:

1. **Permission diff** — list every `FILE:*`/`INTERNET`-gated call site (`hasPermission`,
   `requestPermission`, plus any native socket/file API that needs them) and diff against
   `uses-permissions` in `PluginConfig.json`. Mismatch either way is a flag.
2. **Delete/overwrite audit** — grep native + JS for delete, batch-delete, overwrite, or clear ops
   on user files/notes. Every one must be reachable only through an explicit, traceable user action
   (a button, a confirmed dialog), never on startup, in a background task, or as a side effect.
3. **Network inventory** — list every network call site (`fetch`, `XMLHttpRequest`, native
   `Socket`/`OkHttp`). For each: what data crosses it, and if it's user data (note content,
   handwriting, PDFs/EPUBs, images, OCR output, input, file info), is it clearly disclosed in the
   description? Undisclosed transmission is an automatic failure.
4. **No suspicious hardcoded destinations** — grep for hardcoded IPs/hostnames/URLs used as
   connection targets. A fixed, unexplained destination looks like a C2/backdoor to a reviewer even
   when it's harmless. Prefer neutral defaults (`127.0.0.1`, empty, obvious placeholder) and let the
   user supply the real target.
5. **Description accuracy** — reread `PluginConfig.json` `desc` against runtime behaviour. No
   overclaiming ("works offline" while it phones home), no undisclosed extra functionality.
6. **Listing name** — `name` in `PluginConfig.json` is the friendly Settings label, not a leftover
   scaffold slug like `sn-my-plugin`.
7. **End-to-end install/run** — actually install the built `.snplg` and exercise the core function.
   `tsc`/`npm test` passing says nothing about on-device behaviour (a change can pass every local
   check and still crash at runtime).
8. **Source (optional)** — Supernote doesn't require it and withholding it doesn't block publishing,
   but a public repo link gives the reviewer a faster, more confident security review.

## What fails review

- Malicious deletion or destruction of user data.
- Unauthorized collection or leakage of user data.
- Anything that bypasses the permission mechanism (reaching shared storage or the network through a
  path that sidesteps `hasPermission`/`requestPermission`).
- Malicious code, backdoors, or hidden functionality.
- Behaviour that seriously destabilizes the device or blocks normal use.

Being small, simple, or "just like other plugins" is explicitly **not** a rejection reason. Don't
over-engineer features to look more "substantial" for review.
