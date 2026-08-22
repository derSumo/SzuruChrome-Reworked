<script setup lang="ts">
// Everything tag-shaped in one place: the category colours, and the rules that
// decide which tags survive an import. The rules used to live under "General",
// two tabs away from this one.

import { computed, ref } from "vue";
import { cfg } from "~/stores";
import SzurubooruApi from "~/api";
import { TagCategoryColor, getDefaultTagCategories } from "~/models";
import { ensureInstancePermission } from "~/shared/sourceSites";
import { getActiveTabId, sendTabCommand } from "~/shared/tabs";
import { getFirstScrapedPost } from "~/shared/scrape";
import { previewTagRules, type TagRulesConfig } from "~/tagRules";
import { getErrorMessage } from "~/utils";
import { useI18n } from "~/i18n/vue";
import { useStatusMessage } from "../../composables/useStatusMessage";
import SettingCard from "../SettingCard.vue";
import SettingRow from "../SettingRow.vue";
import SettingToggle from "../SettingToggle.vue";
import ChipListEditor from "../ChipListEditor.vue";

const { t } = useI18n();
const { text: statusText, type: statusType, set: setStatus } = useStatusMessage();

// ── Which rule set is being edited ───────────────────────────
// "" is the global set; anything else is an instance id. An instance without
// its own rules shows the global ones read-only until the user opts in, so it
// is always obvious which rules a given target actually applies.
const ruleTarget = ref("");

const targetSite = computed(() =>
  ruleTarget.value ? cfg.value.sites.find((s) => s.id === ruleTarget.value) : undefined,
);

const hasOwnRules = computed(() => !!targetSite.value?.tagRules);

/** The rule set the editor writes to — global, or the instance's override. */
const rules = computed<TagRulesConfig>(() => {
  if (targetSite.value?.tagRules) return targetSite.value.tagRules;
  return cfg.value.tagRules;
});

/** Editing an instance that has no override yet must not write to the global set. */
const readOnly = computed(() => !!targetSite.value && !hasOwnRules.value);

function enableOwnRules() {
  const site = targetSite.value;
  if (!site) return;
  // Start from the global rules rather than empty: an override almost always
  // means "the same, plus/minus a couple", not "start from nothing".
  site.tagRules = JSON.parse(JSON.stringify(cfg.value.tagRules));
}

function dropOwnRules() {
  const site = targetSite.value;
  if (!site) return;
  if (!window.confirm(t("options.tagRules.dropOverrideConfirm"))) return;
  site.tagRules = undefined;
}

// ── Rule editing ─────────────────────────────────────────────
function addBlacklistPattern(pattern: string) {
  if (readOnly.value) return;
  if (!rules.value.blacklist) rules.value.blacklist = [];
  if (!rules.value.blacklist.includes(pattern)) rules.value.blacklist.push(pattern);
}

function removeBlacklistPattern(index: number) {
  rules.value.blacklist?.splice(index, 1);
}

function addRewriteRule() {
  if (!rules.value.rewrites) rules.value.rewrites = [];
  rules.value.rewrites.push({ from: "", to: "" });
}

// ── Live tester ──────────────────────────────────────────────
const tagRuleTestInput = ref("");
const loadingPageTags = ref(false);

const tagRuleTestRows = computed(() => {
  const names = tagRuleTestInput.value
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (names.length === 0) return [];
  return previewTagRules(names, rules.value);
});

/**
 * Pull the tags off whatever booru page is open, so the tester runs against a
 * real scrape instead of names typed from memory — which is the only way to
 * see what the rules will actually do on the next import.
 */
async function loadTagsFromPage() {
  loadingPageTags.value = true;
  setStatus("", "quiet");
  try {
    const tabId = await getActiveTabId();
    if (typeof tabId !== "number") throw new Error(t("options.tagRules.loadNoTab"));

    const results = await sendTabCommand(tabId, "grab_post");
    const post = getFirstScrapedPost(results);
    const names = (post?.tags ?? []).map((tag) => tag.name).filter((name): name is string => !!name);

    if (names.length === 0) {
      setStatus(t("options.tagRules.loadNoTags"), "error");
      return;
    }
    tagRuleTestInput.value = names.join("\n");
    setStatus(t("options.tagRules.loadOk", { count: names.length }), "success");
  } catch (ex) {
    setStatus(t("options.tagRules.loadFailed", { error: getErrorMessage(ex) }), "error");
  } finally {
    loadingPageTags.value = false;
  }
}

