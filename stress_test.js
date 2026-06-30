/**
 * stress_test.js — K6 stress test engine
 *
 * Reads one or more JSON template files, resolves placeholder functions on every
 * VU iteration to produce fresh random payloads, and fires HTTP requests.
 *
 * ── Execution ───────────────────────────────────────────────────────────────
 *
 * Single template (default path /app/template.json):
 *   docker run --rm \
 *     -v $(pwd)/template.json:/app/template.json \
 *     -v $(pwd)/custom_functions.js:/app/custom_functions.js \
 *     local-stress-test run /app/stress_test.js \
 *     -e otherVar=100 \
 *     --vus 10 --duration 30s
 *
 * Multiple templates (comma-separated paths via TEMPLATES env var):
 *   docker run --rm \
 *     -v $(pwd)/templates:/app/templates \
 *     -v $(pwd)/custom_functions.js:/app/custom_functions.js \
 *     local-stress-test run /app/stress_test.js \
 *     -e TEMPLATES=/app/templates/t1.json,/app/templates/t2.json \
 *     -e otherVar=100 \
 *     --vus 10 --duration 30s
 *
 * ── Template placeholders ────────────────────────────────────────────────────
 *
 *   $randomNumber(min, max)          — random integer in [min, max]
 *   $randomString(minLen, maxLen)    — random alphanumeric string
 *   $randomDate(startDate, endDate)  — "YYYY-MM-DD HH:mm:ss" in UTC
 *   $randomUUID()                    — UUID v4
 *   $randomBoolean()                 — true or false
 *   $timestamp()                     — current Unix timestamp (ms)
 *   $totalItems(arrayId)             — count of items generated for that $id array
 *   $toNumber(#envVar)               — parseInt(__ENV.envVar)
 *   $toString(#envVar)               — String(__ENV.envVar)
 *   $myFunc(...)                     — custom function from custom_functions.js
 *
 * ── Optional env vars ────────────────────────────────────────────────────────
 *
 *   TEMPLATES       comma-separated template file paths (default: /app/template.json)
 *   SLEEP_SECONDS   seconds to sleep between iterations per VU (default: 0)
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter, Rate } from 'k6/metrics';
import { customFunctions } from './custom_functions.js';

// ─── Init stage: load templates ──────────────────────────────────────────────
// open() is a K6 global and MUST be called in the init stage (here), never
// inside the default function.

const templatePaths = (__ENV.TEMPLATES || '/app/template.json')
  .split(',')
  .map(p => p.trim())
  .filter(Boolean);

const templates = templatePaths.map(path => {
  try {
    return JSON.parse(open(path));
  } catch (e) {
    throw new Error(`[stress_test] Cannot load template "${path}": ${e.message}`);
  }
});

if (templates.length === 0) {
  throw new Error('[stress_test] No templates loaded. Check the TEMPLATES env var.');
}

// ─── K6 options from templates ───────────────────────────────────────────────
// Merge k6_options from all templates (first template wins on conflict).
// CLI flags (--vus, --duration, --stage, …) always override these.
const mergedOptions = {};
for (const t of templates) {
  if (t.k6_options && typeof t.k6_options === 'object') {
    for (const [k, v] of Object.entries(t.k6_options)) {
      if (!(k in mergedOptions)) mergedOptions[k] = v;
    }
  }
}
export const options = mergedOptions;

// ─── Custom metrics ───────────────────────────────────────────────────────────
const reqDuration = new Trend('stress_req_duration', true);
const reqTotal    = new Counter('stress_req_total');
const errRate     = new Rate('stress_error_rate');

// ─── Placeholder parser ───────────────────────────────────────────────────────

/**
 * Parse "$funcName(arg1, arg2)" → { name, args } or null if not a placeholder.
 */
