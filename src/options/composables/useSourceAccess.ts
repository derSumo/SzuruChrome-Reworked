// ── Optional host permissions for the supported booru sites ───────────

import { ref } from "vue";
import {
  SOURCE_SITES,
  hasSourceSitePermission,
  removeSourceSitePermission,
  requestSourceSitePermission,
  type SourceSite,
} from "~/shared/sourceSites";
import { getErrorMessage } from "~/utils";

export function useSourceAccess(onError: (message: string) => void) {
  const access = ref<Record<string, boolean>>({});

  async function refresh(): Promise<void> {
    const values = await Promise.all(
      SOURCE_SITES.map(async (site) => [site.id, await hasSourceSitePermission(site)] as const),
    );
    access.value = Object.fromEntries(values);
  }

  async function set(site: SourceSite, enabled: boolean): Promise<void> {
    try {
      // The first call inside this handler is the permission request/removal, so
      // Chrome still considers it a direct user gesture.
      const changed = enabled ? await requestSourceSitePermission(site) : await removeSourceSitePermission(site);
      access.value = { ...access.value, [site.id]: enabled && changed };
    } catch (ex) {
      onError(getErrorMessage(ex));
      await refresh();
    }
  }

  return { access, refresh, set };
}
