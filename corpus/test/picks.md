# Test set: 25 example PRs

A diverse subset of the full set chosen to demonstrate the breadth of repos, languages, change shapes, and golden-finding categories. Each PR has at least one notable TP finding. (Golden findings in this corpus are graded `low` / `medium` / `high`.)

## Overall stats

- **Total**: 25 PRs
- **PRs with ≥1 high TP finding**: 14
- **PRs with ≥1 security TP finding**: 8

**Languages**: TypeScript (5), Python (4), C# (3), Go (3), Rust (2), JavaScript (1), Shell (1), Kotlin (1), Java (1), Jupyter Notebook (1), Swift (1), PHP (1), Ruby (1)

**PR size**: xs (<50): 3, s (50-200): 5, m (200-500): 5, l (500-1500): 5, xl (>1500): 7

**Repo size**: <1MB: 7, 1-10MB: 10, 10-100MB: 7, >100MB: 1

**Finding categories represented** (PR count): correctness (21), reliability (19), maintainability (18), testing (16), documentation (12), api-architecture (8), security (8), performance (8), accessibility (2)

## Picks

### Tier A — ≥1 high TP finding (14)

#### [PierreJanineh/TechDebtMCP#135](https://github.com/PierreJanineh/TechDebtMCP/pull/135)
- **Lang/size**: TypeScript · xs (<50) · repo <1MB
- **Title**: fix: guard against ReDoS via user-controlled regex in custom rules engine
- **TP findings**: 9 (high:1 med:2 low:6) — categories: api-architecture,correctness,documentation,maintainability,reliability,security,testing
- **Why included**: 3-line PR claiming to fix ReDoS — review surfaces an unrelated **path traversal** in the same handler (user-supplied `path` flows into `readFile` without `path.isAbsolute`/normalize). Tiny diff, big find.
- **Golden file**: `golden/PierreJanineh_TechDebtMCP_135-16a54f0f.json`

#### [simnaut/emdash#2](https://github.com/simnaut/emdash/pull/2)
- **Lang/size**: TypeScript · xl (>1500) · repo 10-100MB
- **Title**: feat: pluggable auth providers — add AT Protocol, refactor GitHub/Google
- **TP findings**: 6 (high:3 med:0 low:3) — categories: correctness,reliability,security
- **Why included**: Three independent **high/correctness** findings rooted in the same OAuth bug: AT Protocol routes use `url.origin` (internal request origin) instead of `getPublicOrigin()`, so the OAuth `client_id`/`redirect_uri` mismatches behind a TLS-terminating proxy. Demonstrates root-cause clustering across files.
- **Golden file**: `golden/simnaut_emdash_2-41d75006.json`

#### [konturio/disaster-ninja-fe#1230](https://github.com/konturio/disaster-ninja-fe/pull/1230)
- **Lang/size**: TypeScript · s (50-200) · repo >100MB
- **Title**: fix(map): allow Kontur basemap switching
- **TP findings**: 13 (high:1 med:6 low:6) — categories: correctness,reliability,testing
- **Why included**: 76-line PR in a 600MB monorepo. Calls `layer('disable')` / `layer('enable')` — invalid Reatom v2 API; correct form is `store.dispatch([layer.disable()])`. Plus `setStyle` waiting on the wrong event. Showcases framework-API knowledge in a large codebase.
- **Golden file**: `golden/konturio_disaster-ninja-fe_1230-d169e9da.json`

#### [cmik/apilix#12](https://github.com/cmik/apilix/pull/12)
- **Lang/size**: TypeScript · xl (>1500) · repo 1-10MB
- **Title**: implement data storages
- **TP findings**: 36 (high:11 med:13 low:12) — categories: accessibility,correctness,documentation,maintainability,performance,reliability,security
- **Why included**: Multiple **high/security** findings: arbitrary `dataDir` taken from request body so any caller can `git init` anywhere, and a path-traversal guard missing the trailing separator (`/data/foo` matches `/data/foo-evil`). Classic well-explained sec review.
- **Golden file**: `golden/cmik_apilix_12-0c34439a.json`