function parsePlaceholder(value) {
  if (typeof value !== 'string' || value[0] !== '$') return null;
  const m = value.match(/^\$([A-Za-z_][A-Za-z0-9_]*)\(([\s\S]*)\)$/);
  if (!m) return null;
  const name = m[1];
  const raw  = m[2].trim();
  const args = raw === '' ? [] : raw.split(',').map(s => s.trim());
  return { name, args };
}

/**
 * Resolve an argument: "#varName" reads __ENV.varName, otherwise returns as-is.
 */
function resolveEnvArg(arg) {
  if (typeof arg === 'string' && arg.startsWith('#')) {
    const key = arg.slice(1);
    return Object.prototype.hasOwnProperty.call(__ENV, key) ? __ENV[key] : null;
  }
  return arg;
}

// ─── Built-in generator functions ─────────────────────────────────────────────

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randString(minLen, maxLen) {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const len   = randInt(parseInt(minLen, 10), parseInt(maxLen, 10));
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
  return s;
}

function randDate(startStr, endStr) {
  const start = new Date(startStr).getTime();
  const end   = new Date(endStr).getTime();
  const d     = new Date(start + Math.random() * (end - start));
  const p     = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
       + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function uuid4() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// ─── Function dispatcher ──────────────────────────────────────────────────────

/**
 * Call a built-in or custom function by name.
 * @param {string}   name     — function name (without leading $)
 * @param {string[]} args     — raw arguments (still may contain #refs)
 * @param {Object}   registry — generated arrays keyed by $id (for $totalItems)
 */
function callFn(name, args, registry) {
  switch (name) {
    case 'randomNumber': {
      const min = parseInt(resolveEnvArg(args[0]), 10);
      const max = parseInt(resolveEnvArg(args[1]), 10);
      return randInt(min, max);
    }
    case 'randomString': {
      return randString(resolveEnvArg(args[0]), resolveEnvArg(args[1]));
    }
    case 'randomDate': {
      return randDate(resolveEnvArg(args[0]), resolveEnvArg(args[1]));
    }
    case 'randomUUID':
      return uuid4();
    case 'randomBoolean':
      return Math.random() < 0.5;
    case 'timestamp':
      return Date.now();
    case 'totalItems': {
      const id    = resolveEnvArg(args[0]);
      const entry = registry[id];
      return entry ? entry.count : 0;
    }
    case 'toNumber': {
      const raw = resolveEnvArg(args[0]);
      if (raw === null) throw new Error(`$toNumber: env var "${args[0]}" is not set. Pass it with -e ${args[0].replace('#', '')}=VALUE`);
      const n = Number(raw);
      if (isNaN(n))    throw new Error(`$toNumber: "${raw}" cannot be converted to a number`);
      return n;
    }
    case 'toString': {
      const raw = resolveEnvArg(args[0]);
      if (raw === null) throw new Error(`$toString: env var "${args[0]}" is not set. Pass it with -e ${args[0].replace('#', '')}=VALUE`);
      return String(raw);
    }
    default: {
      if (customFunctions && typeof customFunctions[name] === 'function') {
        return customFunctions[name](args.map(resolveEnvArg), __ENV);
      }
      throw new Error(`Unknown placeholder function: $${name}() — add it to custom_functions.js`);
    }
  }
}

/**
 * Resolve a leaf value: if it is a "$func(...)" string, call the function;
 * otherwise return the value as-is.
 */
function resolveValue(v, registry) {
  if (typeof v !== 'string') return v;
  const ph = parsePlaceholder(v);
  if (!ph) return v;
  return callFn(ph.name, ph.args, registry);
}

// ─── Template engine ──────────────────────────────────────────────────────────
//
// Two-pass approach to handle forward references like:
//   "total_records": "$totalItems(data)"   ← appears BEFORE the "data" array
//
// Pass 1 — scanArrays():
//   Walk the entire payload tree, find every {"$type":"array"} node, generate
//   its items, and register { items, count } in `registry` keyed by `$id`.
//
// Pass 2 — resolveNode():
//   Walk the payload again. Replace {"$type":"array"} nodes with their
//   pre-generated items; resolve all remaining string placeholders.

/**
 * Pass 1 — Build one item from an $itemTemplate during array generation.
 */
function buildItem(tmpl, registry) {
  if (tmpl === null || typeof tmpl !== 'object') return resolveValue(tmpl, registry);
  if (Array.isArray(tmpl)) return tmpl.map(el => buildItem(el, registry));

  const result = {};
  for (const [k, v] of Object.entries(tmpl)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && v.$type === 'array') {
      // Nested array inside an item template — generate it recursively.
      scanArrays(v, registry);
      result[k] = registry[v.$id] ? registry[v.$id].items : [];
    } else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = buildItem(v, registry);
    } else {
      result[k] = resolveValue(v, registry);
    }
  }
  return result;
}

