# PeerMind
A browser extension for cross-vendor AI peer review: generate, critique, and iteratively refine responses.

A Generator model (G) from one vendor drafts an answer. A Reviewer model (R) from a different vendor critiques it as structured findings. G must decide on every open finding and send back a full revision. PeerMind, not either model, decides when the loop is done. The product contract is the **PeerMind Functional Specification v1.8**. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for how the code maps to it and what is still open.

- Chromium Manifest V3 side-panel extension. Brave is the primary browser and Chrome is secondary. One package serves both.
- Plain JavaScript (ES modules), HTML and CSS. There is no build step and no runtime dependencies.
- Supported providers are OpenAI, Anthropic and Google Gemini, called through their first-party APIs with API keys.

## Load it in Brave (or Chrome)

1. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Click the PeerMind toolbar icon to open the side panel.
4. Go to **Settings** and do the following:
   - Add API keys for two different vendors. Keys are kept for the browser session only.
   - Click **Test**, then **Load models** and pick a Generator and a Reviewer model.
   - Enter pricing per model in USD per 1M tokens. Without pricing you can only run with the budget cap disabled.
   - Acknowledge the data disclosure for each provider.
   - Click **Save settings**.
5. Open **Run**, type a prompt and press **Start**.

To get a reasoning model's thinking events (FR-092), tick its "Reasoning model" box. This keeps slow first responses within the timeouts. Only tick it for models that support reasoning, because the provider rejects the parameter otherwise.

## Develop

```sh
npm install           # dev-only: fake-indexeddb for the end-to-end tests
npm test              # unit tests and an end-to-end orchestrator test with stubbed providers
npm run check:compat  # AC-49 static check: no browser branching outside src/compat/, no Google services
npm run package       # dist/peermind-<version>.zip plus its SHA-256 (the same package for Brave and Chrome)
npm run icons         # regenerate icons/
```

## Layout

| Path | Role |
|---|---|
| `src/core/` | Pure rules: run state machine, finding validation, protocol parsing, budget, context building |
| `src/providers/` | Streaming transport with §10 timeouts; OpenAI, Anthropic and Gemini adapters |
| `src/background/` | Service worker: orchestration loop, locks, recovery, notifications |
| `src/storage/` | IndexedDB records; settings in `chrome.storage.local`; keys in `chrome.storage.session` |
| `src/compat/browser.js` | The only module allowed to branch on browser behaviour (FR-103) |
| `src/export/` | ZIP + JSON conversation export |
| `src/sidepanel/` | Side panel UI (UI only; it never runs the loop) |
| `tools/` | Packaging, the compatibility check and the icon generator |
