# Implementation status against Functional Specification v1.8

This covers version 0.1.0, the first implementation pass. **Tested** means covered by `npm test`, which runs Node with an in-memory IndexedDB and stubbed providers. **Unverified in browser** means the code exists but has not yet been run in Brave or Chrome.

## Done

| Area | Spec | Where | Status |
|---|---|---|---|
| Run state machine, §5.3 table, rejected transitions logged | §5.2–5.3, FR-031–034 | `core/state-machine.js`, `background/orchestrator.js` | Tested |
| Global and conversation locks; waiting for lock; Stop → USER_STOPPED or ABANDONED with reason | §5.4, §11.1, FR-047–050, FR-094, FR-097–098 | same | Tested |
| Retry from FAILED and resume from INTERRUPTED via PREFLIGHT | FR-033, FR-089 | `orchestrator.js` | Tested |
| Restart recovery: RUNNING → INTERRUPTED, ops classified, no auto-resume, UNKNOWN needs approval | §5.6, FR-044–046 | `recoverOnStartup`, `resume` | Tested |
| Iteration counting, closing review, limit 0–10 | §2.1, FR-009, FR-026, FR-095 | `stepReview` | Tested |
| Finding IDs, `oneOf` entries, immutable fields, severity/material rules, downgrade reason, reopen | §3.1–3.5, FR-013–019, FR-086–087, FR-090 | `core/findings.js` | Tested |
| Omission check with one corrective retry | §3.6, FR-016–017 | `findings.js`, `callWithCorrective` | Tested |
| Completion authority; mismatched R.status is logged | §3.7, FR-021 | `findings.js` | Tested |
| G refinement decisions (exactly one per open finding) | §3.8, FR-022–024 | `core/protocol.js` | Tested |
| Strict JSON with no fence stripping or repair; one corrective retry | §3.10, FR-029–030 | `protocol.js` | Tested |
| Cross-cycle carry-in | §2.2, FR-025, FR-091 | `findings.js` | Tested |
| Context priority, protected findings compacted but never removed, CONTEXT_LIMIT_EXCEEDED | §7.1, FR-066–068 | `core/context.js` | Tested |
| Untrusted-content delimiting | §7.2, FR-065 | `context.js` | Tested |
| Budget reserve (G + following R) before every G; missing pricing gives three choices; costs are estimates or "Not available" | §9.1–9.5, FR-027–028, FR-077–084 | `core/budget.js`, orchestrator | Tested |
| Built-in default prices (dated, with long-context tiers and scheduled changes); a user override wins | §6.1 pricing metadata, §9.4 | `providers/pricing.js` | Tested. Prices checked 2026-11-21; they need updating when providers change prices. |
| Streaming timeouts: 30 s headers, 180 s first content, 60 s inactivity; reasoning resets timers; pings don't | §10, FR-036–038 | `providers/transport.js` | Tested with a stubbed stream |
| Reasoning content never kept (liveness signal only) | §10.1, FR-092–093 | adapters, transport | Tested |
| Keys session-only, masked, redacted from errors | §6.3, FR-005–006 | `storage/settings.js`, `redact` | Tested (redaction) |
| Vendor separation and pre-flight (auth, connectivity, model, capability, pricing, disclosure) | §6, FR-003–008 | `preflight` | Tested (vendor check) |
| Per-provider disclosure acknowledgement | §7.3, FR-069, FR-096 | settings and UI | Unverified in browser |
| Context sent stored per operation and viewable in the timeline | FR-071 | `providerCall`, side panel | Unverified in browser |
| Image attachments as assets with SHA-256, sent to R as bytes | §8, FR-072, FR-076 | `submitPrompt`, adapters | Unverified in browser |
| ZIP export with `conversation.json`, `memory.json`, `metadata.json`, `assets/` | §15, FR-055, FR-057 | `export/` | Tested |
| Notifications when the panel is closed; side panel or tab fallback; badge fallback | §11.2, FR-051 | `service-worker.js`, `compat/browser.js` | Unverified in browser |
| One package for both browsers; static compatibility check | §16.2, FR-101–104, AC-49 | `tools/package.mjs`, `tools/check-compat.mjs` | Done |
| Side panel: config, run controls, result, labels, findings, history, timeline, usage, recovery, settings | §12 | `sidepanel/` | Unverified in browser |

## Added beyond spec v1.8: web search (live information)

The product owner approved this on 2026-11-21. Spec v1.8 has no tools. A spec amendment should record:

