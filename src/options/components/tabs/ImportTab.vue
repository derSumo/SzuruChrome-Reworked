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

const uploadAsContentSites = useHostList({
  get: () => cfg.value.uploadAsContentSites,
  init: (list) => (cfg.value.uploadAsContentSites = list),
});
</script>

<template>
  <div class="tab-content">
    <h2 class="tab-title">{{ t("options.import.title") }}</h2>

    <SettingCard :title="t('options.general.importBehavior')">
      <SettingRow
        path="addPageUrlToSource"
        :label="t('options.general.addPageUrl')"
        :hint="t('options.general.addPageUrlHint')"
      >
        <SettingToggle v-model="cfg.addPageUrlToSource" />
      </SettingRow>

      <SettingRow
        path="addAllParsedTags"
        :label="t('options.general.autoImportTags')"
        :hint="t('options.general.autoImportTagsHint')"
      >
        <SettingToggle v-model="cfg.addAllParsedTags" />
      </SettingRow>

      <SettingRow
        path="alwaysUploadAsContent"
        :label="t('options.general.uploadAsContent')"
        :hint="t('options.general.uploadAsContentHint')"
      >
        <template #label-suffix>
          <span class="warn-tooltip" :title="t('options.general.uploadAsContentWarning')">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="8" cy="8" r="7" stroke="#f59e0b" stroke-width="1.5" />
              <path d="M8 5v4" stroke="#f59e0b" stroke-width="1.5" stroke-linecap="round" />
              <circle cx="8" cy="11.5" r="0.75" fill="#f59e0b" />
            </svg>
          </span>
        </template>
        <SettingToggle v-model="cfg.alwaysUploadAsContent" />
      </SettingRow>

      <SettingRow
        path="addTagImplications"
        :label="t('options.general.addImplications')"
        :hint="t('options.general.addImplicationsHint')"
      >
        <SettingToggle v-model="cfg.addTagImplications" />
      </SettingRow>
    </SettingCard>

    <SettingCard
      :title="t('options.general.uploadAsContentSites')"
      :hint="t('options.general.uploadAsContentSitesHint')"
    >
      <ChipListEditor
        :items="cfg.uploadAsContentSites ?? []"
        :empty-text="t('options.general.uploadAsContentSitesEmpty')"
        :placeholder="t('options.general.uploadAsContentAddPlaceholder')"
        :add-label="t('options.general.uploadAsContentAdd')"
        @add="uploadAsContentSites.add"
        @remove="(_index, host) => uploadAsContentSites.remove(host)"
      />
    </SettingCard>

    <SettingCard :title="t('options.general.autoRelations')">
      <SettingRow
        path="autoRelationsEnabled"
        :label="t('options.general.autoRelationsEnable')"
        :hint="t('options.general.autoRelationsEnableHint')"
      >
        <SettingToggle v-model="cfg.autoRelationsEnabled" />
      </SettingRow>

      <template v-if="cfg.autoRelationsEnabled">
        <SettingRow
          path="autoRelationThreshold"
          :label="t('options.general.autoRelationThreshold')"
          :hint="t('options.general.autoRelationThresholdHint')"
        >
          <SettingSlider
            v-model="cfg.autoRelationThreshold"
            :min="50"
            :max="100"
            :display="`${cfg.autoRelationThreshold}%`"
          />
        </SettingRow>

        <SettingRow
          path="replaceExactDuplicates"
          :label="t('options.general.replaceExactDuplicates')"
          :hint="t('options.general.replaceExactDuplicatesHint')"
        >
          <SettingToggle v-model="cfg.replaceExactDuplicates" />
        </SettingRow>
      </template>
    </SettingCard>

    <SettingCard :title="t('options.queue.title')">
      <SettingRow
        path="queueRetry.enabled"
        :label="t('options.queue.retryEnable')"
        :hint="t('options.queue.retryEnableHint')"
      >
        <SettingToggle v-model="cfg.queueRetry.enabled" />
      </SettingRow>

      <SettingRow
        v-if="cfg.queueRetry.enabled"
        path="queueRetry.maxAttempts"
        :label="t('options.queue.maxAttempts')"
        :hint="t('options.queue.maxAttemptsHint')"
      >
        <SettingSlider
          v-model="cfg.queueRetry.maxAttempts"
          :min="1"
          :max="6"
          :display="`${cfg.queueRetry.maxAttempts}×`"
        />
      </SettingRow>
    </SettingCard>
  </div>
</template>
