/**
 * dosewiki-mcp — Cloudflare Worker
 * Stateless MCP server (Streamable HTTP, JSON responses) wrapping https://dose.wiki/api/v1
 * Read-only. Harm-reduction data. Not medical advice.
 */
const API = "https://dose.wiki/api/v1";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type, mcp-session-id, mcp-protocol-version, mcp-session-id, authorization",
  "access-control-expose-headers": "mcp-session-id",
};
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", ...CORS } });
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- DoseWiki client ---------- */
async function dw(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
  let last;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(url.toString(), {
      headers: { accept: "application/json", "user-agent": "dosewiki-mcp/1.0" },
      cf: { cacheEverything: true, cacheTtl: 600 },
    });
    if (res.status === 429 || res.status === 503) {
      last = new Error(`DoseWiki ${res.status}`);
      await sleep(500 * 2 ** i + Math.random() * 300);
      continue;
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error?.message ?? `DoseWiki HTTP ${res.status}`);
    return body;
  }
  throw last ?? new Error("DoseWiki unavailable");
}

/* ---------- substance index (cached per isolate) ---------- */
let INDEX = { at: 0, rows: null };
async function loadIndex() {
  if (INDEX.rows && Date.now() - INDEX.at < 10 * 60 * 1000) return INDEX.rows;
  const rows = [];
  let cursor = null;
  for (let p = 0; p < 8; p++) {
    const body = await dw("/substances", { limit: 100, cursor });
    rows.push(...(body.data || []));
    if (!body.pagination?.has_more) break;
    cursor = body.pagination.next_cursor;
  }
  INDEX = { at: Date.now(), rows };
  return rows;
}

const STOP = new Set(
  "a an the of for and or is are was were what which who how much does do dose dosage dosing effects effect interaction interactions legal legality status duration half life wiki dosewiki info information safety safe about drug substance data tell me give details on".split(" ")
);
function tokens(q) {
  const t = String(q).toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w));
  return t.length ? t : String(q).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3);
}
function score(row, ts) {
  const slug = (row.slug || "").toLowerCase();
  const title = (row.title || "").toLowerCase();
  const cats = (row.categories || []).join(" ").toLowerCase();
  const sum = (row.summary || "").toLowerCase();
  let s = 0;
  for (const t of ts) {
    if (slug === t || title === t) s += 100;
    else if (title.startsWith(t)) s += 40;
    else if (slug.startsWith(t)) s += 30;
    else if (title.includes(t)) s += 18;
    else if (slug.includes(t)) s += 12;
    else if (cats.includes(t)) s += 7;
    else if (sum.includes(t)) s += 3;
    else return 0; // every token must land somewhere
  }
  if (row.priority === "high") s += 1;
  return s;
}