| Decision | Implementation |
|---|---|
| Use each provider's built-in, server-run web search (no PeerMind-run tools, no extra keys) | OpenAI `web_search` tool, Anthropic `web_search_20260209` / `web_search_20250305` (`max_uses` 5), Gemini Grounding with Google Search. All tool mappings, model patterns and per-call prices live in **`src/providers/tools.json`**, read by `providers/tools.js`. |
| Both roles may search; the model decides when. The Reviewer is told to fact-check time-sensitive claims. | `WEB_SEARCH_RULES` in `core/context.js` |
| One per-conversation switch per tool, on by default (`defaultEnabled`). It applies from the next run or retry. | `conversation.tools` (`{ web_search: true }`; older conversations' `webSearch` flag is still read); checkboxes generated from `tools.json` |
| Sources are shown with the answer and stored in messages and exports | the transport collects cited links (falls back to search results), http/https only |
| Search fees count toward usage and the budget reserve (the tool's `max_uses`, else 5, assumed per call) | `pricePerCall` in `tools.json` |
| The disclosure text mentions web search. It's a material change, so it's re-acknowledged (FR-096). | `DISCLOSURE_VERSION` 2 |

Notes and limits:
- **Gemini Google Search grounding and FR-102.** FR-102 bans Google services in PeerMind's own infrastructure, but user-selected provider APIs, including Gemini, are explicitly outside that rule. Grounding is part of the Gemini API the user chose, so it stays within scope.
- **JSON mode is off while search is on** (OpenAI `text.format`, Gemini `responseMimeType`), because those modes can't be combined with tools on all models. The prompt and the strict validator still require one JSON object, so corrective retries may happen a little more often.
- **Text written before a search is dropped** (for example "Let me search…"). The answer is the text after the last tool result. This is a structural rule, not best-effort extraction (FR-029).
- **Anthropic `pause_turn` is not resumed yet.** If Claude's server-side search loop pauses, the operation fails with the raw stop reason, and Retry runs it again.
- **Gemini's search price ($14 per 1,000) comes from a secondary source.** Verify it against Google's pricing page. OpenAI and Anthropic are $10 per 1,000.

## Added beyond spec v1.8: image generation (OpenAI)

The product owner approved this on 2026-11-21. It builds on spec §8 (assets) and FR-073/074.

| Decision | Implementation |
|---|---|
| The Generator may create or edit images with OpenAI's built-in `image_generation` tool; the model decides when | `image_generation` in `tools.json` (Generator only, **off by default**, about $0.06 per image estimated) |
| Images are checked and stored as PeerMind assets | `decodeImages` (file signature decides the type; PNG/JPEG/WebP/GIF only; ≤ 20 MiB; SHA-256); `GENERATED`, or `EDITED` with `source_asset_id` on refinement |
| The Reviewer reviews the actual image | Image bytes are sent as image input; a Reviewer model without image input stops with a clear message |
| A refinement edits the previous image | The previous image is attached to the refine request; the tool's `action: auto` lets the model edit it |
| A format retry never redraws (or re-bills) the image | The image from the invalid attempt is kept; the corrective retry is sent without image tools |

Per-tool prompt rules (`instructions`), allowed roles (`roles`) and budget assumptions (`expectedCallsPerRequest`) now live in `tools.json` too.

## Not built yet

| Area | Spec | Notes |
|---|---|---|
| **MV3 PoC (all 11 criteria)** | §16.1 | Must happen before technical design approval. `background/keepalive.js` pings an extension API every 20 s during calls. Whether that survives the 180 s and 300 s silent waits on Brave and Chrome is unproven. Replace it with an offscreen document if it doesn't. |
| Import (ZIP validation, size limits, imported decisions forced to pending) | §8.3, §9.6, §15.2, FR-058–060 | Limits are defined in `constants.js`; the importer is not written. |
| Structured memory (extraction, summarisation, Memory panel) | §4.2–4.4, FR-061–064, FR-088 | `memory.json` is exported empty. There are no background model operations yet, so the budget reserve has nothing to add for them. |
| Image generation with Gemini | FR-073 | OpenAI's `image_generation` tool is built. Gemini draws with dedicated image *models* (image output switched on), not a tool, so it needs a small adapter option. |
| Reusing a recorded result after a worker restart | §5.6 | A result recorded before the worker died is marked SUCCEEDED, but its step is re-run on resume instead of reusing the result. |
| PAUSED_WAITING_FOR_USER | §5.3 | The state and its transitions exist, but nothing enters it yet. Pre-flight problems (keys, pricing, disclosure) use FAILED with a `pendingAction`. |
| Published JSON Schemas | §B.3 | Validation is hand-written in `core/`. The schema files still need publishing. |
| Browser result records per §16.2 rule 5 | FR-105, AC-50 | No template yet. |

## Spec questions raised by the implementation

1. **Abandonment reason for Stop during a retry pre-flight.** The code records the state PREFLIGHT was entered from and maps to that reason (`stopOutcome`).
2. **PREFLIGHT has no path to INTERRUPTED** in §5.3. On restart the code moves an interrupted pre-flight to FAILED.
3. **User-attached images are neither GENERATED nor EDITED** (§8.2). The code records `operation: "UPLOADED"`.
4. **Corrective retries are not in the §9.3 reserve.** A retry that doesn't fit ends the run with BUDGET_REACHED.
5. **Anthropic has no JSON mode.** Strict parsing (no fence stripping) may cost extra corrective retries with Claude as Generator or Reviewer.
6. **Model capabilities come from the model name.** Provider model lists don't report reasoning or image support (Gemini partly does). PeerMind derives them from the model ID and shows them as information. Unrecognised models count as not capable (§6.1). A brand-new model family needs its pattern added in `providers/adapters.js`.
7. **Token estimates are approximate** (characters ÷ 4) for context and pre-call cost. Recorded costs use the token counts the provider reports.
