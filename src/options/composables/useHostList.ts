// ── Host whitelist editing ────────────────────────────────────────────
// `uploadAsContentSites` and `listing.hoverZoomSites` are both "normalised
// host, no duplicates" lists that were maintained by two copies of the same
// add/remove pair.

import { normalizeHost } from "~/shared/host";

export interface HostListAccess {
  /** Current list; may be undefined on configs written before the field existed. */
  get(): string[] | undefined;
  /** Called with a fresh array when the field first needs to exist. */
  init(list: string[]): void;
}

export function useHostList(access: HostListAccess) {
  function add(raw: string): void {
    const host = normalizeHost(raw);
    if (!host) return;
    if (!access.get()) access.init([]);
    const list = access.get()!;
    if (!list.includes(host)) list.push(host);
  }

  function remove(host: string): void {
    const list = access.get();
    if (!list) return;
    const index = list.indexOf(host);
    if (index >= 0) list.splice(index, 1);
  }

  return { add, remove };
}
