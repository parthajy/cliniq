// apps/api/src/handlers/webPublicAnalysisV1.ts
import fetch from "node-fetch";
import { emit } from "../runStore";

/* -------------------- types -------------------- */

export type WebPaletteColor = { value: string; count: number };

export type WebSiteExtract = {
  title?: string;
  description?: string;
  h1?: string;
  h2?: string[];
  ctas?: string[]; // button-ish labels
  navLinks?: string[]; // top nav-ish labels
  palette?: WebPaletteColor[]; // top colors observed (best-effort)
  metrics?: {
    heroLength: number;
    ctaCount: number;
    navCount: number;
    trustMentions: number;
    pricingMentions: number;
    developerMentions: number;
  };
};

export type WebOkResult = {
  url: string;
  ok: true;
  extract: WebSiteExtract;
};

export type WebFailResult = {
  url: string;
  ok: false;
  error: string;
};

export type WebResult = WebOkResult | WebFailResult;

export type WebPublicAnalysisOutput = {
  kind: "web_public_analysis";
  question: string;
  focus: "copy" | "color" | "ux" | "general";
  answer: string; // short, human-facing
  recommendations: Array<{
    title: string;
    appliesTo: "site_a" | "site_b" | "both";
    rationale: string;
    actions: string[];
    evidence?: string[];
  }>;
  sites: WebResult[];
  note?: string;
};

/* -------------------- fetch -------------------- */

function normalizeUrl(u: string) {
  const s = String(u || "").trim();
  if (!s) return "";
  if (s.startsWith("http://") || s.startsWith("https://")) return s;
  return `https://${s}`;
}

async function fetchWithTimeout(url: string, timeoutMs = 12_000): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "CliniqBot/1.0 (public web analysis)",
        "Accept": "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: ctrl.signal as any,
    });

    if (!res.ok) throw new Error(`Fetch failed ${res.status}`);
    const ct = String(res.headers.get("content-type") || "");
    if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
      // Some sites return HTML without proper CT; we still try.
    }
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/* -------------------- extraction helpers -------------------- */

