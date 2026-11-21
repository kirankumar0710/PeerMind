// Tool registry: reads src/providers/tools.json (the single place vendor tool mappings live) and
// answers "which tools can this model use, and what do we send?". Pure functions over the parsed
// registry, plus a cached loader for the extension.

const RESULT_KINDS = ['sources']; // result kinds PeerMind knows how to display; others are rejected

let cached = null;

/**
 * Load and validate the registry once. In the extension it is fetched from the package; tests pass
 * their own loader. Returns the parsed registry with compiled model patterns.
 */
export async function loadToolRegistry(loader = defaultLoader) {
  if (cached) return cached;
  cached = compileRegistry(await loader());
  return cached;
}

async function defaultLoader() {
  const res = await fetch(chrome.runtime.getURL('src/providers/tools.json'));
  if (!res.ok) throw new Error(`Could not load tools.json (HTTP ${res.status}).`);
  return res.json();
}

/** Validate the JSON and compile each variant's 'models' regex. Throws with a clear message on errors. */
export function compileRegistry(json) {
  const problems = [];
  if (json?.schema !== 'peermind.tools' || json.version !== 1) problems.push('schema must be "peermind.tools" version 1');
  const tools = {};
  for (const [id, t] of Object.entries(json?.tools || {})) {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) problems.push(`tool id "${id}" must be snake_case`);
    if (!t.label) problems.push(`${id}: label is required`);
    if (!RESULT_KINDS.includes(t.result)) problems.push(`${id}: result "${t.result}" is not one of ${RESULT_KINDS.join(', ')}`);
    const vendors = {};
    for (const [vendor, variants] of Object.entries(t.vendors || {})) {
      if (!Array.isArray(variants) || !variants.length) { problems.push(`${id}.${vendor}: needs at least one variant`); continue; }
      vendors[vendor] = variants.map((v, i) => {
        let re = null;
        try { re = new RegExp(v.models); } catch (e) { problems.push(`${id}.${vendor}[${i}]: bad models regex (${e.message})`); }
        if (!v.request || typeof v.request !== 'object') problems.push(`${id}.${vendor}[${i}]: request object is required`);
        if (!Number.isFinite(v.pricePerCall) || v.pricePerCall < 0) problems.push(`${id}.${vendor}[${i}]: pricePerCall must be a number >= 0`);
        return { ...v, modelsRe: re };
      });
    }
    tools[id] = { id, label: t.label, description: t.description || '', result: t.result, defaultEnabled: t.defaultEnabled !== false, vendors };
  }
  if (problems.length) throw new Error(`tools.json is invalid: ${problems.join('; ')}`);
  return { pricesAsOf: json.pricesAsOf, vendorOptions: json.vendorOptions || {}, tools };
}

/** Every tool this vendor/model supports: [{ id, label, description, result, request, pricePerCall }]. */
export function toolsForModel(registry, vendor, modelId) {
  const out = [];
  for (const t of Object.values(registry.tools)) {
    const variant = (t.vendors[vendor] || []).find((v) => v.modelsRe?.test(modelId));
    if (variant) {
      out.push({
        id: t.id, label: t.label, description: t.description, result: t.result, defaultEnabled: t.defaultEnabled,
        request: structuredClone(variant.request), pricePerCall: variant.pricePerCall,
      });
    }
  }
  return out;
}

/** Is a tool switched on for this conversation? Older conversations used the `webSearch` flag. */
export function toolEnabled(conversation, tool) {
  const v = conversation?.tools?.[tool.id];
  if (typeof v === 'boolean') return v;
  if (tool.id === 'web_search' && typeof conversation?.webSearch === 'boolean') return conversation.webSearch;
  return tool.defaultEnabled;
}

/** Whether this vendor keeps its JSON mode when tools are sent. */
export const jsonModeWithTools = (registry, vendor) => registry.vendorOptions?.[vendor]?.jsonModeWithTools !== false;

/** For tests: reset the cache. */
export const _resetToolRegistry = () => { cached = null; };
