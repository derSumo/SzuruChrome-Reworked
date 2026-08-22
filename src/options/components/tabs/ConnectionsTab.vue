<script setup lang="ts">
// Where posts go (szurubooru instances) and where they come from (which booru
// hosts the extension is allowed to touch). Both are "what is this connected
// to?", which is why the source-site permissions moved here from "General".

import { computed, onMounted, ref } from "vue";
import { cfg } from "~/stores";
import { SzuruSiteConfig } from "~/models";
import SzurubooruApi from "~/api";
import { ensureInstancePermission } from "~/shared/sourceSites";
import { getErrorMessage } from "~/utils";
import { useI18n } from "~/i18n/vue";
import { useStatusMessage } from "../../composables/useStatusMessage";
import { useSourceAccess } from "../../composables/useSourceAccess";
import SettingCard from "../SettingCard.vue";
import SourceAccessSettings from "../SourceAccessSettings.vue";

const { t } = useI18n();
const { text: statusText, type: statusType, set: setStatus } = useStatusMessage();

const sourceAccessError = ref("");
const {
  access: sourceSiteAccess,
  refresh: refreshSourceAccess,
  set: setSourceSiteAccess,
} = useSourceAccess((message) => (sourceAccessError.value = message));
onMounted(() => void refreshSourceAccess());

const selectedSite = computed(() => {
  if (cfg.value.selectedSiteId) {
    return cfg.value.sites.find((x) => x.id == cfg.value.selectedSiteId);
  }
});

function addSite() {
  const site = new SzuruSiteConfig();
  cfg.value.sites.push(site);
  cfg.value.selectedSiteId = site.id;
}

function removeSelectedSite() {
  if (selectedSite.value) {
    const idx = cfg.value.sites.indexOf(selectedSite.value);
    cfg.value.sites.splice(idx, 1);
  }
  cfg.value.selectedSiteId = cfg.value.sites.length > 0 ? cfg.value.sites[0].id : undefined;
}

async function testConnection() {
  const site = selectedSite.value;
  if (!site?.domain || !site.username || !site.authToken) {
    setStatus(t("options.instances.required"), "error");
    return;
  }
  if (!(await ensureInstancePermission(site.domain))) {
    setStatus(t("options.instances.permissionRequired"), "error");
    return;
  }
  const api = new SzurubooruApi(site.domain, site.username, site.authToken);
  try {
    const info = await api.getInfo();
    const instanceName = info?.config.name;
    if (instanceName == undefined) {
      setStatus(t("options.instances.connectedNoName", { domain: site.domain }), "error");
    } else {
      setStatus(t("options.instances.connected", { name: instanceName, domain: site.domain }), "success");
    }
  } catch (ex) {
    setStatus(t("options.instances.connectFailed", { domain: site.domain, error: getErrorMessage(ex) }), "error");
  }
}
</script>

<template>
  <div class="tab-content">
    <h2 class="tab-title">{{ t("options.connections.title") }}</h2>

    <SettingCard :title="t('options.instances.servers')">
      <div class="instance-bar">
        <select v-model="cfg.selectedSiteId" class="instance-select">
          <option v-for="site in cfg.sites" :key="site.id" :value="site.id">
            {{ site.username }} @ {{ site.domain }}
          </option>
          <option v-if="cfg.sites.length === 0" disabled value="">{{ t("options.instances.noInstances") }}</option>
        </select>
        <button class="btn btn-primary" @click="addSite">{{ t("options.instances.add") }}</button>
        <button class="btn btn-danger" :disabled="!selectedSite" @click="removeSelectedSite">
          {{ t("options.instances.remove") }}
        </button>
      </div>

      <template v-if="selectedSite">
        <div class="divider"></div>

        <div class="form-group">
          <label class="form-label">{{ t("options.instances.url") }}</label>
          <input type="text" placeholder="https://szuru.example.com" v-model="selectedSite.domain" />
        </div>

        <div class="form-row">
          <div class="form-group">
            <label class="form-label">{{ t("options.instances.username") }}</label>
            <input type="text" placeholder="username" v-model="selectedSite.username" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t("options.instances.authToken") }}</label>
            <input type="password" placeholder="token" v-model="selectedSite.authToken" />
          </div>
        </div>

        <p v-if="selectedSite.tagRules" class="card-hint instance-rules-note">
          {{ t("options.instances.ownTagRules") }}
        </p>

        <div class="connection-test">
          <button class="btn btn-secondary" @click="testConnection">{{ t("options.instances.testConnection") }}</button>
          <span v-if="statusText" class="status-text" :class="`status-${statusType}`">{{ statusText }}</span>
        </div>
      </template>

      <div v-else class="empty-state">
        <span>{{ t("options.instances.emptyState").replace("{bold}", "").replace("{/bold}", "") }}</span>
      </div>
    </SettingCard>

    <SourceAccessSettings
      :access="sourceSiteAccess"
      :title="t('options.permissions.title')"
      :hint="t('options.permissions.hint')"
      :error="sourceAccessError"
      @change="setSourceSiteAccess"
    />

    <SettingCard :title="t('options.commands.title')" :hint="t('options.commands.hint')">
      <p class="card-hint"><code>chrome://extensions/shortcuts</code></p>
    </SettingCard>
  </div>
</template>