/* ---------- markdown rendering ---------- */
const num = (r) => {
  if (!r) return "—";
  let s;
  if (r.min != null && r.max != null) s = r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`;
  else if (r.min != null) s = `${r.min}+`;
  else if (r.max != null) s = `<${r.max}`;
  else return "—";
  return r.unit ? `${s} ${r.unit}` : s;
};
const one = (s, n = 400) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const strip = (s) => String(s || "").replace(/\[cite:[^\]]+\]/g, "").replace(/\[citation-needed\]/g, "");

function renderArticle(a, sections) {
  const want = (k) => !sections || sections.includes(k);
  const out = [`# ${a.title || a.slug}`, a.url ? `Source: ${a.url}` : ""];
  out.push(strip(a.summary || ""));

  if (a.identification) {
    const i = a.identification;
    out.push("## Identification");
    [["Common name", i.common_name], ["IUPAC", i.iupac_name], ["Formula", i.molecular_formula],
     ["Molar mass", i.molecular_weight], ["CAS", i.cas_number], ["InChIKey", i.inchi_key],
     ["SMILES", i.smiles], ["Also known as", (i.alternative_names || []).join(", ")]]
      .filter(([, v]) => v).forEach(([k, v]) => out.push(`- ${k}: ${v}`));
  }
  if (a.classification) {
    out.push("## Classification");
    if (a.classification.psychoactive_class?.length) out.push(`- Psychoactive: ${a.classification.psychoactive_class.join(", ")}`);
    if (a.classification.chemical_class?.length) out.push(`- Chemical: ${a.classification.chemical_class.join(", ")}`);
  }
  if (want("dosage") && a.dosage?.routes?.length) {
    out.push("## Dosage (descriptive reference ranges, not advice)");
    for (const r of a.dosage.routes) {
      const d = r.dose_ranges || {};
      out.push(`- **${r.route}**${r.bioavailability ? ` (bioavailability ${r.bioavailability})` : ""}: ` +
        ["threshold", "light", "moderate", "strong", "heavy"].map((k) => `${k} ${num(d[k])}`).join(" | "));
      if (r.bioavailability_notes) out.push(`  - ${one(r.bioavailability_notes, 300)}`);
      if (r.notes) out.push(`  - ${one(r.notes, 400)}`);
    }
  }
  if (want("duration") && a.duration?.routes?.length) {
    out.push("## Duration");
    for (const r of a.duration.routes) {
      const s = r.stages || {};
      out.push(`- **${r.route}**: onset ${num(s.onset)}; come-up ${num(s.come_up)}; peak ${num(s.peak)}; ` +
        `offset ${num(s.offset)}; after-effects ${num(s.after_effects)}; total ${num(s.total_duration)}` +
        (r.half_life ? `; half-life ${r.half_life}` : ""));
      if (r.half_life_notes) out.push(`  - ${one(r.half_life_notes, 300)}`);
    }
  }
  if (want("subjective_effects") && a.subjective_effects) {
    const se = a.subjective_effects;
    out.push("## Subjective effects");
    const walk = (cat, depth) => {
      for (const [key, val] of Object.entries(cat || {})) {
        if (!val) continue;
        if (val.effects) {
          out.push(`${"  ".repeat(depth)}- ${key}${val.note ? ` — ${one(val.note, 160)}` : ""}`);
          for (const e of val.effects) out.push(`${"  ".repeat(depth + 1)}· ${e.name}`);
        } else if (val.subcategories) {
          out.push(`${"  ".repeat(depth)}- ${key}`);
          walk(val.subcategories, depth + 1);
        }
      }
    };
    for (const k of ["cognitive", "physical", "progressive_stages"]) if (se[k]) walk(se[k], 0);
    for (const [sense, v] of Object.entries(se.sensory || {})) {
      out.push(`- sensory/${sense}${v?.note ? ` — ${one(v.note, 160)}` : ""}`);
      walk(v?.subcategories, 1);
    }
  }
  if (want("interactions") && a.interactions) {
    out.push("## Interactions");
    for (const level of ["dangerous", "unsafe", "caution"]) {
      const list = a.interactions[level] || [];
      out.push(`- **${level}**: ${list.length ? list.join("; ") : "none listed"}`);
    }
  }
  if (want("tolerance") && a.tolerance) {
    out.push("## Tolerance");
    for (const k of ["full_tolerance", "half_tolerance", "baseline_tolerance"])
      if (a.tolerance[k]) out.push(`- ${k.replace(/_/g, " ")}: ${one(a.tolerance[k], 300)}`);
    if (a.tolerance.cross_tolerance?.length) out.push(`- cross-tolerance: ${a.tolerance.cross_tolerance.join(", ")}`);
  }
  if (want("harm_potential") && a.harm_potential) {
    out.push("## Harm potential");
    const hp = a.harm_potential;
    const risk = (label, r) => r && (r.level || r.description)
      ? out.push(`- ${label}: ${r.level ?? "unknown"}${r.description ? ` — ${one(r.description, 300)}` : ""}`) : null;
    risk("addiction (psychological)", hp.addiction?.psychological);
    risk("addiction (physical)", hp.addiction?.physical_dependence);
    risk("psychosis", hp.psychosis);
    risk("seizure", hp.seizure);
    const ld = hp.toxicity?.ld50;
    if (Array.isArray(ld) && ld.length)
      out.push(`- LD50: ${ld.map((x) => `${x.species}/${x.route} ${x.value ?? "?"} ${x.unit}`).join("; ")}`);
    const organs = hp.toxicity?.organ_toxicity;
    if (Array.isArray(organs)) organs.forEach((o) => out.push(`- ${o.system}: ${one(o.findings, 240)}`));
  }
  if (want("pharmacology") && a.pharmacology) {
    const p = a.pharmacology;
    out.push("## Pharmacology");
    if (p.pharmacodynamics) out.push(one(p.pharmacodynamics, 1500));
    const recs = p.receptor_profile?.length ? p.receptor_profile : p.binding_sites || [];
    if (recs.length)
      out.push("- Receptors: " + recs.slice(0, 25)
        .map((r) => `${r.receptor || r.target}${r.affinity ? ` (${r.affinity})` : ""}${r.efficacy ? ` ${r.efficacy}` : ""}`)
        .join("; "));
    if (p.metabolites?.length) out.push(`- Metabolites: ${p.metabolites.join(", ")}`);
    if (p.half_life) out.push(`- Half-life: ${p.half_life}`);
  }
  if (want("reagent_testing_normalized") && a.reagent_testing_normalized?.results?.length) {
    out.push("## Reagent tests (presumptive only — not proof of identity, purity or dose)");
    out.push(`- source: ${a.reagent_testing_normalized.source}`);
    for (const r of a.reagent_testing_normalized.results)
      out.push(`- ${r.reagent}${r.label ? ` (${r.label})` : ""}: ${one(r.description, 220)}`);
  }
  if (want("legality") && a.legality) {
    const l = a.legality;
    out.push("## Legality (jurisdiction-dependent; changes over time)");
    if (l.international?.length) out.push(`- International: ${one(l.international.join(" "), 400)}`);
    for (const [c, v] of Object.entries(l.countries || {}).slice(0, 30))
      out.push(`- ${c}: ${v.status}${v.notes ? ` — ${one(v.notes, 200)}` : ""}`);
  }
  if (want("history_culture") && a.history_culture) {
    out.push("## History & culture");
    if (a.history_culture.content) out.push(one(a.history_culture.content, 2000));
    for (const s of (a.history_culture.sections || []).slice(0, 15))
      out.push(`### ${s.heading}\n${one(s.content, 700)}`);
  }
  if (a.molecule?.schemes) {
    out.push("## Molecule", Object.entries(a.molecule.schemes)
      .map(([k, v]) => `- ${k}: https://dose.wiki${v.url}`).join("\n"));
  }
  const text = out.filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n");
  return text.length > 24000
    ? text.slice(0, 24000) + "\n\n_[truncated — request fewer sections]_"
    : text;
}

