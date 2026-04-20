<script lang="ts" setup>
import { isEqual, cloneDeep } from "lodash";
import SzurubooruApi from "~/api";
import { Post, UpdatePostRequest } from "~/api/models";
import { isMobile } from "~/env";
import { BrowserCommand, PostUpdateCommandData, TagDetails } from "~/models";
import { cfg, useMergeStore, usePopupStore } from "~/stores";
import { emptyPost, ensurePostHasContentToken, getErrorMessage, getUrl } from "~/utils";
import { useI18n, setLanguage, Language } from "~/i18n";

const props = defineProps(["siteId", "postId"]);
const merge = useMergeStore();
const pop = usePopupStore();
const { t } = useI18n();

// Sync language from config
watch(() => cfg.value.language, (lang) => setLanguage(lang as Language), { immediate: true });

// Why is this cloneDeep needed? Or maybe it isn't?
const szuruConfig = cloneDeep(cfg.value.sites.find((x) => x.id == props.siteId))!;
const szuru = SzurubooruApi.createFromConfig(szuruConfig);

// Used for the update post request.
// Should NOT be edited by the user, as this is used to compute the changeset, e.g. "Tags: +1 / -3".
let existingPostRo: Post | undefined = undefined;

// Editable existing post.
const post = ref<Post>(emptyPost());

// Readonly scraped post.
const scrapedPost = pop.selectedPost;

// Stuff which the user can change.
const imageToKeep = ref<"current" | "new">("new");
const tagsToAdd = reactive([] as TagDetails[]);

// Computed stuff.
const sourcesAdded = ref(0);
const sourcesRemoved = ref(0);
// tagsAdded = tagsToAdd.length
const tagsRemoved = ref(0);

const contentUrl = computed(() => (imageToKeep.value == "current" ? post.value.contentUrl : scrapedPost?.contentUrl));

function removeExistingTag(tag: TagDetails) {
  const idx = post.value.tags.findIndex((x) => x.names == tag.names);
  if (idx != -1) {
    tagsRemoved.value++;
    post.value.tags.splice(idx, 1);
  }
}

function addTag(tag: TagDetails) {
  // Only add tag if it doesn't already exist
  if (
    tag.name.length > 0 &&
    tagsToAdd.find((x) => x.name == tag.name) == undefined &&
    post.value.tags.find((x) => x.names.indexOf(tag.name) != -1) == undefined
  ) {
    tagsToAdd.push(tag);

    // Add implications for the tag
    if (cfg.value.addTagImplications) {
      tagsToAdd.push(...tag.implications);
    }
  }
}

function removeTagToAdd(tag: TagDetails) {
  const idx = tagsToAdd.indexOf(tag);
  if (idx != -1) {
    tagsToAdd.splice(idx, 1);
  }
}

function appendSources() {
  if (scrapedPost) {
    const re = /\r?\n/;
    const sources = post.value.source?.split(re) ?? [];
    for (const source of scrapedPost.source.split(re)) {
      if (sources.indexOf(source) == -1) {
        sources.push(source);
      }
    }
    post.value.source = sources.join("\n");
  }
}

function addMissingTags() {
  if (scrapedPost) {
    for (const tag of scrapedPost.tags) {
      if (post.value.tags.find((x) => x.names.indexOf(tag.name) != -1) == undefined) {
        tagsToAdd.push(tag);
      }
    }
  }
}

function mergeSafety() {
  if (scrapedPost) {
    post.value.safety = scrapedPost.rating;
  }
}

function getPostUrl(postId: number): string {
  return getUrl(szuruConfig.domain, "post", postId.toString());
}

