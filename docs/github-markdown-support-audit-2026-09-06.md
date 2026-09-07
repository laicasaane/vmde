# GitHub Markdown support audit — 2026-09-06

VMDE has broad Markdown support, but does not cover every GitHub syntax and visual-editing
behavior. Twelve unowned gaps now have individual tasks, 551–562. Task 550 remains the owner
of reference-style hyperlink presentation and activation; it was not duplicated or changed.

## Baseline and limits

The official [GFM specification](https://github.github.com/gfm/) currently identifies itself as
**0.29-gfm (2019-04-06)**. That specification and GitHub.com's current product features are
separate baselines. This audit also consulted GitHub's current
[basic syntax documentation](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax),
[math documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/writing-mathematical-expressions),
[diagram documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams),
[table documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-tables),
[collapsed-section documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/organizing-information-with-collapsed-sections),
[responsive-image quickstart](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/quickstart-for-writing-on-github), and
[autolink documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/autolinked-references-and-urls).
All were checked on the audit date. GitHub Pages/Jekyll dialects are not this baseline.

Evidence: current source, open/done/parked task records, and small Node VM probes of the tracked
Lute blob. The pin is `8928f1866da3269aed613288afb3554985df94e1`, recorded in
[its manifest](../media-src/vendor/lute/source.json). Probes inspected HTML and editor DOM;
HTML-specific probes also enabled sanitization. They are not full Vditor initialization or
real-webview tests. One initial probe failed because an unnecessary `global` binding triggered
a missing `require`; rerunning with the host's sandbox shape succeeded.

No full GFM conformance corpus, build, quality gate, Chromium run, real-VS-Code run, or VSIX
verification was performed, as requested. “Present” below means implementation/engine evidence,
not a claim that all grammar edge cases or mode interactions passed. Renderer versions and
LaTeX macro coverage are not guaranteed identical to GitHub.

## Core syntax and existing ownership

| Syntax family | Finding | Current evidence / task owner |
| --- | --- | --- |
| ATX and Setext headings | Present | Small Lute probe emits H1/H2; heading navigation uses the shared slugger. |
| Paragraphs, blank lines, soft/hard breaks | Present, configurable behavior | Probe recognizes paragraphs and both hard-break forms. Lute's bare default emits soft BRs; VMDE's Task 83 owns the configured behavior. |
| Thematic breaks | Present | Probe emits HR; completed task `100-hr-create-and-arrow-nav`. |
| Blockquotes, ordered/unordered/nested lists | Present | Probe emits the expected container structure; existing editor implementations and specs. |
| Indented/fenced code and inline code | Present | Probe covers indentation, tilde fence, info string and code span; existing highlighting pipeline. |
| Emphasis, strong emphasis, strikethrough | Present | Probe emits EM/STRONG and DEL for single/double tilde. Task 225 intentionally changes single tilde to subscript only when its optional extension is enabled. |
| Backslash escapes and character references | Present | Probe preserves literal escaped punctuation and entity semantics. No exhaustive grammar claim. |
| Inline links, URL/email autolinks, relative links | Present | Probe resolves URL/www/email; host classifier includes mailto/tel and file routes. Tasks 32/297 own authoring improvements. |
| Reference-style hyperlinks and definitions | Partial visual editing; already owned | [550](../tasks/550-reference-style-link-editing.md); completed [240](../tasks/done/240-reference-link-title-corruption.md) handles title fidelity. Task 542's split-source route exists in `sv-source-link.ts`. |
| Inline and reference-style images | Rendering present; reference refresh incomplete | Probe renders a reference IMG. New Task 562 owns the explicit watcher exclusion; Task 550 is hyperlink-only. |
| GFM tables and task-list items | Present | Probe emits aligned table cells and checked/unchecked inputs; existing table/list implementation. |
| Raw HTML blocks/inlines and tag filtering | Partial across modes | Safe block HTML has a preview path; inline tag pairs can remain escaped source nodes. New Tasks 553–557 cover the documented constructs below. [47](../tasks/47-render-inline-html-data-uri-images.md) already owns raw IMG/data-URI investigation; do not duplicate it. GitHub does not support arbitrary executable HTML. |
| Footnotes | Rendering present | Probe emits references, definitions and back links; Vditor enables footnotes. Task 210 owns richer hover behavior. Navigation edge cases were not exercised. |
| Emoji shortcodes | Present | Probe resolves `:smile:`; Vditor supplies emoji configuration. Complete current GitHub shortcode inventory was not compared. |
| Alerts | Present | Completed Tasks 106 and 527 own rendering/authoring. See `media-src/src/editing/callouts.ts`; no browser retest. |
| HTML comments | Present with deliberate editor behavior | Probe hides comments in HTML. Completed Task 367 and `html-comment.ts` own the editor-specific handling. |
| Dollar inline and dollar-dollar block math | Present | Probe emits math nodes; existing KaTeX renderer. Additional GitHub delimiters/layout gaps are Tasks 551/552. |
| Mermaid, GeoJSON, TopoJSON, ASCII STL fences | Present | Existing diagram adapters; completed Tasks 99 and `100-ascii-stl-3d`. No new syntax tasks needed. |
| Details/summary | Present | Completed Tasks 257, 533 and 545; open/closed behavior already has task ownership. |
| Heading fragment links | Implementation present; tracker header stale | [243](../tasks/243-anchor-links-heading-ids.md) still says planned, but `same-doc-anchor.ts`, shared slugger and its own later notes show implementation. Non-heading HTML named anchors are a distinct gap, Task 556. |

The basic-formatting and raw-HTML findings concern semantic presentation in visual editing,
not a claim that the engine cannot parse those constructs. Generic HTML, obscure delimiter
precedence, malformed-input recovery and exact round-trip conformance remain unexhaustively
checked under this session's minimum-validation constraint.

## New tasks — one syntax per task

| Task | Syntax | Gap |
| --- | --- | --- |
| [551](../tasks/551-github-backtick-inline-math.md) | Dollar/backtick inline math | Backticks reach the math renderer as expression content. |
| [552](../tasks/552-github-fenced-math-display.md) | Fenced `math` | CODE elements receive inline rather than display layout. |
| [553](../tasks/done/553-html-subscript-editing.md) | HTML SUB | Escaped tags instead of semantic subscript in visual edit DOM. |
| [554](../tasks/554-html-superscript-editing.md) | HTML SUP | Escaped tags instead of semantic superscript in visual edit DOM. |
| [555](../tasks/555-html-underline-editing.md) | HTML INS | Escaped tags instead of semantic underline in visual edit DOM. |
| [556](../tasks/556-html-named-anchor-navigation.md) | HTML named anchor | Current fragment route searches headings only. |
| [557](../tasks/557-inline-picture-editing.md) | Inline PICTURE | Inline form lacks a visual preview; multiline block form already has one. |
| [558](../tasks/558-github-mentions.md) | Person/team mentions | No GitHub mention resolver. Optional platform enrichment. |
| [559](../tasks/559-github-commit-references.md) | Commit references | No contextual SHA resolver. Optional platform enrichment. |
| [560](../tasks/560-github-inline-color-literals.md) | Inline color literals | No swatches. Optional conversation enrichment. |
| [561](../tasks/561-github-label-references.md) | Label URLs | Ordinary links only. Optional repository-context enrichment. |
| [562](../tasks/562-reference-style-image-refresh.md) | Reference-style images | Local asset watcher deliberately does not resolve definitions. |

Each task includes evidence, existing-owner distinctions, narrow scope, and future verification
criteria. The eight document/editor tasks and four platform-enrichment tasks are all TODO.
Creating a task does not enable the feature or approve automatic network access.

## GitHub platform features and exclusions

Issue/PR reference enrichment and custom tracker autolinks already belong to
[Task 228](../tasks/228-issue-tracker-links.md); no duplicate was created. Its configurable
patterns can own qualified issue references as well as simple ticket identifiers.
GitHub documents that issue/PR autolink references are not created in repository files or
wikis; color chips are likewise limited to conversation surfaces. The four optional tasks
above must not silently change ordinary Markdown-file defaults.

Uploads, notifications, backlinks between GitHub issues, API-fetched issue status, comment
editing shortcuts, and GitHub's surrounding outline UI are platform workflows rather than
missing Markdown grammar. No syntax tasks were created for those workflows. GitHub's
[tasklist documentation](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/about-tasklists)
says special tasklist blocks are retired; ordinary checkbox list syntax remains supported.

Non-GitHub extensions such as wiki links, definition lists, CriticMarkup and heading `{#id}`
are not missing GFM features merely because they are optional or unsupported in VMDE.

## Session handoff

Only this audit and Tasks 551–562 were added. Task 550, existing task statuses,
`tasks/README.md`, `LOCAL_AGENT_TASK.md`, source files and generated artifacts were left alone.
The repository rule limits index updates to completed tasks, so links to these TODO tasks
live in this audit. Minimum validation checks unique new IDs, local Markdown links,
TODO checklist state, whitespace and final working-tree scope. Implementation and future
editor verification remain open in each task.

## Follow-up — toolbar authoring requirements

Tasks 550–562 now each record a toolbar decision and verification requirements, based on
`media-src/src/chrome/toolbar.ts` and the shared formatting-command conventions.

| Tasks | Toolbar requirement |
| --- | --- |
| 550 | Extend existing Link action for editing a reference and its definition. |
| 551–552 | Shared More → Math menu with Inline math (GitHub) and Math block actions. |
| 553–555 | Subscript, Superscript and Underline toggles under More, emitting HTML. |
| 556 | Insert anchor under More; existing Link points to it. |
| 557 | Insert picture under More with fallback/alt and optional dark/light sources. |
| 558–559 | No new control; typed/pasted references and configured GitHub context. |
| 560 | Reuse Inline code; swatches are automatic. |
| 561 | Reuse URL paste/Link; label enrichment is automatic where eligible. |
| 562 | No control; referenced-image refresh is automatic. |

These are future implementation requirements, not implemented toolbar changes. The follow-up
changes Task 550 as explicitly requested; the earlier session-handoff statement describes the
initial audit only. All task statuses remain open, with minimum documentation validation only.