#### [AA-Factory/aafactory-prototype#17](https://github.com/AA-Factory/aafactory-prototype/pull/17)
- **Lang/size**: Python · xs (<50) · repo 1-10MB
- **Title**: Mock test single avatar interaction with elevenlabs and zonos
- **TP findings**: 9 (high:3 med:3 low:3) — categories: maintainability,reliability,testing
- **Why included**: 45-line test PR with three high-severity findings: pytest-mock/asyncio missing from `pyproject.toml`; the test never actually invokes the function under test; and the `mocker.patch` target string misses a top-level import binding so the patch never applies. Excellent pytest pitfalls showcase.
- **Golden file**: `golden/AA-Factory_aafactory-prototype_17-a1978cb7.json`

#### [DisciplinedSoftware/Codebase-Conversion#1](https://github.com/DisciplinedSoftware/Codebase-Conversion/pull/1)
- **Lang/size**: Python · xl (>1500) · repo <1MB
- **Title**: Fortran-to-Rust conversion pipeline with devcontainer
- **TP findings**: 31 (high:2 med:15 low:14) — categories: correctness,documentation,maintainability,reliability,security
- **Why included**: Fortran→Rust pipeline filters out lines starting with `/*` to remove f2c headers — but f2c also emits the function prototype as `/* Subroutine */ int dgemm_(...)`, which gets stripped, breaking every conversion. Reviewer actually understood the data.
- **Golden file**: `golden/DisciplinedSoftware_Codebase-Conversion_1-4b46d68c.json`

#### [brianc/node-postgres#3650](https://github.com/brianc/node-postgres/pull/3650)
- **Lang/size**: JavaScript · l (500-1500) · repo 1-10MB
- **Title**: Add diagnostics_channel TracingChannel support
- **TP findings**: 11 (high:1 med:4 low:6) — categories: correctness,maintainability,performance,reliability,testing
- **Why included**: New `diagnostics_channel` tracing imports `./diagnostics` from `pg-pool`, but `packages/pg-pool/package.json#files` still only ships `index.js` and `esm/`. Tests pass locally; the published tarball would crash on require. Classic publish-config regression.
- **Golden file**: `golden/brianc_node-postgres_3650-b922f0dd.json`

#### [brexhq/CrabTrap#15](https://github.com/brexhq/CrabTrap/pull/15)
- **Lang/size**: Go · m (200-500) · repo 1-10MB
- **Title**: fix: lighten audit log list responses
- **TP findings**: 16 (high:1 med:6 low:9) — categories: correctness,maintainability,performance,reliability,testing
- **Why included**: `query` method creates `context.Background()` and ignores the request context — sibling method `Count` does it correctly. Cancellation/deadline propagation broken. Classic Go context pitfall, well demonstrated.
- **Golden file**: `golden/brexhq_CrabTrap_15-5ef0884c.json`

#### [k1LoW/gh-copilot-review#9](https://github.com/k1LoW/gh-copilot-review/pull/9)
- **Lang/size**: Go · s (50-200) · repo <1MB
- **Title**: feat: skip Copilot review request when existing review is newer than last commit
- **TP findings**: 7 (high:1 med:4 low:2) — categories: correctness,performance
- **Why included**: 68-line PR. Freshness check runs after `MinimizeCopilotComments`, which already minimized the current Copilot review. Net effect: the fresh review gets hidden as OUTDATED and no replacement is requested. Subtle ordering bug, very small diff.
- **Golden file**: `golden/k1LoW_gh-copilot-review_9-f9828193.json`

