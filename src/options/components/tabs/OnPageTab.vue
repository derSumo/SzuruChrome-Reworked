<script setup lang="ts">
import { cfg } from "~/stores";
import { useI18n } from "~/i18n/vue";
import { useHostList } from "../../composables/useHostList";
import SettingCard from "../SettingCard.vue";
import SettingRow from "../SettingRow.vue";
import SettingToggle from "../SettingToggle.vue";
import SettingSlider from "../SettingSlider.vue";
import ChipListEditor from "../ChipListEditor.vue";

const { t } = useI18n();

const zoomSites = useHostList({
  get: () => cfg.value.listing.hoverZoomSites,
  init: (list) => (cfg.value.listing.hoverZoomSites = list),
});
</script>

<template>
  <div class="tab-content">
    <h2 class="tab-title">{{ t("options.onPage.title") }}</h2>
    <p class="tab-lede">{{ t("options.onPage.lede") }}</p>

    <SettingCard :title="t('options.badge.title')">
      <SettingRow path="importedBadge.enabled" :label="t('options.badge.enable')" :hint="t('options.badge.enableHint')">
        <SettingToggle v-model="cfg.importedBadge.enabled" />
      </SettingRow>

      <template v-if="cfg.importedBadge.enabled">
        <SettingRow
          path="importedBadge.showWhenNotImported"
          :label="t('options.badge.showMissing')"
          :hint="t('options.badge.showMissingHint')"
        >
          <SettingToggle v-model="cfg.importedBadge.showWhenNotImported" />
        </SettingRow>

        <SettingRow
          path="importedBadge.thumbnails"
          :label="t('options.badge.thumbnails')"
          :hint="t('options.badge.thumbnailsHint')"
        >
          <SettingToggle v-model="cfg.importedBadge.thumbnails" />
        </SettingRow>
      </template>
    </SettingCard>

    <SettingCard :title="t('options.listing.title')">
      <SettingRow
        path="listing.hoverActions"
        :label="t('options.listing.hoverActions')"
        :hint="t('options.listing.hoverActionsHint')"
      >
        <SettingToggle v-model="cfg.listing.hoverActions" />
      </SettingRow>

      <SettingRow
        path="listing.endlessScroll"
        :label="t('options.listing.endlessScroll')"
        :hint="t('options.listing.endlessScrollHint')"
      >
        <SettingToggle v-model="cfg.listing.endlessScroll" />
      </SettingRow>

      <SettingRow path="listing.hoverZoom" :label="t('options.listing.hoverZoom')" :hint="t('options.listing.hoverZoomHint')">
        <SettingToggle v-model="cfg.listing.hoverZoom" />
      </SettingRow>

      <template v-if="cfg.listing.hoverZoom">
        <SettingRow
          path="listing.hoverZoomScope"
          :label="t('options.listing.hoverZoomScope')"
          :hint="t('options.listing.hoverZoomScopeHint')"
        >
          <div class="select-wrapper">
            <select v-model="cfg.listing.hoverZoomScope">
              <option value="sites">{{ t("options.listing.hoverZoomScopeSites") }}</option>
              <option value="all">{{ t("options.listing.hoverZoomScopeAll") }}</option>
            </select>
          </div>
        </SettingRow>

        <SettingRow
          path="listing.hoverZoomDelayMs"
          :label="t('options.listing.hoverZoomDelay')"
          :hint="t('options.listing.hoverZoomDelayHint')"
        >
          <SettingSlider
            v-model="cfg.listing.hoverZoomDelayMs"
            :min="0"
            :max="1500"
            :step="50"
            :display="`${cfg.listing.hoverZoomDelayMs} ms`"
          />
        </SettingRow>
      </template>

      <template v-if="cfg.listing.hoverZoom && cfg.listing.hoverZoomScope === 'sites'">
        <p class="card-hint">{{ t("options.listing.hoverZoomSitesHint") }}</p>

        <ChipListEditor
          :items="cfg.listing.hoverZoomSites ?? []"
          :empty-text="t('options.listing.hoverZoomSitesEmpty')"
          :placeholder="t('options.general.uploadAsContentAddPlaceholder')"
          :add-label="t('options.general.uploadAsContentAdd')"
          @add="zoomSites.add"
          @remove="(_index, host) => zoomSites.remove(host)"
        />
      </template>
    </SettingCard>

    <SettingCard :title="t('options.batch.title')">
      <SettingRow path="batchImport.enabled" :label="t('options.batch.enable')" :hint="t('options.batch.enableHint')">
        <SettingToggle v-model="cfg.batchImport.enabled" />
      </SettingRow>

      <template v-if="cfg.batchImport.enabled">
        <SettingRow
          path="batchImport.skipImported"
          :label="t('options.batch.skipImported')"
          :hint="t('options.batch.skipImportedHint')"
        >
          <SettingToggle v-model="cfg.batchImport.skipImported" />
        </SettingRow>

        <SettingRow
          path="batchImport.oldestFirst"
          :label="t('options.batch.oldestFirst')"
          :hint="t('options.batch.oldestFirstHint')"
        >
          <SettingToggle v-model="cfg.batchImport.oldestFirst" />
        </SettingRow>

        <SettingRow
          path="batchImport.separateWindow"
          :label="t('options.batch.separateWindow')"
          :hint="t('options.batch.separateWindowHint')"
        >
          <SettingToggle v-model="cfg.batchImport.separateWindow" />
        </SettingRow>

        <SettingRow
          path="batchImport.concurrency"
          :label="t('options.batch.concurrency')"
          :hint="t('options.batch.concurrencyHint')"
        >
          <SettingSlider
            v-model="cfg.batchImport.concurrency"
            :min="1"
            :max="3"
            :display="`${cfg.batchImport.concurrency}×`"
          />
        </SettingRow>

        <SettingRow path="batchImport.maxPosts" :label="t('options.batch.maxPosts')" :hint="t('options.batch.maxPostsHint')">
          <input
            type="number"
            min="1"
            max="10000"
            step="10"
            v-model.number="cfg.batchImport.maxPosts"
            class="limit-input"
          />
        </SettingRow>

        <SettingRow path="batchImport.maxPages" :label="t('options.batch.maxPages')" :hint="t('options.batch.maxPagesHint')">
          <input
            type="number"
            min="1"
            max="500"
            step="1"
            v-model.number="cfg.batchImport.maxPages"
            class="limit-input"
          />
        </SettingRow>
      </template>
    </SettingCard>
  </div>
</template>