async function mergeChanges() {
  merge.genericError = undefined;

  if (!scrapedPost) {
    // Should never happend.
    merge.genericError = t("merge.invalidScraped");
    return;
  }

  if (!existingPostRo) {
    // Should only happen with an network error I guess?
    merge.genericError = t("merge.invalidExisting");
    return;
  }

  const req = <UpdatePostRequest>{
    version: existingPostRo?.version,
  };

  if (post.value.source != existingPostRo.source) {
    req.source = post.value.source;
  }

  const newTags = post.value.tags.map((x) => x.names[0]).filter((n) => n && n.trim())
    .concat(tagsToAdd.map((x) => x.name).filter((n) => n && n.trim()));

  if (
    !isEqual(
      newTags,
      existingPostRo.tags.map((x) => x.names[0]),
    )
  ) {
    req.tags = newTags;
  }

  if (post.value.safety != existingPostRo.safety) {
    req.safety = post.value.safety;
  }

  if (imageToKeep.value == "new") {
    // In practice this should not be needed, because finding similar posts requires the use of content tokens.
    // So if a similar post is found, it means that a contentToken has already been set.
    ensurePostHasContentToken(szuru, scrapedPost, cfg);
    req.contentToken = scrapedPost.instanceSpecificData[cfg.value.selectedSiteId!].contentToken!;
  }

  if (!req.safety && !req.source && !(req.contentUrl || req.contentToken) && req.tags === undefined) {
    merge.genericError = t("merge.noChanges");
    return;
  }

  merge.uploadInfo.push({
    instanceId: szuruConfig.id,
    postId: `merge-${existingPostRo.id}`,
    info: { state: "uploading", instancePostId: existingPostRo.id },
  });

  const cmdData = new PostUpdateCommandData(existingPostRo.id, req, szuruConfig);
  const cmd = new BrowserCommand("update_post", cmdData);
  try {
    await browser.runtime.sendMessage(cmd);
  } catch (ex) {
    merge.genericError = getErrorMessage(ex);
  }
}

watch(
  () => post.value.source,
  (value, oldValue) => {
    // TODO: Implement this.
    sourcesAdded.value = 0;
    sourcesRemoved.value = 0;
  },
);

watch(
  () => cfg.value.merge.addMissingTags,
  (value) => {
    if (value) {
      addMissingTags();
    } else if (existingPostRo) {
      tagsToAdd.splice(0);
    }
  },
);

watch(
  () => cfg.value.merge.appendSource,
  (value) => {
    if (value) {
      appendSources();
    } else if (existingPostRo) {
      post.value.source = existingPostRo.source;
    }
  },
);

watch(
  () => cfg.value.merge.mergeSafety,
  (value) => {
    if (value) {
      mergeSafety();
    } else if (existingPostRo) {
      post.value.safety = existingPostRo.safety;
    }
  },
);

onMounted(async () => {
  // Clear upload info and error.
  merge.uploadInfo.splice(0);
  merge.genericError = undefined;

  // Load existing post data.
  existingPostRo = await szuru?.getPost(props.postId);

  if (existingPostRo) {
    post.value = cloneDeep(existingPostRo);
    if (cfg.value.merge.appendSource) appendSources();
    if (cfg.value.merge.addMissingTags) addMissingTags();
    if (cfg.value.merge.mergeSafety) mergeSafety();

    if (scrapedPost?.resolution) {
      // Set imageToKeep depending on which image has the largest resolution.
      // TODO: Would be neat if this also uses the fileSize.
      const scrapedPx = scrapedPost.resolution[0] * scrapedPost.resolution[1];
      const existingPx = existingPostRo.canvasHeight * existingPostRo.canvasWidth;

      if (existingPx >= scrapedPx) {
        imageToKeep.value = "current";
      }
    }
  }
});
</script>