#### [scotthamilton77/agents-config#1](https://github.com/scotthamilton77/agents-config/pull/1)
- **Lang/size**: Shell · l (500-1500) · repo 10-100MB
- **Title**: feat: multi-tool install support (Claude, Codex, Gemini)
- **TP findings**: 25 (high:3 med:6 low:16) — categories: correctness,documentation,reliability
- **Why included**: Templates use Claude Code's `@filename` file-inclusion syntax inside `.codex/AGENTS.md` and `.gemini/GEMINI.md` — but Codex CLI and Gemini CLI don't support it; those references are treated as literal text. Cross-product ecosystem knowledge.
- **Golden file**: `golden/scotthamilton77_agents-config_1-1fc78970.json`

#### [ardevd/jadx-collaboration#3](https://github.com/ardevd/jadx-collaboration/pull/3)
- **Lang/size**: Kotlin · s (50-200) · repo <1MB
- **Title**: perf: serialize pull/push on a shared background executor; guard invokeAndWait e
- **TP findings**: 9 (high:4 med:1 low:4) — categories: correctness,reliability,testing
- **Why included**: PR description promises 'shared single-thread executor to serialize pull/push' — actual code still uses `kotlin.concurrent.thread` for all four entry points, spawning unconstrained threads. Reviewer caught that **the PR doesn't do what it says it does**.
- **Golden file**: `golden/ardevd_jadx-collaboration_3-853179dc.json`

#### [AY2526S2-CS2103T-W14-3/tp#152](https://github.com/AY2526S2-CS2103T-W14-3/tp/pull/152)
- **Lang/size**: Java · m (200-500) · repo 10-100MB
- **Title**:  Implement Global Date Notes
- **TP findings**: 14 (high:2 med:2 low:10) — categories: api-architecture,correctness,documentation,maintainability,reliability,testing
- **Why included**: `DeleteNoteCommand.execute()` is a stub that returns 'Delete note request received' but never calls any model operation — the note isn't deleted. Plus `Model` interface has no `removeNote()` method, so even fixing the command body wouldn't connect. Classic 'tests pass, feature doesn't exist'.
- **Golden file**: `golden/AY2526S2-CS2103T-W14-3_tp_152-e0a9ce03.json`

#### [vanyastaff/nebula#224](https://github.com/vanyastaff/nebula/pull/224)
- **Lang/size**: Rust · xl (>1500) · repo 10-100MB
- **Title**: feat(credential): v3 universal schemes, key rotation, security hardening
- **TP findings**: 9 (high:1 med:3 low:5) — categories: api-architecture,correctness,documentation,maintainability,security
- **Why included**: `EncryptionLayer::with_keys()` doesn't register the empty-string key alias that `new()` does — but `encrypt()` produces `EncryptedData{key_id: ""}`, so any record encrypted via the public API can't be decrypted by a layer constructed from `with_keys`. Subtle API-symmetry break.
- **Golden file**: `golden/vanyastaff_nebula_224-d5ba86dd.json`

#### [NCATSTranslator/translator-ingests#336](https://github.com/NCATSTranslator/translator-ingests/pull/336)
- **Lang/size**: Jupyter Notebook · l (500-1500) · repo 10-100MB
- **Title**: Addressing Matt's QA on gtopdb
- **TP findings**: 17 (high:2 med:6 low:9) — categories: correctness,documentation,maintainability
- **Why included**: `break` is used inside `for record in data:` to mean 'skip this record' — but `break` exits the whole loop, so the first 'not applicable' record terminates processing of all remaining records. Plus a `'Agnoist'` typo (vs `'Agonist'`) silently routing records to a default branch. Two very human bugs.
- **Golden file**: `golden/NCATSTranslator_translator-ingests_336-efb31e9c.json`

### Tier B — medium TP finding (no high) (11)

#### [PaulStSmith/figlet-comment-generator#32](https://github.com/PaulStSmith/figlet-comment-generator/pull/32)
- **Lang/size**: C# · m (200-500) · repo 1-10MB
- **Title**: BugFix: Link to Issues not working on VSCode
- **TP findings**: 9 (high:0 med:7 low:2) — categories: correctness,documentation,maintainability,reliability
- **Why included**: Several publish-workflow path filters were narrowed to source files only, so version bumps and release assets in `.csproj`, `package.json`, manifests, and resources can silently skip publishing. The extension also stopped replacing selected text when inserting a banner. Multiple concrete regressions in a small PR.
- **Golden file**: `golden/PaulStSmith_figlet-comment-generator_32-1d0b6642.json`

