<script lang="ts" setup>
import { onMounted } from "vue";
import { BrowserCommand, SetPostUploadInfoData, SetExactPostId } from "~/models";
import { Runtime } from "webextension-polyfill";
import { cfg, useMergeStore, usePopupStore } from "~/stores";
import { refreshTagCategoryColorMap } from "~/dynamicStyle";

const pop = usePopupStore();
const merge = useMergeStore();

let el: any;
watch(
  cfg,
  (value) => {
    el = refreshTagCategoryColorMap(value.tagCategories, el);
  },
  { immediate: true },
);

onMounted(() => {
  browser.runtime.onMessage.addListener((cmd: BrowserCommand, _sender: Runtime.MessageSender) => {
    console.log("Popup received message:");
    console.dir(cmd);

    switch (cmd.name) {
      case "set_post_upload_info":
        {
          const { postId, instanceId, info } = <SetPostUploadInfoData>cmd.data;
          let post = pop.posts.find((x) => x.id == postId);
          if (post) {
            let instanceSpecificData = post.instanceSpecificData[instanceId];
            if (instanceSpecificData) {
              instanceSpecificData.uploadState = info;
            }
          }
        }
        break;
      case "set_exact_post_id":
        {
          const { postId, instanceId, exactPostId } = <SetExactPostId>cmd.data;
          let post = pop.posts.find((x) => x.id == postId);
          if (post && pop.selectedPostId) {
            let instanceSpecificData = post.instanceSpecificData[instanceId];
            if (instanceSpecificData) {
              if (instanceSpecificData?.reverseSearchResult) {
                instanceSpecificData.reverseSearchResult.exactPostId = exactPostId;
              } else {
                instanceSpecificData.reverseSearchResult = { exactPostId, similarPosts: [] };
              }
            }
          }
        }
        break;
      case "set_post_update_info":
        {
          const data = <SetPostUploadInfoData>cmd.data;
          let existing = merge.uploadInfo.find((x) => x.instanceId == data.instanceId && x.postId == data.postId);
          if (existing) {
            existing.info = data.info;
          } else {
            merge.uploadInfo.push(data);
          }
        }
        break;
    }
  });
});
</script>

<template>
  <div class="popup-container">
    <router-view />
  </div>
</template>

<style lang="scss">
@use "~/styles/main.scss";
@use "~/styles/popup.scss";
</style>
