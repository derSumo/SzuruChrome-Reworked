import type { TagRulesConfig } from "~/tagRules";
import { BooruTypes, ContentType, ScrapedNote, ScrapedPost, ScrapedTag, UploadMode } from "neo-scraper";
import { MicroTag, Pool, Tag, UpdatePostRequest } from "~/api/models";

export class TagDetails {
  public implications: TagDetails[] = [];

  constructor(
    public names: string[],
    public category?: string,
    public usages?: number,
  ) { }

  get name() {
    return this.names[0];
  }

  static fromTag(tag: Tag) {
    const x = new TagDetails(tag.names, tag.category, tag.usages);

    if (tag.implications) {
      x.implications = tag.implications.map((y) => TagDetails.fromMicroTag(y));
    }

    return x;
  }

  static fromMicroTag(tag: MicroTag) {
    return new TagDetails(tag.names, tag.category, tag.usages);
  }

  static fromScapedTag(tag: ScrapedTag): TagDetails {
    return new TagDetails([tag.name], tag.category);
  }
}

export class PoolDetails {
  constructor(
    public names: string[],
    public category?: string,
    public postCount?: number,
  ) { }

  get name() {
    return this.names[0];
  }

  static fromPool(pool: Pool) {
    return new PoolDetails(pool.names, pool.category, pool.postCount);
  }
}

export class InstanceSpecificData {
  contentToken?: string;
  genericError?: string;
  reverseSearchResult?: SimpleImageSearchResult;
  uploadState?: PostUploadInfo;
  // Tags harvested from visually similar posts during the reverse search,
  // offered as one-click suggestions in the popup. Ranked by how many similar
  // posts carry them.
  suggestedTags?: TagDetails[];
}

type MappedInstanceSpecificData = {
  [key: string]: InstanceSpecificData;
};

export class ScrapedPostDetails {
  // `crypto` (not `window.crypto`) so the class is also constructible from the
  // MV3 service worker, which has no `window`.
  id: string = crypto.randomUUID();
  name = "";
  tags: TagDetails[] = [];
  pools: PoolDetails[] = [];
  notes: ScrapedNote[];
  contentUrl: string;
  extraContentUrl: string | undefined;
  contentSize: number | undefined;
  pageUrl: string;
  contentType: ContentType;
  contentSubType: string | undefined;
  rating: BooruTypes.SafetyRating;
  source;
  uploadMode: UploadMode;
  referrer?: string;
  resolution?: [number, number];
  /**
   * Pixel size read from the downloaded file itself. Unlike `resolution` (which
   * only exists when the booru printed one) this is always trustworthy, so the
   * duplicate comparison prefers it.
   */
  measuredResolution?: [number, number];
  instanceSpecificData: MappedInstanceSpecificData = {};

  constructor(post: ScrapedPost) {
    this.contentUrl = post.contentUrl;
    this.extraContentUrl = post.extraContentUrl;
    // this.contentSize = post.contentSize;
    this.pageUrl = post.pageUrl;
    this.contentType = post.contentType;
    this.rating = post.rating;
    this.source = post.sources.join("\n");
    this.referrer = post.referrer;
    this.tags = post.tags.filter((x) => x.name && x.name.trim()).map((x) => TagDetails.fromScapedTag(x));
    this.notes = post.notes;
    this.resolution = post.resolution;
    this.uploadMode = post.uploadMode;
  }
}

export interface SimpleImageSearchResult {
  exactPostId?: number;
  similarPosts: SimpleSimilarPost[];
}

export interface SimpleSimilarPost {
  distance: number;
  postId: number;
}

export class SimilarPostInfo {
  constructor(
    public readonly id: number,
    public readonly percentage: number,
  ) { }
}

export type PostUploadState = "uploading" | "uploaded" | "error";

export class PostUploadInfo {
  state: PostUploadState = "uploading";
  error?: string;
  instancePostId?: number;
  existingPostId?: number;
  relatedPostIds?: number[];
  duplicateOutcome?: "replaced" | "tags_merged";
  updateTagsState?: {
    total: number;
    current?: number;
    totalChanged?: number;
  };
}

export type BrowserCommandName =
  | "grab_post"
  | "upload_post"
  | "set_post_upload_info"
  | "set_exact_post_id"
  | "update_post"
  | "set_post_update_info"
  | "fetch"
  | "fetch_content"
  | "fetch_head_info"
  | "quick_import_status"
  | "get_active_imports"
  | "report_progress"
  | "check_imported"
  | "check_imported_bulk"
  | "retry_failed_import"
  | "stats_mutate"
  | "batch_import"
  | "batch_selection"
  | "batch_active"
  | "batch_cancel"
  | "batch_status"
  | "import_post_url"
  | "inject_listing_extras";

export class BrowserCommand<T = any> {
  name: BrowserCommandName;
  data?: T;

  constructor(name: BrowserCommandName, data?: T) {
    this.name = name;
    this.data = data;
  }
}

export class PostUploadCommandData {
  constructor(
    public readonly post: ScrapedPostDetails,
    public readonly selectedSite: SzuruSiteConfig,
    public readonly tabId?: number,
    public readonly importId?: string,
  ) { }
}

export class SetPostUploadInfoData {
  constructor(
    public instanceId: string,
    public postId: string,
    public info: PostUploadInfo,
  ) { }
}

export class SetExactPostId {
  constructor(
    public readonly instanceId: string,
    public readonly postId: string,
    public readonly exactPostId: number,
  ) { }
}

export class PostUpdateCommandData {
  constructor(
    public readonly postId: number,
    public readonly updateRequest: UpdatePostRequest,
    public readonly selectedSite: SzuruSiteConfig,
  ) { }
}

export class FetchCommandData {
  constructor(
    public readonly url: string,
    public readonly options: RequestInit | undefined = undefined,
  ) { }
}

export class SzuruSiteConfig {
  // Explicitly `string`: `randomUUID()` is typed as a template literal, which
  // would reject any id round-tripped through storage.
  id: string = crypto.randomUUID();
  domain = "https://example.com";
  username = "user";
  authToken = "";
  /**
   * Per-instance override for the global tag rules. Undefined — the normal
   * case — means this instance uses the global set. Set it when one instance
   * wants different tags than another (an SFW and an NSFW instance, or a
   * different naming convention per target).
   */
  tagRules?: TagRulesConfig;
}

export class TagCategoryColor {
  constructor(
    public name: string,
    public color: string,
  ) { }
}

export const getDefaultTagCategories = () => [
  new TagCategoryColor("copyright", "#a0a"),
  new TagCategoryColor("character", "#0a0"),
  new TagCategoryColor("artist", "#a00"),
  new TagCategoryColor("meta", "#f80"),
];