// ── Categories ───────────────────────────────────────────────
function resetTagCategories() {
  cfg.value.tagCategories.splice(0);
  cfg.value.tagCategories.push(...getDefaultTagCategories());
}

function addTagCategory() {
  cfg.value.tagCategories.push(new TagCategoryColor("category", "#abcdef"));
}

async function importTagCategoriesFromInstance() {
  const szuruConfig = cfg.value.sites.find((x) => x.id == cfg.value.selectedSiteId);
  if (!szuruConfig) {
    setStatus(t("options.instances.required"), "error");
    return;
  }
  if (!(await ensureInstancePermission(szuruConfig.domain))) {
    setStatus(t("options.instances.permissionRequired"), "error");
    return;
  }
  try {
    const szuru = SzurubooruApi.createFromConfig(szuruConfig);
    const cats = (await szuru.getTagCategories()).results;
    for (const cat of cats) {
      if (cat.name == "default") continue;
      if (!cfg.value.tagCategories.find((x) => x.name == cat.name)) {
        cfg.value.tagCategories.push(new TagCategoryColor(cat.name, cat.color));
      }
    }
    setStatus("", "quiet");
  } catch (ex) {
    setStatus(
      t("options.instances.connectFailed", { domain: szuruConfig.domain, error: getErrorMessage(ex) }),
      "error",
    );
  }
}
</script>