/**
 * Pass 1 — Recursively find every {"$type":"array"} node, generate its items
 * and register the result in `registry`.
 */
function scanArrays(node, registry) {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(el => scanArrays(el, registry)); return; }

  if (node.$type === 'array') {
    const id       = node.$id || `_arr_${Object.keys(registry).length}`;
    const minItems = typeof node.$minItems === 'number' ? node.$minItems : 1;
    const maxItems = typeof node.$maxItems === 'number' ? node.$maxItems : 1;
    const count    = randInt(minItems, maxItems);
    const items    = [];
    for (let i = 0; i < count; i++) {
      items.push(buildItem(node.$itemTemplate, registry));
    }
    registry[id] = { items, count };
    return; // Don't recurse further into this node's own fields.
  }

  for (const val of Object.values(node)) {
    scanArrays(val, registry);
  }
}

/**
 * Pass 2 — Produce the final payload object.
 * {"$type":"array"} nodes are replaced by pre-generated items.
 * All remaining string placeholders are resolved.
 */
function resolveNode(node, registry) {
  if (node === null || typeof node !== 'object') return resolveValue(node, registry);
  if (Array.isArray(node)) return node.map(el => resolveNode(el, registry));

  if (node.$type === 'array') {
    const id = node.$id;
    return registry[id] ? registry[id].items : [];
  }

  const result = {};
  for (const [k, v] of Object.entries(node)) {
    result[k] = resolveNode(v, registry);
  }
  return result;
}

/**
 * Generate a concrete, JSON-ready payload from a template.
 */
function generatePayload(template) {
  const registry = {};
  scanArrays(template.payload, registry);   // Pass 1
  return resolveNode(template.payload, registry); // Pass 2
}

// ─── VU default function ──────────────────────────────────────────────────────
//
// Template assignment: VU 1 → templates[0], VU 2 → templates[1], …
// VUs cycle round-robin if there are more VUs than templates.
// Set --vus to at least the number of templates to ensure all are exercised.

const sleepSeconds = parseFloat(__ENV.SLEEP_SECONDS || '0');

export default function () {
  const tpl    = templates[(__VU - 1) % templates.length];
  const method = (tpl.method || 'POST').toUpperCase();
  const url    = tpl.url;
  const hdrs   = Object.assign({ 'Content-Type': 'application/json' }, tpl.headers || {});
  const body   = JSON.stringify(generatePayload(tpl));

  let res;
  if      (method === 'POST')   res = http.post(url, body, { headers: hdrs });
  else if (method === 'PUT')    res = http.put(url, body, { headers: hdrs });
  else if (method === 'PATCH')  res = http.patch(url, body, { headers: hdrs });
  else if (method === 'DELETE') res = http.del(url, body, { headers: hdrs });
  else                          res = http.get(url, { headers: hdrs });

  const ok = check(res, {
    [`${tpl.name} - status 2xx`]: r => r.status >= 200 && r.status < 300,
  });

  reqDuration.add(res.timings.duration);
  reqTotal.add(1);
  errRate.add(!ok);

  if (!ok) {
    console.error(`[${tpl.name}] status=${res.status} body=${res.body.substring(0, 300)}`);
  }

  if (sleepSeconds > 0) sleep(sleepSeconds);
}