<template>
  <div class="popup-messages">
    <div class="messages">
      <div v-if="merge.genericError" class="bg-danger">
        <span>{{ merge.genericError }}</span>
      </div>

      <template v-for="data in merge.uploadInfo">
        <div :key="data.postId" v-if="data.info.state == 'uploaded' && data.info.instancePostId" class="bg-success">
          <a :href="getPostUrl(data.info.instancePostId)">{{ t("merge.mergedInto", { id: data.info.instancePostId }) }}</a>
        </div>

        <div :key="data.postId" v-if="data.info.state == 'uploading'"><span>{{ t("merge.merging") }}</span></div>

        <!-- Only show error when it's not undefined and not empty. -->
        <div :key="data.postId" v-if="data.info.error?.length" class="bg-danger">
          <span>{{ t("merge.mergeFailed", { error: data.info.error }) }}</span>
        </div>
      </template>
    </div>
  </div>

  <div class="popup-columns" :class="{ mobile: isMobile }">
    <div class="popup-left">
      <div class="popup-section">
        <div style="display: flex; flex-direction: column; gap: 5px">
          <div style="display: flex; gap: 5px">
            <button class="bg-danger" @click="$router.back()">
              <font-awesome-icon icon="fa-solid fa-chevron-left" class="cursor-pointer" @click="undefined" />
              {{ t("merge.back") }}
            </button>
            <div class="section-header full">
              <span>{{ t("merge.mergeInto", { id: props.postId }) }}</span>
            </div>
          </div>

          <button class="primary full" @click="mergeChanges">{{ t("merge.mergeChanges") }}</button>
        </div>
      </div>

      <PopupSection :header="t('merge.changes')">
        <div class="section-row">
          <ul class="compact-tags">
            <li v-show="tagsToAdd.length != 0 || tagsRemoved != 0">
              {{ t("merge.tags") }}: <span class="success" v-show="tagsToAdd.length != 0">+{{ tagsToAdd.length }}</span>
              <span class="danger" v-show="tagsRemoved != 0">-{{ tagsRemoved }}</span>
            </li>
            <li v-show="sourcesAdded != 0 || sourcesRemoved != 0">
              {{ t("merge.sources") }}: <span class="success" v-show="sourcesAdded != 0">+2</span>
              <span class="danger" v-show="sourcesRemoved != 0">-1</span>
            </li>
            <li v-show="existingPostRo?.safety != post.safety">
              {{ t("merge.safety") }}: <s class="danger">{{ existingPostRo?.safety }}</s> <span class="success">{{ post.safety }}</span>
            </li>
            <li v-show="imageToKeep == 'new'">
              <span class="success">{{ t("merge.updatingContent") }}</span>
            </li>

            <!-- TODO: Add "No changes" text. -->
          </ul>
        </div>
      </PopupSection>

      <PopupSection :header="t('merge.basicInfo')">
        <div class="section-row">
          <span class="section-label">{{ t("merge.safety") }}</span>

          <div style="display: flex; gap: 10px">
            <label>
              <input type="radio" value="safe" v-model="post.safety" />
              {{ t("merge.safe") }}
            </label>

            <label>
              <input type="radio" value="sketchy" v-model="post.safety" />
              {{ t("merge.sketchy") }}
            </label>

            <label>
              <input type="radio" value="unsafe" v-model="post.safety" />
              {{ t("merge.unsafe") }}
            </label>
          </div>
        </div>

        <div class="section-row">
          <span class="section-label">{{ t("merge.source") }}</span>
          <!-- TODO: Fix this -->
          <textarea v-model="post.source"></textarea>
        </div>
      </PopupSection>

      <PopupSection :header="t('merge.existingTags')" toggleable v-model="cfg.merge.expandExistingTags">
        <div class="section-row">
          <CompactTags
            :tags="post.tags.map((x) => TagDetails.fromMicroTag(x))"
            :show-remove-tag="true"
            :show-usages="true"
            @remove-tag="removeExistingTag"
          />
        </div>
      </PopupSection>

      <PopupSection :header="t('merge.tagsToAdd')" toggleable v-model="cfg.merge.expandAddTags">
        <div class="section-row">
          <TagInput :szuru="szuru" @add-tag="addTag" />
        </div>

        <div class="section-row">
          <CompactTags :tags="tagsToAdd" :show-remove-tag="true" :show-usages="true" @remove-tag="removeTagToAdd" />
        </div>
      </PopupSection>
    </div>

    <div class="popup-right">
      <PopupSection :header="t('merge.content')">
        <div class="section-row">
          <div style="display: flex; gap: 10px; margin: 10px 0">
            <label>
              <input type="radio" value="current" v-model="imageToKeep" />
              {{ t("merge.current") }} ({{ post.canvasWidth }}x{{ post.canvasHeight }})
            </label>

            <!-- TODO: Also display filesize -->

            <label>
              <input type="radio" value="new" v-model="imageToKeep" />
              {{ t("merge.new") }} ({{ scrapedPost?.resolution?.[0] }}x{{ scrapedPost?.resolution?.[1] }})
            </label>
          </div>

          <PostContentDisplay :content-url="contentUrl" content-type="image" />
        </div>
      </PopupSection>

      <PopupSection :header="t('merge.mergeOptions')" toggleable v-model="cfg.merge.expandOptions">
        <div class="section-row">
          <div style="display: flex; flex-direction: column">
            <label>
              <input type="checkbox" v-model="cfg.merge.addMissingTags" />
              {{ t("merge.addMissingTags") }}
            </label>

            <label>
              <input type="checkbox" v-model="cfg.merge.appendSource" />
              {{ t("merge.appendSource") }}
            </label>

            <label>
              <input type="checkbox" v-model="cfg.merge.mergeSafety" />
              {{ t("merge.mergeSafety") }}
            </label>
          </div>
        </div>
      </PopupSection>
    </div>
  </div>
</template>

<style scoped lang="scss">
.popup-left {
  flex: 1 1 auto;
}

.popup-right {
  flex: 1 0 300px;
}
</style>
