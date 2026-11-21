# PeerMind
A browser extension for cross-vendor AI peer review: generate, critique, and iteratively refine responses.

A Generator model (G) from one vendor drafts an answer. A Reviewer model (R) from a different vendor critiques it as structured findings. G must decide on every open finding and send back a full revision. PeerMind, not either model, decides when the loop is done. The product contract is the **PeerMind Functional Specification v1.8**. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for how the code maps to it and what is still open.

- Chromium Manifest V3 side-panel extension. Brave is the primary browser and Chrome is secondary. One package serves both.
- Plain JavaScript (ES modules), HTML and CSS. There is no build step and no runtime dependencies.
- Supported providers are OpenAI, Anthropic and Google Gemini, called through their first-party APIs with API keys.

## Build the package

There is no compile step, because the browser runs the source files as they are. Building means checking the code and zipping it into one package. That same package is installed on both Brave and Chrome (FR-104).

**Quick way.** One script runs every step below:

```sh
./create_package.sh                # install if needed, test, compat check, zip, unzip
./create_package.sh --skip-checks  # zip and unzip only
```

It creates `dist/peermind-<version>.zip` and the unzipped `dist/peermind-<version>/`, and prints the SHA-256.

**Step by step.** Run these from the repo root.

1. **One-time setup.** This installs a test-only dependency; nothing from it goes into the package.
   ```sh
   npm install
   ```
2. **Check the code.** Fix any failure before building.
   ```sh
   npm test             # expect: pass 45, fail 0
   npm run check:compat # expect: check-compat: OK
   ```
3. **Build.**
   ```sh
   npm run package
   ```
   This writes `dist/peermind-<version>.zip` and prints its SHA-256. The zip holds only `manifest.json`, `icons/` and `src/`. The same sources always give the same hash. Record it with every Brave and Chrome test result (FR-105), and bump `"version"` in `manifest.json` before building a changed release.
4. **Unzip it for loading.** In developer mode, Brave and Chrome load a folder, not a `.zip`.
   ```sh
   rm -rf dist/peermind-0.1.0 && unzip -q dist/peermind-0.1.0.zip -d dist/peermind-0.1.0
   ```

## Load it in Brave (or Chrome)

1. Open `brave://extensions` (or `chrome://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select `dist/peermind-<version>`. Load the same folder in both browsers.
3. Click the PeerMind toolbar icon to open the side panel.
4. Go to **Settings** and do the following:
   - Add API keys for two different vendors. Keys are kept for the browser session only.
   - Click **Test**, then **Load models** and pick a Generator and a Reviewer model.
   - Check the price for each model. Built-in default prices fill in automatically, and each shows its "as of" date. Edit a price to override it, or click **Use default** to go back. A model with no built-in price needs one entered, or it can only run with the budget cap disabled. Defaults live in `src/providers/pricing.js`; update them when providers change their prices.
   - Acknowledge the data disclosure for each provider.
   - Click **Save settings**.
5. Open **Run**, type a prompt and press **Start**.

**Image generation (off by default).** Tick **Image generation** in the prompt box to let the Generator (OpenAI tool models) create images. The Reviewer receives the actual image, and refinements edit it. Every version is kept and can be enlarged or downloaded. Each image costs about $0.06 (estimate).

**Web search (live information).** With **Web search** ticked in the prompt box (the default), the Generator and Reviewer can use their provider's built-in web search when a prompt needs current information. The Reviewer also uses it to fact-check. Sources are listed under the answer. Searches are billed per call by the provider (about $10–14 per 1,000) and count toward the conversation's budget cap. Untick the box to turn search off for that conversation.

Reasoning support and image input are detected from the model name and shown under each role as information. For reasoning models, PeerMind requests progress signals automatically so that slow first responses stay within the timeouts (FR-092). The only choice is **Use extended thinking** on Claude models that support it. It is better on hard tasks, but slower and costs more.

## Develop

For day-to-day work you can skip the build. Choose **Load unpacked** on the repo folder itself, and click the reload icon on the extension card after each change. Use the built package from `dist/` for any test run you record, so the results match a package hash.

```sh
npm install           # dev-only: fake-indexeddb for the end-to-end tests
npm test              # unit tests and an end-to-end orchestrator test with stubbed providers
npm run check:compat  # AC-49 static check: no browser branching outside src/compat/, no Google services
npm run package       # dist/peermind-<version>.zip plus its SHA-256 (the same package for Brave and Chrome)
npm run icons -- path/to/source.png   # rebuild icons/icon{16,32,48,128}.png from one square image (needs Python + Pillow)
```

### Built-in tools (`src/providers/tools.json`)

Each vendor's built-in tools, such as web search, are described in **one data file**. The adapters, pre-flight, budget and UI all read it. For each tool it lists, per vendor, ordered variants (the first whose `models` regex matches the model ID wins): the `request` object sent to the vendor exactly as written, and the `pricePerCall` fee.

- **A vendor ships a new tool version or supports more models:** edit the variant's `request` or `models`. No code change is needed.
- **Adding another tool of a kind PeerMind already displays** (`"result": "sources"`): add an entry. Its switch appears in the prompt box automatically.
- **A tool with a new kind of result:** needs a small result handler in the code. Supported kinds are `sources` (web search) and `image` (image generation).
- Each tool also sets `roles` (`G`, `R`), `defaultEnabled`, `expectedCallsPerRequest` (for the budget reserve) and `instructions` per role, which are added to the system prompt when the tool is offered.

`npm test` checks the file. A bad regex, a missing price or an unknown result kind fails the build.

### Signed `.crx` for distribution (optional)

On `brave://extensions`, click **Pack extension** and select `dist/peermind-<version>`. This produces a `.crx` and a `.pem` private key. Keep the `.pem` safe and out of git, because every future update must be signed with the same key. Whether a `.crx` is needed depends on the distribution channel, which the spec leaves undecided (§16.2).

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
