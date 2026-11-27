#!/usr/bin/env node
// Zero-dependency bundle-size gate. Measures every published subpath's ESM
// bundle (raw + brotli-compressed) and fails when any subpath exceeds the
// hard-coded budget below.
//
// Why zero deps: this is a logging library that ships `"dependencies": {}` on
// purpose. The CI/release runner must stay free of third-party tooling so a
// compromised devDep cannot tamper with the bundle before `pnpm publish`.
// `node:zlib`'s brotli matches what npm/CDN compression produces on the wire.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, constants } from 'node:zlib'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Budgets are in bytes (KiB units, `n * 1024`, matching the table's ÷1024
// display) measured against the brotli'd .mjs bundle — what a consumer's
// bundler/CDN ships. Brotli, not gzip, to match real wire compression.
//
// Bymax bundle-size convention (canonical: Obsidian → 03 - Resources/NestJS/
// Bymax-Conventions.md → "Bundle-size budgets"):
//   1. The .mjs ships UNMINIFIED with JSDoc (tsup `minify: false`) on purpose —
//      readable stack traces / source inside a consumer's node_modules outweigh
//      a few KB on a backend lib that never reaches a browser. We do NOT minify
//      a lib just to satisfy a size budget.
//   2. The budget is CALIBRATED to the real built artifact + MODEST headroom:
//      enough to absorb normal inter-release growth, tight enough to catch
//      accidental bloat (e.g. a peer dep leaking into the bundle). It is a
//      bloat tripwire, NOT a hard design ceiling — when real growth is
//      legitimate, raise it (and say why here); when the artifact shrinks,
//      tighten it. Avoid >2x headroom: it silently lets bloat through.
//
// Calibration history (newest first):
//   - 2026-11-27 — server: 49,426 B real -> 49,456 B budget (48.30 KiB), measured + 30 as approved by
//     the project manager. What the bytes bought: bindings passed to child() and setBindings() of the
//     Pino instance are redacted, as is what the formatters and serializers of child options return.
//   - 2026-11-24 — server: 49,195 B real -> 49,225 B budget (48.07 KiB), measured + 30 as approved by
//     the project manager. What the bytes bought: a descriptor is read for its own get and value only,
//     so a field planted on Object.prototype is never taken for one (species baseline, toJSON, options).
//   - 2026-11-24 — server: 49,124 B real -> 49,154 B budget (48.00 KiB), measured + 30 as approved by
//     the project manager. What the bytes bought: the result of a hook is waited for through the
//     intrinsic constructor (one synchronous call, then removed), and a native promise that carries its
//     own constructor or then, or cannot take the slot, is refused (16b.15).
//   - 2026-11-24 — server: 49,022 B real -> 49,052 B budget (47.90 KiB), and observability: 1,301 B
//     real -> 1,331 B budget (1.30 KiB), each measured + 30 as approved by the project manager. What
//     the bytes bought: the baseline of a promise also compares the species getter of the intrinsic
//     `Promise`, so a species that throws is refused and not left to orphan a rejection (server,
//     +18 B); a promise the library returns carries a constructor that cannot be redefined, and the
//     readiness check builds its own promise and freezes its verdict (observability, +62 B over the
//     1,239 B budget, which it already exceeded since the check owns its promise).
//   - 2026-11-24 — server: 48,974 B real -> 49,004 B budget (47.86 KiB), as approved by the project manager (measured + 30): every promise returned on a decision path carries an own intrinsic constructor (16b.12).
//   - 2026-11-24 — server: 48,879 B real -> 48,909 B budget (47.76 KiB), as approved by the project manager (measured + 30).
//     absorb gives the promise it drops an own constructor, the intrinsic one, so a constructor whose species throws cannot orphan it. Comments do not ship in dist: the growth is code.
//   - 2026-11-24 — server: 48,827 B real -> 48,857 B budget (47.71 KiB), as approved by the project manager (measured + 30).
//     DEC-217/16b correction round: a wait that is refused absorbs its own promise, the entry refusal absorbs the promise the caller holds, and the baseline reads the own descriptor of the constructor. Comments do not ship in dist: the growth is code.
//   - 2026-11-24 — server: 48,778 B real -> 48,808 B budget (47.66 KiB), as approved by the project manager (measured + 30).
//     DEC-217/16b: the intrinsic-promise util (baseline check, null-prototype outcome box, absorb) and its use at four sites. Comments do not ship in dist: the growth is code.
//   - 2026-11-23 — server: 48,276 B real -> 48,306 B budget (47.17 KiB), as approved by the project manager (measured + 30).
//     The table of guarded built-ins (about 85 members, by holder) and the guard at the entry of each path that reads them.
//   - 2026-11-23 — server: 47,779 B real -> 47,809 B budget (46.69 KiB), as approved by the project manager (measured + 30).
//     A plain text is replaced by a loop over the captured indexOf and slice, which ask no pattern for a method.
//   - 2026-11-23 — server: 47,726 B real -> 47,756 B budget (46.64 KiB), as approved by the project manager (measured + 30).
//     The names a path is read for are found by the captured exec, not by the matching method of the pattern.
//   - 2026-11-23 — server: 47,653 B real -> 47,683 B budget (46.57 KiB), as approved by the project manager (measured + 30).
//     The regex and replace methods the fold decides with are captured, and a record is dropped when a method
//     the error-stack code reads (slice, the string iterator, own descriptors, own keys) was replaced.
//   - 2026-11-23 — server: 47,446 B real -> 47,476 B budget (46.36 KiB), as approved by the project manager (measured + 30).
//     The methods the redaction and the routing decide with are captured when the module loads, the name sets
//     keep their own `has` and `add`, and a record is dropped when a method Pino calls for itself was replaced.
//   - 2026-11-23 — server: 47,143 B real -> 47,173 B budget (46.07 KiB), as approved by the project manager (measured + 30).
//     A Proxy source under a planted accessor is refused, and the descriptors the logger defines are built
//     with no prototype (`bareDescriptor`), so a `get` or a `set` planted on the root does not reach them.
//   - 2026-11-22 — server: 47,012 B real -> 47,042 B budget (45.94 KiB), as approved by the project manager (measured + 30).
//     An option that a Proxy answers through its `get` trap counts even when a key of the same name is
//     planted on the root, and a planted accessor is not called.
//   - 2026-11-22 — server: 46,941 B real -> 46,971 B budget (45.87 KiB), by the rule of measured + 30 the project manager set.
//     Pino also reads `writable`, `_writableState`, `prettyPrint` and `onChild` off the options: an own value each.
//   - 2026-11-22 — server: 46,919 B real -> 46,949 B budget (45.85 KiB), as approved by the project manager.
//     An own value for each name Pino reads and the library does not set (`transport`, `crlf`, `msgPrefix`,
//     `name` and `redact.remove`), so a key planted on `Object.prototype` is not read in its place.
//   - 2026-11-22 — server: 46,877 B real -> 46,907 B budget (45.80 KiB), as approved by the project manager.
//     The options read as the consumer set them: a key that only the root of a prototype chain holds is
//     skipped, and the option sets and the service metadata are objects with no prototype.
//   - 2026-11-21 — server: 46,813 B real -> 46,830 B budget (45.73 KiB), as approved by the project manager.
//     The audit fixes of 1.4.30: a non-ASCII symbol stands for a letter in a key, an own `stack` of an Error and
//     the stack keys at the root of an entry are read by their spelling, and the positional stack is hidden.
//   - 2026-11-21 — server: 46,654 B real -> 46,670 B budget (45.58 KiB), as approved by the project manager. The 1.4.30 fixes: a generated table of the symbols drawn as a Latin letter, the stack
//     keys of an object message and of an Error read by their spelling, and the length cap on a
//     configured name.
//   - 2026-11-21 — server: 46,417 B real -> 45.35 KiB budget (46,438 B), approved by the project manager
//     at 46,440 B. A bounded answer cache per set of names, so a key that every record repeats is
//     compared once instead of folded at each hide site (throughput retention C/B ~0.24 against 0.20).
//   - 2026-11-21 — server: 46,394 B (45.31 KiB) real -> 45.32 KiB budget (46,407 B, +13 B over the
//     measurement). The 1.4.29 fixes: a configured name and a key are compared in the shared folded
//     form, which drops every character that is not a letter or a digit, reads a look-alike of one Latin
//     letter and no other as it, and reads any other letter that is not ASCII as one or two letters
//     against the names of a compatible length where a value is hidden, while a field is dropped only on
//     an exact match; every key that spells the
//     message or the stack is read for the header, a hidden message is replaced wherever a stack repeats
//     it, whatever its length and wherever it sits against the part of the stack that is read, the stack
//     of a plain object is scrubbed, an object with more messages or stack keys than a search can be
//     bounded for has its stacks hidden whole, the list options have a cap and a length check, and more
//     characters that print as nothing are read through. The disable comments that document the
//     equivalent mutants ship in the bundle.
//   - 2026-11-21 — server: 45,155 B (44.10 KiB) real -> 44.20 KiB budget (45,260 B, +105 B over the
//     measurement). The 1.4.28 fixes: the options are read once into a copy (the lists, the serializers
//     table and the service metadata included) that is validated, defaulted and handed to the module
//     builder; the derived keys are compared with the shared folding.
//   - 2026-11-21 — server: 44,923 B (43.87 KiB) real -> 43.95 KiB budget (45,004 B, +81 B over the
//     measurement). The keys that name the message and the stack of an object are matched as the
//     spellings of one name are, so the stack header is hidden whatever the case of the keys.
//   - 2026-11-21 — server: 44,779 B (43.73 KiB) real -> 43.80 KiB budget (44,851 B, +72 B over the
//     measurement). The 1.4.27 fixes: a host option that throws at read time ends in one refusal with
//     the host's error as its cause, the message is hidden in the stack header of an object below the
//     top level, a name that holds a value is hidden with the message, and the derived keys are owned as
//     they look. The PM approved the raise under DEC-186.
//   - 2026-11-21 — server: 44,289 B (43.25 KiB) real -> 43.30 KiB budget (44,339 B, +50 B over the
//     measurement). The 1.4.26 fixes: the key comparison reads combining marks, control characters and
//     a longer list of look-alike letters, the derived keys are owned, the name of an `Error` under a
//     key of your own passes the censor, an `Error` is read as one whatever its name holds, the stack
//     of an object message is censored, and a lone surrogate is escaped.
//   - 2026-11-21 — server: 43,583 B (42.56 KiB) real -> 42.60 KiB budget (43,622 B, +39 B over the
//     measurement). The exemption of the `message` of the object under `err` (it is left to the
//     serializer when it is text, and for the `toJSON` result too) lives in its own module, and the
//     walk asks it which keys it censors.
//   - 2026-11-20 — server: 43,499 B (42.48 KiB) real -> 42.50 KiB budget (43,520 B, +21 B over the
//     measurement). The comparison of two keys reads through white space, characters that print as
//     nothing, the compatibility forms Unicode defines and a short list of lookalike letters
//     (`foldKey`); the dotted resource keys are owned by their spellings; the name of an error that
//     is text passes the censor of the message (`censorName`, in the node, the stack header, the
//     derived exception fields and the line about a failed destination); and the walk of the names
//     strategy leaves the text of an error-shaped object under `err` to its serializer. It is
//     +578 B over the 42,921 B measured at the previous budget.
//   - 2026-11-18 — server: 42,921 B (41.92 KiB) real -> 41.94 KiB budget (42,946 B, +25 B over the
//     measurement). The lines the library writes about a failed destination keep the destination
//     out of `msg`, write a failed shutdown as a structured line under its own key, and pass the
//     message of the error through the censor of the message of an entry (the factory hands it to
//     each stream and to the mixin, the registry builds it, and the sink reaches it through a method
//     of the service); the entry text finisher takes an optional cut instead of two booleans. It is
//     +70 B over the 42,851 B measured at the previous budget.
//   - 2026-11-18 — server: 42,851 B (41.85 KiB) real -> 41.88 KiB budget (42,885 B, +34 B over the
//     measurement). A key that only spells a key the logger writes (`trace_id` for `traceId`,
//     `Level` for `level`) is dropped like the key itself, by one comparison that folds the case and
//     the separators (`foldKey`), in the owned-key guard and in the merge of the mixin; the text of
//     an entry that comes from an `Error` is censored under the name `message` like `err.message`,
//     and bounded to one line; and that message is censored where it opens the stack of each error of
//     a chain and in the derived `exception.*` fields, on the raw stack before it is scrubbed, by
//     one comparison at the place the engine writes it (`censorStackHeader`, `headerCensor`). It is
//     +663 B over the 42,188 B measured at the previous budget.
//   - 2026-11-18 — server: 42,163 B (41.18 KiB) real -> 41.20 KiB budget (42,189 B, +26 B over the
//     measurement). The entry-text finisher takes a callback and whether the entry is written, and
//     calls back only for an entry that is, so the cut of the text of an object message is counted
//     under `max_string_length` like the cut of a field and only for an entry that is written. It
//     is +63 B over the 42,100 B measured before.
//   - 2026-11-18 — observability: 1,169 B (1.14 KiB) real -> 1.21 KiB budget (1,239 B, +70 B over
//     the measurement). The new subpath: the two Prometheus counters and the readiness check, which
//     import the logger by its package name (external) and the optional peers `@bymax-one/nest-core`
//     and `prom-client`. A subpath of its own, so a host that never imports it pays nothing.
//   - 2026-11-18 — server: 42,100 B (41.11 KiB) real -> 41.14 KiB budget (42,127 B, +27 B over the
//     measurement). The logger counts the fields it cuts or replaces by reason and the writes a
//     destination refused, and exposes them with the delivery state through
//     `LOGGER_OBSERVABILITY_TOKEN`; the three counting sites take a callback. It is +446 B over the
//     41,654 B measured at 1.4.23.
//   - 2026-11-17 — server: 41,654 B (40.68 KiB) real -> 40.70 KiB budget (41,677 B, +23 B over the
//     measurement). The derived exception fields are cut to maxEntrySizeBytes in UTF-8 bytes
//     (`cutBytes`), and the size ceiling measures a value with a cycle or a BigInt as it is written
//     (`measurableJson`) and replaces one that cannot be read. It is +339 B over the 41,315 B
//     measured at 1.4.23.
//   - 2026-11-17 — server: 41,360 B (40.39 KiB) real -> 40.42 KiB budget (41,390 B, +30 B over the
//     measurement). A plain object passed as the message of a Nest-style call is written as the
//     fields of the entry (`objectMessageText`, the shared `isPlainRecord`), and the keys the logger
//     writes itself (level, time, msg, service, deployment) are dropped from metadata, and the mixin's
//     keys win the merge, with an own-property check for the userId a call names, and the entry text of an object
//     message is censored under the names of its field and cut like it. It is +692 B over the 40,668 B measured
//     before it.
//   - 2026-11-17 — server: 40,668 B (39.71 KiB) real -> 39.74 KiB budget (40,694 B, +26 B over the
//     measurement). An option that holds undefined or null is read as not set (`dropUnsetOptions`
//     with its typed key lists), a list member that is undefined is refused with its type, and the
//     factory holds a logger built from resolved options to the censor rule. It is +302 B over the
//     40,366 B measured before it.
//   - 2026-11-17 — server: 40,366 B (39.42 KiB) real -> 39.45 KiB budget (40,397 B, +31 B over the
//     measurement). Refusals that name the type of the value they received and never quote it:
//     `describeValue` is a switch over the types, and five refusals that printed `String(value)`
//     go through `reject`. It is +95 B over the 40,271 B measured before it.
//   - 2026-11-17 — server: 40,271 B (39.33 KiB) real -> 39.36 KiB budget (40,304 B, +33 B over the
//     measurement). The refusal of a `redactCensor` longer than `maxStringLength` is +66 B over the
//     40,205 B measured before it: one condition and its message.
//   - 2026-11-17 — server: 40,205 B (39.26 KiB) real -> 39.3 KiB budget (40,243 B, +38 B over the
//     measurement). `maxStringLength`, its validation and the `cutStrings` pass with the wiring
//     that runs it are +320 B over the 39,885 B of the previous budget.
//   - 2026-11-17 — server: 39,853 B (38.92 KiB) real -> 38.95 KiB budget (39,885 B, +32 B over the
//     measurement). The integer check on `maxEntrySizeBytes` and the `TypeError` guard of
//     `LogPerformance` with its message are +59 B over the 39,794 B measured before them.
//   - 2026-11-17 — server: 39,794 B (38.86 KiB) real -> 38.9 KiB budget (39,834 B, +40 B over the
//     measurement). Splitting `PrettyDevDestination.onInit` into three methods is +68 B over the
//     39,726 B measured before it: their signatures and the doc comments that ship with them.
//   - 2026-11-17 — server: 39,726 B (38.80 KiB) real -> 38.82 KiB budget (39,752 B, +26 B over the
//     measurement). The shutdown drain's wait for what `process.stdout` holds is +158 B over the
//     39,568 B measured before it: one method, its import and its comment.
//   - 2026-11-14 — server: 39,568 B (38.64 KiB) real -> 38.68 KiB budget (39,608 B, +40 B over the
//     measurement). The sink fields, the dotted path token test and the windowed write-failure report
//     are +0.53 KiB over the 38.11 KiB measured on the 1.4.17 tarball: the `repeated`, `errorCode` and
//     `errorDetails` reading with its fail-soft guard, the per-part token test, and the shared report
//     window with the `suppressed` count and the shutdown total, all of it executable code and its
//     comments.
//   - 2026-11-14 — server: 38.02 KiB real -> 38.2 KiB budget (~0.5% headroom). The bound on what a
//     destination may hold queued is +1.21 KiB over the 36.81 KiB measured below: the
//     `destinationQueue` option with its JSDoc and validation, the `Writable` subclass that drops an
//     entry past the bound, the drop record and its rate-limited report, the shutdown tally and
//     the `queuedBytes` of the default stdout destination, all of it executable code and its comments.
//   - 2026-11-14 — server: 36.81 KiB real -> 36.9 KiB budget (~0.2% headroom). The lifecycle deadlines
//     are +1.30 KiB over the 35.51 KiB measured below: the `shutdown` and `destinationHookTimeoutMs`
//     options with their JSDoc and validation, the timeout helper, the drain of each destination's
//     queue and the skipped-destination report, all of it executable code and its comments.
//   - 2026-11-13 — server: 35.51 KiB real -> 35.6 KiB budget (~0.3% headroom). The default `req`
//     serializer (a request object logged as metadata is written as its method, URL, headers and
//     peer, and a `rawHeaders` or `rawTrailers` array has its credential values censored) is +0.45 KiB over the
//     35.06 KiB measured below, all of it executable code and its JSDoc.
//   - 2026-11-13 — server: 35.06 KiB real -> 35.25 KiB budget (~0.5% headroom). The previous budget
//     of 35.0 KiB was exceeded by scrubbing a credential path segment from `url`, `fullUrl` and the
//     not-found message (the detector, its `http.secretPathSegments` option with its validation and
//     defaults, and the three consumers), all of it executable code.
//   - 2026-11-09 — server: 34.08 KiB real -> 35.0 KiB budget (~2.7% headroom). Measured with an
//     `Error` converted to data under `redactStrategy: 'paths'`, with the default names censored
//     inside it (`errorOnlyNames` in the walk and its helper in the factory): 33.91 KiB before,
//     34.08 KiB after. The three raises before this one each left under 1% of headroom, so the next
//     change failed the gate by a hair; this one leaves room for ordinary growth.
//   - 2026-11-09 — server: 33.70 KiB real -> 34.0 KiB budget (~0.9% headroom). Measured with the
//     error layer that keeps a body-parser error's type for the filter (module `configure`, the
//     layer and the request state accessors), the fixed log texts and `bodyParserType`: 33.39 KiB
//     before those, 33.70 KiB after.
//   - 2026-11-08 — server: 33.02 KiB real -> 33.5 KiB budget (~1.4% headroom). Re-derived from the
//     artifact: the previous budget had 0.12 KiB of headroom left (32.88 KiB real). Keeping any
//     `toJSON` hook the redaction walk did not follow out of the output adds executable code only.
//     Measurement noise is +-0.03 KiB per edit. The headroom is small on purpose: the next change
//     of this size has to say what it adds.
//   - 2026-11-07 — server: 32.17 KiB real -> 33.0 KiB budget (~2.6% headroom). Budget = measured
//     32.17 + 0.83 of headroom; re-derive from the artifact when it is exceeded. `main` measured
//     31.04 KiB, and the option that chooses which own fields of an error are written adds +1.13
//     KiB, every byte executable code. By step: the options, their validation, the policy and its
//     threading through the serializer and the redaction walk +0.60; the review fixes (the record
//     walked even when no name is covered, the `Error` parts split out of the walk, the `toJSON`
//     skip) +0.16; the output written as plain data under 'safe' (functions and symbols omitted,
//     binary anywhere as its size, `toJSON` read once the way the stringifier reads it, a name
//     for what a serializer receives) +0.18; the copier of an error's own fields split to stay
//     within the function-size rule +0.02; the width cap kept in the walk and its marker read by
//     the sanitizer, so an `AggregateError` is not traversed in full before a serializer keeps
//     ten members and the count of its marker read only as a positive integer, +0.03; a list of
//     members kept as a list at the cause-depth limit for what a serializer receives, one marker per member of any kind and the
//     cap's own marker kept, +0.14.
//     Savings that were tried and measured: removing duplication (one set of
//     derived fields, one policy-only redactor, cosmetic freezes) recovered the first overrun;
//     the later ones moved the compressed size by less than its noise (+-0.03 KiB per edit), and
//     the one simplification that saved bytes changed behavior on hostile arrays.
//   - 2026-11-06 — server: 30.61 KiB real -> 32.0 KiB budget (~4.5% headroom). RE-DERIVED from
//     the artifact, per the standing rule: the nested-Error node had taken the headroom down to
//     0.06 KiB, and omitting what a failed driver call was given or quoted from an error's fields
//     adds +0.27 KiB (the helper that decides which own fields are written, the check that
//     recognises a PostgreSQL error, and the use of both in the serializer and the redaction
//     walk). It is executable code, not comment weight.
//   - 2026-11-06 — server: 30.34 KiB real -> 30.4 KiB budget (0.06 KiB of headroom, the
//     measured minimum). `main` measured 29.64 KiB; the nested-Error node adds +0.70 KiB,
//     all executable code (the field-walk copy, the head and chain parts each guarded on its
//     own, the chain budget and the `errors` cap). Trimming the prose around it was measured
//     and moved the artifact by 0.00 KiB, as in the entries below: comments do not ship.
//     Raised by the minimum rather than re-derived with the usual ~5% headroom.
//   - 2026-11-01 — server: 28.79 KiB real -> 30.2 KiB budget (~4.9% headroom).
//     RE-DERIVED from the artifact, per the standing rule: `main` measured 27.68
//     KiB against 27.8 KiB (0.12 KiB of headroom), and the change that follows
//     added +1.11 KiB. The growth is `validateOptions` checking every option it used
//     to skip — the switches, the customization hooks, `destinations` and its
//     hooks, and the `http` and `otel` groups — with messages that name the option
//     and the kind received. That is executable code and message strings, both of
//     which ship; it is not comment weight, which the build drops. The message
//     strings are the part worth keeping: they are what turns a config typo into
//     a located bootstrap error instead of a per-entry failure far from its cause.
//   - 2026-08-29 — server: 26.51 KiB real -> 27.8 KiB budget (~4.9% headroom).
//     RE-DERIVED from the artifact, per the standing rule. The growth is
//     `1.4.0`'s pre-routing access log: `applyAccessLog(app)`, the
//     `HttpAccessLogMiddleware` export, `LogContextService.runMerged`, and the
//     idempotency the first two require (`RequestIdMiddleware` enriches an open
//     scope instead of nesting one; the access log stands down on an
//     already-claimed request).
//     Checked before raising it, because the honest question is whether the
//     growth is bloat: it is not comment weight. The file-level docblock and the
//     inline `//` comments do NOT survive the build — grepping the bundle for
//     them returns zero — so trimming prose to fit was measured and moved the
//     artifact by 0.00 KiB. What ships is executable code plus the JSDoc on the
//     declarations, which is the deliberate policy in rule 1 above.
//     The gate was at 0.05 KiB of headroom before this change, which is why it
//     fired on the first real feature to land after it. That is the tripwire
//     working, not a budget being nudged: the number is recomputed from the
//     built artifact, not moved far enough to make the failure stop.
//   - 2026-08-16 — server: 24.19 KiB real -> 25.4 KiB budget (~5% headroom).
//     RE-DERIVED again, per the rule the entry below set: when the artifact moves
//     past the budget, recompute from the artifact rather than nudge the number.
//     The growth is the readiness contract earning its correctness across four
//     review rounds — level-aware delivery, identity so a destination is not its
//     own witness, write-failure tracking, and an in-flight counter so a pending
//     async write reads as unproven rather than as silent success. Each addition
//     closed a path that could DISCARD a boot entry nobody else held.
//     The policy those facts serve is the maintainer's, stated plainly: losing a
//     log line is unacceptable, duplicating one is the accepted cost. So the hook
//     discards only what is PROVEN delivered and emits everything else — which is
//     why the correctness of that single fact is worth this much code.
//   - 2026-08-15 — server: 22.80 KiB real -> 23.9 KiB budget (~4.8% headroom).
//     RE-DERIVED from the artifact, not nudged past it, and that distinction is
//     the entry. The two previous raises each moved the number just far enough to
//     admit the change in hand, which is how a tripwire turns into a rubber stamp:
//     by this release the gate had 0.01 KiB of headroom, so it no longer answered
//     "is this bloat?" — it answered "did anything at all change?".
//     Worse, it started deciding documentation. The 1.2.8 work exceeded 22.5, and
//     the first response was to cut three JSDoc blocks explaining why a drain had
//     moved between lifecycle hooks — trimming prose to satisfy a number, on a
//     library whose stated convention (rule 1 above) is that the bundle ships
//     unminified WITH its JSDoc because a readable trace inside a consumer's
//     node_modules outweighs a few KB. The trim was reverted and the text is back.
//     The growth itself is real surface for a measured defect: an optional
//     `ILogDestination.onRegistryReady`, the registry loop that calls it, a
//     `hasHealthySink` accessor, and the docs for all three. A pretty destination
//     registered beside another sink printed every buffered boot entry twice,
//     because it drained its buffer without being able to know that the fan-out
//     had already delivered those entries elsewhere.
//     Set from the real artifact plus ~5%, the same way the 2026-08-12 entry was.
//     If the next change needs this moved again, re-derive it again rather than
//     adding a fourth nudge — and if the artifact ever shrinks, tighten it.
//   - 2026-08-15 — server: 21.66 KiB real -> 22.5 KiB budget (~3.9% headroom).
//     SECOND raise in two days, which is worth naming rather than burying: the
//     tripwire has now moved twice for the same body of work, and a budget that
//     follows the code is not a budget. It is raised anyway because the +0.16 KiB
//     is a crash-prevention fix rather than feature surface — `safe-stdio.util.ts`,
//     which installs the swallow-EPIPE handler that the `try/catch` in three
//     already-shipped paths only CLAIMED to provide. Measured: a closed pipe gave
//     no synchronous throw, an asynchronous UNCAUGHT:EPIPE, and exit 42. Refusing
//     the 0.16 KiB would mean keeping a documented guarantee that does not exist.
//     Trimming was tried first and recovered EXACTLY ZERO: this module's JSDoc is
//     absent from the built `.mjs` (0 occurrences of its header text), so unlike
//     the 2026-08-14 entry the cost here is entirely code. Worth remembering the
//     next time comments are suspected — tsup does not preserve every comment, and
//     the assumption that it does is itself measurable.
//     If the next change also needs a raise, the right move is to question the
//     growth rather than the number.
//   - 2026-08-14 — server: 20.59 KiB real -> 21.5 KiB budget (~4.4% headroom).
//     This RE-TIGHTENS the deliberately-wide 18% headroom the entry below asked
//     to have re-tightened "once that lands and the artifact stops moving": the
//     artifact had already drifted 16.93 -> 19.13 KiB on `main` without the
//     budget moving, so the gate was down to 4.4% before this change even
//     started.
//     The +1.46 KiB over `main` is the destination init-failure fix: a shared
//     `DestinationHealth` record, the fan-out check that keeps a failed sink from
//     receiving writes, the stdout last-resort rescue, and one extracted stderr
//     reporter (which REPLACED a duplicated block, so it is close to neutral).
//     It buys back a defect where a single sink failing `onInit` left the whole
//     application writing nothing to either stream, silently — measured, not
//     argued. Per rule 1 the answer was NOT to minify; per rule 2 this is real
//     growth, so the tripwire moves with it.
//     Trimming the new comments first was tried and recovered 0.07 KiB, which is
//     the honest evidence that the cost here is code rather than prose.
//   - 2026-08-13 — server: 16.93 KiB real -> 20.0 KiB budget (~18% headroom).
//     Raised deliberately and with more headroom than the usual ~5%, by the
//     maintainer's decision. The 16.0 budget had 0.03 KiB left and the HTTP
//     observability fix took the artifact to 16.93 KiB, so the gate was blocking
//     a security fix rather than catching bloat: guard rejections (401/403/429)
//     and unmatched routes produced no log line at all, because logging was
//     interceptor-based and NestJS runs guards first. Closing that needs a
//     middleware, a `close` listener and URL sanitisation — none of which fit in
//     30 bytes. Per rule 1 the answer was NOT to minify.
//     The ~18% headroom is wider than the usual ~5% ON PURPOSE, to absorb the
//     follow-up already scoped (semconv `error.type` for delivery failure), and
//     it should be re-tightened to real + ~5% once that lands and the artifact
//     stops moving. A budget left this loose stops being a tripwire.
//   - 2026-08-12 — server: 15.29 KiB real -> 16.0 KiB budget (~4.6% headroom).
//     The +0.79 KiB over the prior 13.5 KiB is the P0 audit remediation, and it
//     is feature surface rather than bloat: the name-based redaction engine
//     (`redact-by-name.util.ts` — a recursive copy-on-write walk replacing 108
//     wildcard `fast-redact` paths, which made the shipped path ~50x faster and
//     removed the four-level nesting ceiling), the `redactStrategy` escape hatch
//     plumbed through options/validation/factory, the `assignIfDefined` guard
//     that stopped `undefined` reserved fields clobbering AsyncLocalStorage
//     context, and the two reserved keys that are now actually emitted
//     (`LOGGER_BOOTSTRAP_WARNING`, `LOGGER_SHUTDOWN_OK`). Per rule 1 above the
//     bundle ships unminified with its JSDoc, and that JSDoc is a meaningful
//     share of the delta — the new util documents the measurements behind the
//     engine change at the seam where a future reader would otherwise undo it.
//     Walked across the reviews of that same change: 15.0 at first; 15.5 once
//     the code review added `withoutOwnedKeys` (restoring the reserved-field
//     invariant), split `walkArray` out to stay inside the nesting limit, and
//     made `RESERVED_LOG_KEYS_NOT_EMITTED` public; back to 15.25 when dropping
//     four redundant Stryker suppressions returned 0.28 KiB. Then to 16.25 for
//     the PR-review remediation, which closed three verified leaks the first
//     design had: child bindings (redacted in `PinoLoggerService.child()`,
//     because Pino pre-serializes them past every formatter), `Error` values
//     under a key with no serializer (cloned through prototype + descriptors so
//     they stay Errors), and secrets synthesized by `toJSON()` (its output is
//     now walked). Plus a `mixinMergeStrategy` so a hostile getter cannot crash
//     the log call ahead of the fail-closed envelope. Per rule 2, retighten when
//     the artifact shrinks — this one grew, and every kilobyte of it is a leak
//     that used to be open.
//   - 2026-06-16 — server: 12.84 KiB real -> 13.5 KiB budget (~5% headroom).
//     The +0.34 KiB over the prior 12.5 KiB is legitimate audit-hardening
//     surface — fail-soft destination containment, query-string stripping in the
//     exception filter, AggregateError width capping, the request-id generation
//     toggle, and the JSDoc that ships unminified alongside it — not bloat.
//   - 2026-05-30 — server: 12.05 KiB real -> 12.5 KiB budget (~4% headroom).
//     The +0.3 KiB over the original 12 KiB is legitimate feature surface
//     (pretty / registry / multistream / truncation / child-logger / async-HTTP),
//     not bloat.
//   - 2026-05-30 — shared: 0.34 KiB real -> 1.0 KiB budget (was 3.5 KiB — 10x
//     headroom defeats bloat detection; 1.0 KiB still absorbs years of
//     constant/type growth while catching a real regression).
const BUDGETS = [
  { name: 'server (NestJS module)', path: 'dist/server/index.mjs', brotli: 49_456 },
  { name: 'shared (types + constants)', path: 'dist/shared/index.mjs', brotli: 1.0 * 1024 },
  {
    name: 'observability (metrics + health)',
    path: 'dist/observability/index.mjs',
    brotli: 1_331
  }
]