<template>
  <div class="tab-content">
    <h2 class="tab-title">{{ t("options.tags.title") }}</h2>

    <!-- ── Rules ─────────────────────────────────────────── -->
    <SettingCard :title="t('options.tagRules.title')" :hint="t('options.tagRules.hint')">
      <SettingRow path="tagRules.enabled" :label="t('options.tagRules.enable')" :hint="t('options.tagRules.enableHint')">
        <SettingToggle v-model="cfg.tagRules.enabled" />
      </SettingRow>

      <template v-if="cfg.tagRules.enabled">
        <div v-if="cfg.sites.length > 0" class="rule-target">
          <label class="form-label">{{ t("options.tagRules.rulesFor") }}</label>
          <div class="select-wrapper">
            <select v-model="ruleTarget">
              <option value="">{{ t("options.tagRules.targetGlobal") }}</option>
              <option v-for="site in cfg.sites" :key="site.id" :value="site.id">
                {{ site.username }} @ {{ site.domain }}
              </option>
            </select>
          </div>
          <button v-if="targetSite && !hasOwnRules" class="btn btn-secondary" @click="enableOwnRules">
            {{ t("options.tagRules.useOwnRules") }}
          </button>
          <button v-else-if="targetSite" class="btn btn-danger" @click="dropOwnRules">
            {{ t("options.tagRules.dropOverride") }}
          </button>
        </div>

        <p v-if="readOnly" class="card-hint rule-inherited">{{ t("options.tagRules.inherited") }}</p>

        <fieldset class="rule-fieldset" :disabled="readOnly">
          <p class="rule-syntax">{{ t("options.tagRules.syntax") }}</p>

          <h4 class="sub-title">{{ t("options.tagRules.blacklist") }}</h4>
          <p class="card-hint">{{ t("options.tagRules.blacklistHint") }}</p>

          <ChipListEditor
            :items="rules.blacklist ?? []"
            :empty-text="t('options.tagRules.blacklistEmpty')"
            :placeholder="t('options.tagRules.blacklistPlaceholder')"
            :add-label="t('options.tagRules.add')"
            :remove-title="t('options.tagRules.remove')"
            @add="addBlacklistPattern"
            @remove="removeBlacklistPattern"
          />

          <h4 class="sub-title">{{ t("options.tagRules.rewrites") }}</h4>
          <p class="card-hint">{{ t("options.tagRules.rewritesHint") }}</p>

          <div class="rule-table">
            <div class="rule-table-header">
              <span>{{ t("options.tagRules.from") }}</span>
              <span>{{ t("options.tagRules.to") }}</span>
              <span></span>
            </div>
            <div v-for="(rule, index) in rules.rewrites ?? []" :key="index" class="rule-table-row">
              <input type="text" v-model="rule.from" :placeholder="t('options.tagRules.fromPlaceholder')" />
              <input type="text" v-model="rule.to" :placeholder="t('options.tagRules.toPlaceholder')" />
              <button
                class="btn-icon btn-remove"
                :title="t('options.tagRules.remove')"
                @click="rules.rewrites?.splice(index, 1)"
              >
                ✕
              </button>
            </div>
            <div v-if="(rules.rewrites ?? []).length === 0" class="tag-table-empty">
              {{ t("options.tagRules.rewritesEmpty") }}
            </div>
          </div>

          <div class="card-actions">
            <button class="btn btn-primary" @click="addRewriteRule">{{ t("options.tagRules.addRewrite") }}</button>
          </div>
        </fieldset>

        <h4 class="sub-title">{{ t("options.tagRules.tester") }}</h4>
        <p class="card-hint">{{ t("options.tagRules.testerHint") }}</p>

        <div class="card-actions tester-actions">
          <button class="btn btn-secondary" :disabled="loadingPageTags" @click="loadTagsFromPage">
            {{ loadingPageTags ? t("options.tagRules.loading") : t("options.tagRules.loadFromPage") }}
          </button>
          <button v-if="tagRuleTestInput" class="btn btn-secondary" @click="tagRuleTestInput = ''">
            {{ t("options.tagRules.clearTester") }}
          </button>
        </div>

        <textarea
          class="rule-tester-input"
          rows="4"
          v-model="tagRuleTestInput"
          :placeholder="t('options.tagRules.testerPlaceholder')"
        ></textarea>

        <div class="rule-preview">
          <div v-if="tagRuleTestRows.length === 0" class="uac-empty">
            {{ t("options.tagRules.testerEmpty") }}
          </div>
          <div
            v-for="(row, index) in tagRuleTestRows"
            :key="index"
            class="rule-preview-row"
            :class="{ dropped: row.dropped, changed: row.changed }"
          >
            <span class="rule-preview-in">{{ row.input }}</span>
            <span class="rule-preview-arrow">→</span>
            <span v-if="row.dropped" class="rule-preview-out muted">{{ t("options.tagRules.testerDropped") }}</span>
            <span v-else-if="row.changed" class="rule-preview-out">{{ row.output }}</span>
            <span v-else class="rule-preview-out muted">{{ t("options.tagRules.testerUnchanged") }}</span>
          </div>
        </div>
      </template>
    </SettingCard>

    <!-- ── Category colours ──────────────────────────────── -->
    <SettingCard :title="t('options.tags.colorMapping')" :hint="t('options.tags.colorMappingHint')">
      <div class="tag-table">
        <div class="tag-table-header">
          <span>{{ t("options.tags.categoryName") }}</span>
          <span>{{ t("options.tags.cssColor") }}</span>
          <span>{{ t("options.tags.preview") }}</span>
          <span></span>
        </div>
        <div v-for="(cat, index) in cfg.tagCategories" :key="index" class="tag-table-row">
          <input type="text" v-model="cat.name" placeholder="category name" />
          <div class="color-input-group">
            <input
              type="color"
              class="color-picker"
              :value="cat.color"
              @input="cat.color = ($event.target as HTMLInputElement).value"
            />
            <input type="text" v-model="cat.color" placeholder="#rrggbb" class="color-input" />
          </div>
          <div class="color-preview-row">
            <span class="color-chip" :style="{ background: cat.color }"></span>
            <span class="color-sample-text" :style="{ color: cat.color }">{{ cat.name || "Tag" }}</span>
          </div>
          <button class="btn-icon btn-remove" title="Remove" @click="cfg.tagCategories.splice(index, 1)">✕</button>
        </div>
        <div v-if="cfg.tagCategories.length === 0" class="tag-table-empty">
          {{ t("options.tags.noCategories") }}
        </div>
      </div>

      <div class="card-actions">
        <button class="btn btn-primary" @click="addTagCategory">{{ t("options.tags.addCategory") }}</button>
        <button class="btn btn-secondary" @click="importTagCategoriesFromInstance">
          {{ t("options.tags.importFromInstance") }}
        </button>
        <button class="btn btn-danger ml-auto" @click="resetTagCategories">{{ t("options.tags.resetToDefault") }}</button>
      </div>
    </SettingCard>

    <p v-if="statusText" class="status-text" :class="`status-${statusType}`">{{ statusText }}</p>
  </div>
</template>