/* ---------- tools ---------- */
const DEFAULT_SECTIONS = ["dosage", "duration", "interactions", "tolerance", "harm_potential", "legality", "pharmacology", "reagent_testing_normalized"];

const TOOLS = [
  {
    name: "search_substances",
    description:
      "Search the DoseWiki index of psychoactive substances by name, keyword, class or effect. Returns matching slug + title + summary. Call this before get_substance. Harm-reduction reference data, not medical advice.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substance name or keywords, e.g. 'mdma', '2c-b', 'dissociative'." },
        limit: { type: "integer", minimum: 1, maximum: 25, default: 8 },
      },
      required: ["query"],
    },
  },
  {
    name: "get_substance",
    description:
      "Fetch a complete DoseWiki article (identification, dosage ranges, duration, interactions, tolerance, harm potential, pharmacology, legality, reagent tests) as compact markdown. Long/rare sections are opt-in via `sections`.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Exact slug from search_substances, e.g. 'mdma'." },
        sections: {
          type: "array", items: { type: "string" },
          description: "Add extra sections: subjective_effects, history_culture, classification, identification, molecule, summary.",
        },
      },
      required: ["slug"],
    },
  },
  {
    name: "get_reagent_tests",
    description: "Normalized reagent-test colors/results for one substance (presumptive identification aids only).",
    inputSchema: {
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
    },
  },
  {
    name: "find_replications",
    description:
      "Find image/video/audio 'replication' artworks for a subjective effect or a substance (DoseWiki media gallery). Returns title, type, artist, url — always keep attribution/rights.",
    inputSchema: {
      type: "object",
      properties: {
        effect: { type: "string", description: "Effect slug, e.g. 'drifting'." },
        substance: { type: "string", description: "Substance slug; returns that article's canonical collection." },
        type: { type: "string", enum: ["image", "video", "audio"] },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
    },
  },
];