// very cheap tag stripper for small snippets
function stripTags(s: string) {
  return String(s || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(html: string, re: RegExp) {
  const m = html.match(re);
  return m?.[1] ? stripTags(m[1]) : undefined;
}

function allMatches(html: string, re: RegExp, limit = 8) {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  while ((m = r.exec(html)) && out.length < limit) {
    const s = m?.[1] ? stripTags(m[1]) : "";
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function uniqCompact(arr: string[] | undefined, limit = 10) {
  const out: string[] = [];
  for (const s of arr || []) {
    const v = String(s || "").trim();
    if (!v) continue;
    if (out.includes(v)) continue;
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function extractMetaContent(html: string, name: string) {
  const re = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    "i"
  );
  return firstMatch(html, re);
}

function extractTitle(html: string) {
  return firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
}

function extractH1(html: string) {
  return firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
}

function extractH2(html: string) {
  return uniqCompact(allMatches(html, /<h2[^>]*>([\s\S]*?)<\/h2>/gi, 10), 6);
}

function extractButtonsAndPrimaryLinks(html: string) {
  // Pull <button> labels + "button-like" anchor labels.
  const buttons = allMatches(html, /<button[^>]*>([\s\S]*?)<\/button>/gi, 12);
  const aButtons = allMatches(
    html,
    /<a[^>]+class=["'][^"']*(?:btn|button|cta)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
    12
  );
  const combined = uniqCompact([...buttons, ...aButtons].map(stripTags), 10);
  // Filter ultra-noisy entries
  return combined.filter((x) => x.length >= 2 && x.length <= 48);
}

function extractNavLinks(html: string) {
  // Best-effort: look for a <nav> block and extract first few <a> texts inside it.
  const navBlock = firstMatch(html, /<nav[^>]*>([\s\S]*?)<\/nav>/i);
  if (!navBlock) return [];
  const links = allMatches(navBlock, /<a[^>]*>([\s\S]*?)<\/a>/gi, 30).map(stripTags);
  const cleaned = uniqCompact(links, 12).filter((x) => x.length >= 2 && x.length <= 40);
  return cleaned.slice(0, 10);
}

function normalizeHex(hex: string) {
  let h = hex.trim().toLowerCase();
  if (!h.startsWith("#")) h = `#${h}`;
  if (h.length === 4) {
    // #abc -> #aabbcc
    h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  if (h.length !== 7) return null;
  return h;
}

function rgbToHex(r: number, g: number, b: number) {
  const to = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`.toLowerCase();
}

function extractPalette(html: string): WebPaletteColor[] {
  // Best-effort: inline styles + style tags. We won't fetch external CSS.
  const h = html;

  const hits: string[] = [];

  // hex colors
  const hexRe = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = hexRe.exec(h))) {
    const n = normalizeHex(m[1]);
    if (n) hits.push(n);
  }

  // rgb(...) colors
  const rgbRe = /rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)/gi;
  while ((m = rgbRe.exec(h))) {
    const r = Math.min(255, Number(m[1]));
    const g = Math.min(255, Number(m[2]));
    const b = Math.min(255, Number(m[3]));
    hits.push(rgbToHex(r, g, b));
  }

  // meta theme-color
  const theme = extractMetaContent(html, "theme-color");
  if (theme) {
    const mt = theme.match(/#([0-9a-f]{3}|[0-9a-f]{6})/i);
    if (mt?.[1]) {
      const n = normalizeHex(mt[1]);
      if (n) hits.push(n);
    }
  }

  // Count
  const counts = new Map<string, number>();
  for (const c of hits) counts.set(c, (counts.get(c) || 0) + 1);

  const sorted = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([value, count]) => ({ value, count }));

  return sorted;
}

function countMentions(text: string, words: string[]) {
  const t = text.toLowerCase();
  let c = 0;
  for (const w of words) {
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    const m = t.match(re);
    c += m ? m.length : 0;
  }
  return c;
}

function buildMetrics(prompt: string, extract: WebSiteExtract, rawText: string) {
  const h1 = extract.h1 || "";
  const ctas = extract.ctas || [];
  const nav = extract.navLinks || [];

  // Prompt-agnostic metrics that help comparison
  const trustMentions = countMentions(rawText, [
    "trusted",
    "security",
    "secure",
    "compliance",
    "privacy",
    "iso",
    "soc",
    "gdpr",
    "pci",
    "uptime",
    "sla",
  ]);
  const pricingMentions = countMentions(rawText, ["pricing", "price", "plans", "free", "trial"]);
  const developerMentions = countMentions(rawText, ["api", "developers", "docs", "sdk", "github"]);

  return {
    heroLength: h1.length,
    ctaCount: ctas.length,
    navCount: nav.length,
    trustMentions,
    pricingMentions,
    developerMentions,
  };
}

function detectFocus(prompt: string): WebPublicAnalysisOutput["focus"] {
  const p = (prompt || "").toLowerCase();

  if (/\b(color|colour|palette|branding|brand|theme|typography|font)\b/.test(p)) return "color";
  if (/\b(copy|messaging|positioning|tone|headline|tagline|hero|value prop|value proposition)\b/.test(p))
    return "copy";
  if (/\b(ux|ui|improve|audit|conversion|clarity|above the fold|landing|homepage)\b/.test(p)) return "ux";

  return "general";
}

function scoreForComparison(a: WebSiteExtract, b: WebSiteExtract) {
  const am = a.metrics!;
  const bm = b.metrics!;

  // “Stronger” is contextual; we only use these as hints for recommendations.
  const hints = {
    clearerHero: am.heroLength > 0 && (bm.heroLength === 0 || am.heroLength < bm.heroLength),
    fewerCTAs: am.ctaCount > 0 && am.ctaCount < bm.ctaCount,
    strongerTrust: am.trustMentions > bm.trustMentions,
    morePricingSignals: am.pricingMentions > bm.pricingMentions,
    moreDevSignals: am.developerMentions > bm.developerMentions,
    richerPalette: (a.palette?.length || 0) > (b.palette?.length || 0),
  };

  return hints;
}

function composeAnswer(args: {
  prompt: string;
  focus: WebPublicAnalysisOutput["focus"];
  sites: WebResult[];
}) {
  const { prompt, focus, sites } = args;

  const okSites = sites.filter((s): s is WebOkResult => s.ok);
  const note = sites.some((s) => !s.ok)
    ? "Some sites restrict automated access or render heavily client-side. I’ll improve coverage over time."
    : undefined;

  if (okSites.length === 0) {
    return {
      answer:
        "I couldn’t reliably fetch/parse those pages right now. Try again or provide a specific page URL (not just the domain).",
      recommendations: [],
      note,
    };
  }

  const isCompare = okSites.length >= 2;
  const a = okSites[0];
  const b = okSites[1];

  const recs: WebPublicAnalysisOutput["recommendations"] = [];

  // Single-site mode (audit-style)
  if (!isCompare) {
    const x = a.extract;
    const t = `${x.title || a.url} ${x.description || ""} ${x.h1 || ""} ${(x.h2 || []).join(" ")} ${(x.ctas || []).join(" ")}`;
    const m = x.metrics!;

    recs.push({
      title: "Clarify the primary value proposition in the first headline",
      appliesTo: "site_a",
      rationale:
        m.heroLength > 70
          ? "Your H1 is long; long headlines reduce instant comprehension."
          : "If your H1 is generic, you lose differentiation fast.",
      actions: [
        "Make the H1 outcome-led (what users achieve), not feature-led.",
        "Add a subheadline that names the target user + timeframe/result.",
      ],
      evidence: x.h1 ? [`H1: "${x.h1}"`] : undefined,
    });

    recs.push({
      title: "Reduce competing CTAs above the fold",
      appliesTo: "site_a",
      rationale:
        m.ctaCount >= 4
          ? "Too many calls-to-action creates decision paralysis."
          : "A single primary CTA improves conversion clarity.",
      actions: ["Keep 1 primary CTA and 1 secondary (max) in the hero.", "Push secondary actions below the first scroll."],
      evidence: (x.ctas || []).length ? [`CTAs spotted: ${(x.ctas || []).join(" | ")}`] : undefined,
    });

    recs.push({
      title: "Increase trust signals earlier",
      appliesTo: "site_a",
      rationale:
        m.trustMentions === 0
          ? "There are few explicit trust/compliance cues on the page text."
          : "Trust cues should appear before feature detail for higher conversion.",
      actions: [
        "Add a short trust strip: security/compliance/uptime + 2–5 recognizable customer logos.",
        "Place it immediately after the hero (or within the hero).",
      ],
    });

    const answer =
      focus === "color"
        ? "I can infer a rough palette from inline/styles, but to be accurate we should also fetch the main CSS. For now: borrow one primary accent, keep neutral backgrounds, and ensure contrast."
        : "Here are the highest-leverage homepage improvements based on what I could extract.";

    return { answer, recommendations: recs, note };
  }

  // Compare mode
  const ax = a.extract;
  const bx = b.extract;
  const ah = scoreForComparison(ax, bx);
  const bh = scoreForComparison(bx, ax);

  // Copy-focused compare
  if (focus === "copy") {
    recs.push({
      title: "Borrow the sharper value proposition framing",
      appliesTo: "both",
      rationale:
        "The strongest site leads with a concrete outcome and a narrow promise. The weaker site usually drifts into generic category language.",
      actions: [
        "Rewrite the weaker site’s H1 to be outcome-led (result), and move “what it is” to the subheadline.",
        "Make the first 2–3 sections reinforce the same promise (no product catalog immediately).",
      ],
      evidence: [
        ax.h1 ? `Site A H1: "${ax.h1}"` : "Site A H1 not found",
        bx.h1 ? `Site B H1: "${bx.h1}"` : "Site B H1 not found",
      ],
    });

    // Use metrics hints to make it opinionated without hardcoding
    if (ah.clearerHero) {
      recs.push({
        title: "Adopt the shorter, faster-to-parse hero headline",
        appliesTo: "site_b",
        rationale: "Shorter hero headlines are usually easier to understand in <2 seconds.",
        actions: ["Cut hero headline length by ~30–50%.", "Remove qualifiers and stack detail into the subheadline."],
        evidence: [`Hero length A=${ax.metrics?.heroLength}, B=${bx.metrics?.heroLength}`],
      });
    } else if (bh.clearerHero) {
      recs.push({
        title: "Adopt the shorter, faster-to-parse hero headline",
        appliesTo: "site_a",
        rationale: "Shorter hero headlines are usually easier to understand in <2 seconds.",
        actions: ["Cut hero headline length by ~30–50%.", "Remove qualifiers and stack detail into the subheadline."],
        evidence: [`Hero length A=${ax.metrics?.heroLength}, B=${bx.metrics?.heroLength}`],
      });
    }

    if (ah.strongerTrust) {
      recs.push({
        title: "Move trust/compliance language higher (borrow trust-first structure)",
        appliesTo: "site_b",
        rationale: "Trust signals early reduce anxiety and increase conversion for high-consideration products.",
        actions: [
          "Add a trust strip right after the hero: compliance/security/uptime + logos.",
          "Use specific proof (numbers, certifications) instead of vague claims.",
        ],
        evidence: [`Trust mentions A=${ax.metrics?.trustMentions}, B=${bx.metrics?.trustMentions}`],
      });
    } else if (bh.strongerTrust) {
      recs.push({
        title: "Move trust/compliance language higher (borrow trust-first structure)",
        appliesTo: "site_a",
        rationale: "Trust signals early reduce anxiety and increase conversion for high-consideration products.",
        actions: [
          "Add a trust strip right after the hero: compliance/security/uptime + logos.",
          "Use specific proof (numbers, certifications) instead of vague claims.",
        ],
        evidence: [`Trust mentions A=${ax.metrics?.trustMentions}, B=${bx.metrics?.trustMentions}`],
      });
    }

    const answer =
      "If you’re copying anything, copy the *structure*: outcome-led hero → trust proof → simple next step. Then copy the *tone*: confident, specific, and low-noise.";

    return { answer, recommendations: recs, note };
  }

  // Color-focused compare
  if (focus === "color") {
    recs.push({
      title: "Borrow one accent color, not the whole palette",
      appliesTo: "both",
      rationale:
        "Most strong brands use neutral backgrounds + one consistent accent. Borrowing everything makes you look derivative.",
      actions: [
        "Pick 1 accent color from the reference site and apply it only to: primary buttons, links, highlights.",
        "Keep backgrounds neutral and typography high-contrast.",
        "Ensure accessible contrast (especially button text).",
      ],
      evidence: [
        `Site A palette: ${(ax.palette || []).map((c) => c.value).join(", ") || "n/a"}`,
        `Site B palette: ${(bx.palette || []).map((c) => c.value).join(", ") || "n/a"}`,
      ],
    });

    recs.push({
      title: "Standardize your UI color roles",
      appliesTo: "both",
      rationale: "Great UI feels consistent because colors map to roles, not random sections.",
      actions: [
        "Define roles: background, surface, text, muted, border, accent, accent-hover, success, warning, danger.",
        "Replace ad-hoc colors with tokens.",
      ],
    });

    const answer =
      "I extracted a best-effort palette from inline/styles. For accurate branding guidance, we can also fetch the main CSS later. For now: borrow a single accent and keep everything else neutral + consistent.";

    return { answer, recommendations: recs, note };
  }

  // UX/general compare
  recs.push({
    title: "Reduce above-the-fold clutter (copy the simpler hero layout)",
    appliesTo: "both",
    rationale: "The first screen should communicate one thing and one next step.",
    actions: ["Keep 1 primary CTA, 1 secondary CTA max.", "Delay feature grids and product catalogs until after the first scroll."],
    evidence: [
      `CTA count A=${ax.metrics?.ctaCount}, B=${bx.metrics?.ctaCount}`,
      `Nav links A=${ax.metrics?.navCount}, B=${bx.metrics?.navCount}`,
    ],
  });

  if (ah.fewerCTAs) {
    recs.push({
      title: "Borrow the tighter CTA discipline",
      appliesTo: "site_b",
      rationale: "Fewer CTAs usually means clearer conversion intent.",
      actions: ["Cut hero CTAs down to 1 primary + 1 secondary.", "Move everything else below the fold."],
      evidence: [`CTA count A=${ax.metrics?.ctaCount}, B=${bx.metrics?.ctaCount}`],
    });
  } else if (bh.fewerCTAs) {
    recs.push({
      title: "Borrow the tighter CTA discipline",
      appliesTo: "site_a",
      rationale: "Fewer CTAs usually means clearer conversion intent.",
      actions: ["Cut hero CTAs down to 1 primary + 1 secondary.", "Move everything else below the fold."],
      evidence: [`CTA count A=${ax.metrics?.ctaCount}, B=${bx.metrics?.ctaCount}`],
    });
  }

  const answer =
    "High leverage improvements usually come from structure, not features: clearer hero promise, fewer competing CTAs, and trust proof placed earlier.";

  return { answer, recommendations: recs, note };
}

/* -------------------- main handler -------------------- */

export async function webPublicAnalysisV1(
  runId: string,
  args: { prompt: string; urls: string[] }
): Promise<WebPublicAnalysisOutput> {
  const prompt = String(args?.prompt || "").trim();
  const focus = detectFocus(prompt);

  const urls = Array.isArray(args?.urls) ? args.urls : [];
  const cleaned = uniqCompact(urls.map(normalizeUrl).filter(Boolean), 4);

  emit(runId, "info", "Analyzing public websites", { urls: cleaned, focus });

  const sites: WebResult[] = [];

  for (const url of cleaned.slice(0, 2)) {
    try {
      const html = await fetchWithTimeout(url);
      const title = extractTitle(html);
      const description = extractMetaContent(html, "description") || extractMetaContent(html, "og:description");
      const h1 = extractH1(html);
      const h2 = extractH2(html);
      const ctas = extractButtonsAndPrimaryLinks(html);
      const navLinks = extractNavLinks(html);
      const palette = extractPalette(html);

      // Raw text for metrics
      const rawText = stripTags(html).slice(0, 200_000);
      const extract: WebSiteExtract = {
        title,
        description,
        h1,
        h2,
        ctas,
        navLinks,
        palette,
      };
      extract.metrics = buildMetrics(prompt, extract, rawText);

      sites.push({ url, ok: true, extract });
    } catch (e: any) {
      sites.push({
        url,
        ok: false,
        error: e?.message ? String(e.message) : "Site is hard to analyze right now",
      });
    }
  }

  const composed = composeAnswer({ prompt, focus, sites });

  return {
    kind: "web_public_analysis",
    question: prompt,
    focus,
    answer: composed.answer,
    recommendations: composed.recommendations,
    sites,
    note: composed.note,
  };
}
