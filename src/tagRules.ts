// ── Tag blacklist / auto-rename rules ────────────────────────────────
// Applied to every scraped tag before it reaches szurubooru, both on the
// popup path (PopupMain) and the background path (hotkey / context menu),
// so the same rules govern every import route.
//
// Pattern syntax (shared by blacklist and rewrites):
//   plain     "absurdres"        exact match, case-insensitive
//   glob      "artist:*"         "*" matches any run of characters
//   regex     "/^\d+girls?$/"    full regex, unanchored unless you anchor it
//
// Rewrites may reference glob/regex captures with $1, $2, … — a glob "*"
// is compiled to a capturing group, so "artist:*" → "$1" strips the prefix.

export interface TagRewriteRule {
  from: string;
  to: string;
}

export interface TagRulesConfig {
  enabled?: boolean;
  blacklist?: string[];
  rewrites?: TagRewriteRule[];
}

// Compiling a pattern is cheap but happens once per tag per import; a booru
// page with 200 tags and 20 rules would otherwise recompile 4000 regexes.
const patternCache = new Map<string, RegExp | null>();

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a user-supplied pattern. Returns null for patterns that are empty
 * or syntactically invalid — an unusable rule is skipped rather than aborting
 * the whole import.
 */
export function compileTagPattern(pattern: string): RegExp | null {
  const key = pattern;
  if (patternCache.has(key)) return patternCache.get(key)!;

  let compiled: RegExp | null = null;
  const trimmed = pattern.trim();

  if (trimmed) {
    const regexForm = /^\/(.*)\/([gimsuy]*)$/.exec(trimmed);
    try {
      if (regexForm) {
        // Strip "g": the rules run per tag name and a sticky lastIndex would
        // make consecutive tags match inconsistently.
        compiled = new RegExp(regexForm[1], regexForm[2].replace(/g/g, ""));
      } else {
        // Glob: escape everything, then turn the escaped "*" back into a
        // capturing group so rewrites can reference it as $1.
        const body = escapeRegex(trimmed).replace(/\\\*/g, "(.*)");
        compiled = new RegExp(`^${body}$`, "i");
      }
    } catch {
      compiled = null;
    }
  }

  patternCache.set(key, compiled);
  return compiled;
}

export interface TagRuleEngine {
  /** True when at least one usable rule exists — lets callers skip the work. */
  readonly active: boolean;
  /** Resulting tag name, or undefined when the tag is dropped. */
  apply(name: string): string | undefined;
}

export function createTagRuleEngine(rules?: TagRulesConfig): TagRuleEngine {
  const blacklist = (rules?.blacklist ?? [])
    .map((p) => compileTagPattern(p))
    .filter((re): re is RegExp => !!re);

  const rewrites = (rules?.rewrites ?? [])
    .map((rule) => ({ re: compileTagPattern(rule.from), to: rule.to ?? "" }))
    .filter((rule): rule is { re: RegExp; to: string } => !!rule.re);

  const active = rules?.enabled !== false && (blacklist.length > 0 || rewrites.length > 0);

  const isBlacklisted = (name: string) => blacklist.some((re) => re.test(name));

  return {
    active,
    apply(name: string): string | undefined {
      if (!active) return name;

      const original = name.trim();
      if (!original) return undefined;
      if (isBlacklisted(original)) return undefined;

      // Rewrites chain: the output of one rule is the input of the next, so
      // "artist:*" → "$1" followed by "*_(artist)" → "$1" both apply.
      let result = original;
      for (const rule of rewrites) {
        if (rule.re.test(result)) {
          result = result.replace(rule.re, rule.to);
        }
      }

      result = result.trim();
      if (!result) return undefined;
      // Re-check: a rewrite can produce a name the user blacklisted.
      if (result !== original && isBlacklisted(result)) return undefined;

      return result;
    },
  };
}

/**
 * Apply the rules to a flat list of tag names, dropping blacklisted entries
 * and de-duplicating case-insensitively (szurubooru treats tag names as
 * case-insensitive, so two rewrites collapsing onto one name is common).
 */
export function applyTagRulesToNames(names: string[], rules?: TagRulesConfig): string[] {
  const engine = createTagRuleEngine(rules);
  if (!engine.active) return names;

  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of names) {
    const applied = engine.apply(name);
    if (!applied) continue;
    const key = applied.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(applied);
  }
  return result;
}

/**
 * Apply the rules to tag objects whose name lives in `names[0]`
 * (TagDetails and the plain background-side tag shape both match).
 */
export function applyTagRulesToTagList<T extends { names: string[] }>(tags: T[], rules?: TagRulesConfig): T[] {
  const engine = createTagRuleEngine(rules);
  if (!engine.active) return tags;

  const seen = new Set<string>();
  const result: T[] = [];
  for (const tag of tags) {
    const applied = engine.apply(tag.names?.[0] ?? "");
    if (!applied) continue;
    const key = applied.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Keep every other field (category, implications, usages) intact.
    tag.names = [applied, ...tag.names.slice(1)];
    result.push(tag);
  }
  return result;
}

export interface TagRulePreviewRow {
  input: string;
  output?: string;
  dropped: boolean;
  changed: boolean;
}

/** Drives the live rule tester in the options page. */
export function previewTagRules(names: string[], rules?: TagRulesConfig): TagRulePreviewRow[] {
  const engine = createTagRuleEngine(rules);
  return names.map((input) => {
    const output = engine.apply(input);
    return {
      input,
      output,
      dropped: output === undefined,
      changed: output !== undefined && output !== input.trim(),
    };
  });
}