const fmt = (n) => `${(n / 1024).toFixed(2)} kB`

const BROTLI_OPTS = {
  params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY }
}

let failed = 0
const rows = []

for (const { name, path, brotli: limit } of BUDGETS) {
  const abs = resolve(ROOT, path)
  // Read straight away rather than testing for the file first. A `statSync`
  // followed by `readFileSync` states a fact about the past: the file can be
  // gone, replaced, or truncated between the two calls. `readFileSync` already
  // fails when the artifact is missing, so one call reports the same thing
  // without the window.
  let raw
  try {
    raw = readFileSync(abs)
  } catch (error) {
    // Only a missing file earns the friendly message. A permission error or a
    // directory where a file belongs is a different problem, and reporting it as
    // "run pnpm build" sends the reader to the wrong place — rethrow so the real
    // code and stack reach the log.
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') throw error
    console.error(`Missing build artifact: ${path} — run \`pnpm build\` first.`)
    process.exit(2)
  }
  const compressed = brotliCompressSync(raw, BROTLI_OPTS).length
  const ok = compressed <= limit
  if (!ok) failed += 1
  rows.push({
    name,
    raw: raw.length,
    brotli: compressed,
    limit,
    delta: compressed - limit,
    ok
  })
}

const pad = (s, n) => String(s).padEnd(n)
const padL = (s, n) => String(s).padStart(n)

console.log('')
console.log(
  `  ${pad('Subpath', 38)}${padL('Raw', 12)}${padL('Brotli', 12)}${padL('Budget', 12)}  Status`
)
console.log(`  ${'-'.repeat(38)}${'-'.repeat(12)}${'-'.repeat(12)}${'-'.repeat(12)}  ------`)
for (const r of rows) {
  const status = r.ok ? 'PASS' : `FAIL +${fmt(r.delta)}`
  console.log(
    `  ${pad(r.name, 38)}${padL(fmt(r.raw), 12)}${padL(fmt(r.brotli), 12)}${padL(fmt(r.limit), 12)}  ${status}`
  )
}
console.log('')

if (failed > 0) {
  console.error(`${failed} subpath(s) exceeded the brotli budget.`)
  process.exit(1)
}