async function runTool(name, args) {
  if (name === "search_substances") {
    const rows = await loadIndex();
    const ts = tokens(args.query);
    const hits = rows.map((r) => ({ r, s: score(r, ts) })).filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s).slice(0, Math.min(args.limit ?? 8, 25));
    if (!hits.length) return `No substance matched "${args.query}". Try a bare name or class keyword.`;
    return hits.map(({ r }) =>
      `- ${r.title} (slug: \`${r.slug}\`)\n  ${strip(r.summary || "").slice(0, 260)}\n  ${r.url}`).join("\n");
  }
  if (name === "get_substance") {
    const body = await dw(`/substances/${encodeURIComponent(args.slug)}`);
    return renderArticle(body.data, [...DEFAULT_SECTIONS, ...(args.sections || [])]);
  }
  if (name === "get_reagent_tests") {
    const t = await dw(`/substances/${encodeURIComponent(args.slug)}/reagent-tests`);
    if (!t.results.length) return `No reagent results available (source: ${t.source}). This is NOT a negative test.`;
    return `source: ${t.source}\n` + t.results
      .map((r) => `- ${r.reagent}${r.label ? ` (${r.label})` : ""}: ${r.description}${r.hint ? ` [${r.hint}]` : ""}`).join("\n");
  }
  if (name === "find_replications") {
    const limit = Math.min(args.limit ?? 10, 50);
    let items, meta;
    if (args.substance) {
      const b = await dw(`/substances/${encodeURIComponent(args.substance)}/replications`, { limit });
      items = b.data; meta = b.meta;
    } else if (args.effect) {
      const b = await dw(`/effects/${encodeURIComponent(args.effect)}/replications`);
      items = (b.data || []).filter((x) => !args.type || x.type === args.type).slice(0, limit);
      meta = b.meta;
    } else {
      const b = await dw("/replications", { limit, type: args.type });
      items = b.data; meta = b.meta;
    }
    if (!items?.length) return "No published replications for that selection.";
    return `total: ${meta?.total ?? items.length}\n` + items.map((w) =>
      `- ${w.title} — ${w.type} by ${w.artist}${w.rights?.status ? ` [rights: ${w.rights.status}]` : ""}\n  ${w.url}`).join("\n");
  }
  throw new Error(`Unknown tool: ${name}`);
}

/* ---------- MCP dispatch ---------- */
async function dispatch(msg) {
  const { id, method, params } = msg || {};
  const notify = id === undefined || id === null;
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "dosewiki", version: "1.0.0" },
        instructions:
          "Read-only DoseWiki harm-reduction reference. Call search_substances to resolve a slug, then get_substance. " +
          "Content is educational, not medical advice; reagent reactions are presumptive only.",
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "resources/list":
      return ok(id, { resources: [] });
    case "prompts/list":
      return ok(id, { prompts: [] });
    case "tools/call": {
      if (notify) return null;
      const t = TOOLS.find((x) => x.name === params?.name);
      if (!t) return err(id, -32602, `Unknown tool: ${params?.name}`);
      try {
        return ok(id, { content: [{ type: "text", text: await runTool(t.name, params?.arguments || {}) }], isError: false });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `DoseWiki error: ${e.message}` }], isError: true });
      }
    }
    default:
      return notify ? null : err(id, -32601, `Method not found: ${method}`);
  }
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method === "GET" || request.method === "DELETE")
      return new Response("No server-initiated stream / no sessions", { status: 405, headers: CORS });
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

    let payload;
    try { payload = await request.json(); }
    catch { return json(err(null, -32700, "Parse error"), 400); }

    const batch = Array.isArray(payload);
    const out = [];
    for (const m of batch ? payload : [payload]) {
      const r = await dispatch(m);
      if (r) out.push(r);
    }
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return json(batch ? out : out[0]);
  },
};