#### [mheuss/chronicle#14](https://github.com/mheuss/chronicle/pull/14)
- **Lang/size**: Rust · xl (>1500) · repo <1MB
- **Title**: feat(storage): storage & data security hardening (HEU-405)
- **TP findings**: 10 (high:0 med:1 low:9) — categories: maintainability,reliability,security,testing
- **Why included**: `harden_file` cleanup attempts to delete the new HEIF on failure, but if `delete_file()` *also* fails the original file is gone and the new one is orphaned. Plus best-effort `walk_files_recursive` swallows errors. Storage-hardening review with realistic failure modes.
- **Golden file**: `golden/mheuss_chronicle_14-04ac4c02.json`

#### [superhighfives/pika#200](https://github.com/superhighfives/pika/pull/200)
- **Lang/size**: Swift · xl (>1500) · repo 1-10MB
- **Title**: Persistent named palettes with tabbed drawer, export, and UX polish
- **TP findings**: 19 (high:0 med:8 low:11) — categories: correctness,maintainability,performance,reliability,testing
- **Why included**: `swap()` calls `pushUndo()` unconditionally before checking `activePaletteIndex`; `deletePalette` doesn't decrement `activePaletteIndex` when removing a palette below the active one (only the out-of-range case is clamped). Index-bookkeeping correctness, in Swift.
- **Golden file**: `golden/superhighfives_pika_200-b227aff0.json`

#### [gagneurlab/PROTRIDER#10](https://github.com/gagneurlab/PROTRIDER/pull/10)
- **Lang/size**: Python · xl (>1500) · repo <1MB
- **Title**: Fix two reviewer-flagged issues: invalid parquet arg & checkpoint opt-in
- **TP findings**: 21 (high:0 med:10 low:11) — categories: api-architecture,correctness,documentation,maintainability,testing
- **Why included**: `auc_prec_rec = np.nan` is set in the non-finite-loss branch but `return auprc` is unconditional — first non-finite training loss raises `NameError`. Plus a binary-search interval bug where after 'shrink the interval' updates `L,fL,R,fR`, control falls through to the next branch which uses the stale boundaries.
- **Golden file**: `golden/gagneurlab_PROTRIDER_10-b462b109.json`

#### [allan-mobley-jr/gimmes#468](https://github.com/allan-mobley-jr/gimmes/pull/468)
- **Lang/size**: Python · s (50-200) · repo 1-10MB
- **Title**: Fix staleness filter for NO variance strategy
- **TP findings**: 6 (high:0 med:3 low:3) — categories: api-architecture,correctness,documentation,maintainability,testing
- **Why included**: `check_staleness` is called without the new `volume_floor` parameter so it silently uses the hardcoded default of 10. Plus a fallback that uses lifetime cumulative `volume` when `volume_24h` is zero — recently-low-volume tokens get judged on all-time numbers.
- **Golden file**: `golden/allan-mobley-jr_gimmes_468-e1477f8b.json`

#### [superyyrrzz/ForgeMap#106](https://github.com/superyyrrzz/ForgeMap/pull/106)
- **Lang/size**: C# · m (200-500) · repo <1MB
- **Title**: docs: add custom Blacksmith's Forge theme for DocFX site
- **TP findings**: 15 (high:0 med:7 low:8) — categories: accessibility,maintainability,performance,reliability
- **Why included**: `cancel-in-progress: true` on the Pages deployment job means a new push to `main` cancels an in-flight deploy. Plus dark-mode CSS missing the `[data-bs-theme="dark"] pre code` override that light-mode explicitly sets, leaving code blocks unstyled in the dark theme.
- **Golden file**: `golden/superyyrrzz_ForgeMap_106-2f3977ed.json`

