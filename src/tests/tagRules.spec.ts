import { describe, expect, it } from "vitest";
import { applyTagRulesToNames, applyTagRulesToTagList, createTagRuleEngine, previewTagRules } from "~/tagRules";

describe("tag rule patterns", () => {
  it("matches a plain pattern case-insensitively", () => {
    const engine = createTagRuleEngine({ blacklist: ["AbsurdRes"] });
    expect(engine.apply("absurdres")).toBeUndefined();
    expect(engine.apply("highres")).toBe("highres");
  });

  it("supports glob patterns", () => {
    expect(applyTagRulesToNames(["artist:foo", "1girl"], { blacklist: ["artist:*"] })).toEqual(["1girl"]);
  });

  it("supports regex patterns", () => {
    expect(applyTagRulesToNames(["2girls", "1girl", "solo"], { blacklist: ["/^\\d+girls?$/"] })).toEqual(["solo"]);
  });

  it("skips a syntactically invalid pattern instead of failing the import", () => {
    expect(applyTagRulesToNames(["1girl"], { blacklist: ["/[unclosed/"] })).toEqual(["1girl"]);
  });
});

describe("tag rewrites", () => {
  it("substitutes a glob capture into the replacement", () => {
    expect(applyTagRulesToNames(["artist:foo"], { rewrites: [{ from: "artist:*", to: "$1" }] })).toEqual(["foo"]);
  });

  it("chains rewrites so the output of one feeds the next", () => {
    const rules = {
      rewrites: [
        { from: "artist:*", to: "$1" },
        { from: "*_(artist)", to: "$1" },
      ],
    };
    expect(applyTagRulesToNames(["artist:bob_(artist)"], rules)).toEqual(["bob"]);
  });

  it("drops a tag whose rewritten name is blacklisted", () => {
    const rules = { blacklist: ["foo"], rewrites: [{ from: "artist:*", to: "$1" }] };
    expect(applyTagRulesToNames(["artist:foo"], rules)).toEqual([]);
  });

  it("de-duplicates case-insensitively after rewriting", () => {
    const rules = { rewrites: [{ from: "artist:*", to: "$1" }] };
    expect(applyTagRulesToNames(["artist:Foo", "foo"], rules)).toEqual(["Foo"]);
  });
});

describe("rule activation", () => {
  it("passes tags through untouched when disabled", () => {
    const names = ["absurdres", "1girl"];
    expect(applyTagRulesToNames(names, { enabled: false, blacklist: ["absurdres"] })).toEqual(names);
  });

  it("passes tags through untouched when no rules are configured", () => {
    expect(createTagRuleEngine(undefined).active).toBe(false);
    expect(applyTagRulesToNames(["1girl"], undefined)).toEqual(["1girl"]);
  });
});

describe("applyTagRulesToTagList", () => {
  it("rewrites names[0] while preserving the tag's other fields", () => {
    const tags = [{ names: ["artist:foo", "alias"], category: "artist", usages: 12 }];
    const result = applyTagRulesToTagList(tags, { rewrites: [{ from: "artist:*", to: "$1" }] });
    expect(result).toEqual([{ names: ["foo", "alias"], category: "artist", usages: 12 }]);
  });
});

describe("previewTagRules", () => {
  it("reports each row as dropped, changed or untouched", () => {
    const rows = previewTagRules(["absurdres", "artist:foo", "1girl"], {
      blacklist: ["absurdres"],
      rewrites: [{ from: "artist:*", to: "$1" }],
    });
    expect(rows).toEqual([
      { input: "absurdres", output: undefined, dropped: true, changed: false },
      { input: "artist:foo", output: "foo", dropped: false, changed: true },
      { input: "1girl", output: "1girl", dropped: false, changed: false },
    ]);
  });
});