#### [renedierking/LANdalf#88](https://github.com/renedierking/LANdalf/pull/88)
- **Lang/size**: C# · xs (<50) · repo 1-10MB
- **Title**: Add ping utilities
- **TP findings**: 6 (high:0 med:4 low:2) — categories: correctness,documentation,reliability,testing
- **Why included**: `OperationCanceledException` is swallowed by a generic `catch (Exception ex)` so the cancellation token's signal is lost. Separately: installing `iputils-ping` doesn't help — .NET's `Ping.SendPingAsync` creates raw ICMP sockets which need `CAP_NET_RAW`/root anyway.
- **Golden file**: `golden/renedierking_LANdalf_88-bc1698f4.json`

#### [scottlz0310/Mcp-Docker#29](https://github.com/scottlz0310/Mcp-Docker/pull/29)
- **Lang/size**: Go · l (500-1500) · repo 1-10MB
- **Title**: Phase1: copilot-review-mcp OAuth Facade (ISSUE#28)
- **TP findings**: 22 (high:0 med:12 low:10) — categories: api-architecture,correctness,maintainability,reliability,security,testing
- **Why included**: OAuth Facade with three security gaps: PKCE only verified when `sess.CodeChallenge != ""` but `/authorize` never requires it, so attackers can elide PKCE entirely; `/token` performs no `client_id` validation; and the in-memory sessions map has no upper bound so any unauthenticated caller can flood `/authorize` to OOM. Multi-finding OAuth audit.
- **Golden file**: `golden/scottlz0310_Mcp-Docker_29-e7705d26.json`

#### [wirechat/wirechat#183](https://github.com/wirechat/wirechat/pull/183)
- **Lang/size**: PHP · l (500-1500) · repo 10-100MB
- **Title**: Harden chat/chats scroll state and pagination concurrency in Livewire UI
- **TP findings**: 12 (high:0 med:4 low:8) — categories: api-architecture,correctness,maintainability,performance,reliability,testing
- **Why included**: `loadOlderWithStableScroll` has no `finally` block, so if the await throws, `loadingOlder` and `pendingPrependRestore` stay true — chat lockout. Separately, `pushMessage` runs `syncCanLoadFlags` after every appended message, which itself runs two `EXISTS` queries — N+1 on hot path.
- **Golden file**: `golden/wirechat_wirechat_183-6e3156e7.json`

#### [sdsykes/fastimage#165](https://github.com/sdsykes/fastimage/pull/165)
- **Lang/size**: Ruby · m (200-500) · repo 10-100MB
- **Title**: Add resolution support for image formats (JPEG, TIFF, PNG, BMP) along with unit 
- **TP findings**: 14 (high:0 med:3 low:11) — categories: api-architecture,correctness,documentation,maintainability,performance,reliability,testing
- **Why included**: Gemspec still declares `required_ruby_version >= 1.9.2` but new code uses 2.0+ keyword-argument syntax in `exif.rb` and 2.3+ safe-navigation `&.` in `jpeg.rb` — straight syntax error on supported Rubies. Library compatibility scope mismatch.
- **Golden file**: `golden/sdsykes_fastimage_165-8fc7cd32.json`

#### [Marvell-Consulting/statswales-frontend#626](https://github.com/Marvell-Consulting/statswales-frontend/pull/626)
- **Lang/size**: TypeScript · s (50-200) · repo 1-10MB
- **Title**: SW-1226: Fix download language selector
- **TP findings**: 6 (high:0 med:4 low:2) — categories: security,testing
- **Why included**: `language` query param typed as `string` and cast to `Locale` (`as Locale`) without any runtime validation, then flows through three GET handlers (`downloadPublishedData`, `downloadDatasetPreview`, etc.) into `download_language` keys. Classic 'TypeScript types are erased' security pitfall.
- **Golden file**: `golden/Marvell-Consulting_statswales-frontend_626-30ba27a5.json`
