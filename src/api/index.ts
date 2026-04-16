import axios, { AxiosRequestConfig, CancelToken } from "axios";
import { isEqual } from "lodash";
import {
  TagsResult,
  TagCategoriesResult,
  Post,
  Tag,
  SzuruError,
  ImageSearchResult,
  TagFields,
  TemporaryFileUploadResult,
  UpdatePostRequest,
  PoolsResult,
  PoolFields,
  Pool,
  UpdatePoolRequest,
} from "./models";
import { ScrapedPostDetails, SzuruSiteConfig } from "~/models";
import { UploadMode } from "neo-scraper";
import { guessMimeTypeFromUrl } from "~/utils";

/**
 * A 1:1 wrapper around the szurubooru API.
 *
 * @class SzuruWrapper
 */
export default class SzurubooruApi {
  baseUrl: string;
  apiUrl: string;
  username: string;
  authToken: string;

  private readonly baseHeaders = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  /**
   * Creates an instance of SzuruWrapper.
   * @param {string} baseUrl
   * @memberof SzuruWrapper
   */
  constructor(baseUrl: string, username: string, authToken: string) {
    const x = baseUrl.replace(/\/+$/, ""); // Trim trailing slashes, to make sure we only have one
    this.baseUrl = x + "/";
    this.apiUrl = x + "/api/";
    this.username = username;
    this.authToken = authToken;
  }

  async getInfo(): Promise<any> {
    return (await this.apiGet("info")).data;
  }

  async getPost(id: number): Promise<Post> {
    return (await this.apiGet("post/" + id)).data;
  }

  async updateTag(tag: Tag): Promise<any> {
    return (await this.apiPut("tag/" + encodeURIComponent(tag.names[0]), tag)).data;
  }

  async updatePost(id: number, updateRequest: UpdatePostRequest): Promise<Post> {
    return (await this.apiPut("post/" + id, updateRequest)).data;
  }

  async getTags(
    query: string,
    offset = 0,
    limit = 100,
    fields?: TagFields[],
    cancelToken?: CancelToken,
  ): Promise<TagsResult> {
    const params = new URLSearchParams();
    params.append("offset", offset.toString());
    params.append("limit", limit.toString());

    if (fields && fields.length > 0) params.append("fields", fields.join());
    if (query) params.append("query", query);

    return (await this.apiGet("tags?" + params.toString(), {}, cancelToken)).data;
  }

  async getTagCategories(): Promise<TagCategoriesResult> {
    return (await this.apiGet("tag-categories")).data;
  }

  async createPost(post: ScrapedPostDetails, contentToken?: string): Promise<Post> {
    const obj = <any>{
      tags: post.tags.map((x) => x.names[0]),
      safety: post.rating,
      source: post.source,
      notes: post.notes,
    };

    if (contentToken) {
      obj.contentToken = contentToken;
    } else {
      obj.contentUrl = post.contentUrl;
    }

    console.log("Create new post object");
    console.dir(obj);

    return (await this.apiPost("posts", obj)).data;
  }

  async createPool(name: string, category: string, posts?: number[]): Promise<Pool> {
    const obj = <any>{
      names: [name],
      category,
    };

    if (posts) {
      obj.posts = posts;
    }

    return (await this.apiPost("pool", obj)).data;
  }

  async getPools(
    query?: string,
    offset = 0,
    limit = 100,
    fields?: PoolFields[],
    cancelToken?: CancelToken,
  ): Promise<PoolsResult> {
    const params = new URLSearchParams();
    params.append("offset", offset.toString());
    params.append("limit", limit.toString());

    if (fields && fields.length > 0) params.append("fields", fields.join());
    if (query) params.append("query", query);

    return (await this.apiGet("pools?" + params.toString(), {}, cancelToken)).data;
  }

  async updatePool(id: number, updateRequest: UpdatePoolRequest): Promise<Pool> {
    return (await this.apiPut("pool/" + id, updateRequest)).data;
  }

  async reverseSearch(contentUrl: string): Promise<ImageSearchResult> {
    const obj = { contentUrl };
    return (await this.apiPost("posts/reverse-search", obj)).data;
  }

  async reverseSearchToken(contentToken: string): Promise<ImageSearchResult> {
    const obj = { contentToken };
    return (await this.apiPost("posts/reverse-search", obj)).data;
  }

  async uploadTempFile(
    contentUrl: string,
    uploadMode: UploadMode,
    referrer?: string,
    onProgress?: (progress: number) => void,
  ): Promise<TemporaryFileUploadResult> {
    // For some sources we need to download the image to the client and then upload it to szurubooru.
    // We can't just pass the contentUrl because that would trigger the bot/hotlink protection.

    if (uploadMode == "content") {
      console.log("Upload from content");
      return this.uploadTempFileFromContent(contentUrl, referrer, onProgress);
    } else {
      console.log("Upload from URL");
      return this.uploadTempFileFromUrl(contentUrl);
    }
  }

  async uploadTempFileFromUrl(contentUrl: string): Promise<TemporaryFileUploadResult> {
    const obj = { contentUrl };
    return (await this.apiPost("uploads", obj)).data;
  }

  async uploadTempFileFromBlob(
    blob: Blob,
    filename?: string,
    onProgress?: (progress: number) => void,
  ): Promise<TemporaryFileUploadResult> {
    const fullUrl = this.apiUrl + "uploads";
    const formData = new FormData();
    formData.append("content", blob, filename ?? "file.bin");
    const config: AxiosRequestConfig = {
      method: "POST",
      url: fullUrl,
      data: formData,
    };
    if (onProgress) {
      config.onUploadProgress = (e) => {
        if (e.total && e.total > 0) onProgress(e.loaded / e.total);
      };
    }
    config.headers = { ...this.baseHeaders, "Content-Type": "multipart/form-data" };
    return (await this.execute(config)).data;
  }

  async uploadTempFileFromContent(
    contentUrl: string,
    referrer?: string,
    onProgress?: (progress: number) => void,
  ): Promise<TemporaryFileUploadResult> {
    const fetchOptions: RequestInit = {
      credentials: "include",
      // "unsafe-url" sends the full URL (path + query) as Referer for cross-origin
      // requests, which is required to pass hotlink protection on sites like rule34.xxx.
      referrerPolicy: "unsafe-url",
    };
    if (referrer) {
      fetchOptions.referrer = referrer;
    }
    const res = await fetch(contentUrl, fetchOptions);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    let content = await res.blob();

    // Reject obviously wrong content (e.g. HTML error pages from CDN protection).
    if (content.size < 64) {
      throw new Error(`Response body too small (${content.size} bytes) – likely not actual media content.`);
    }

    const correctedMime = guessMimeTypeFromUrl(contentUrl, content.type);
    if (correctedMime !== content.type) {
      content = new Blob([content], { type: correctedMime });
    }

    // Reject content that looks like an HTML error page rather than media.
    const mimePrefix = correctedMime.split("/")[0];
    if (mimePrefix !== "image" && mimePrefix !== "video" && correctedMime !== "application/x-shockwave-flash") {
      throw new Error(`Unexpected content type '${correctedMime}' – CDN likely returned an error page.`);
    }

    const fullUrl = this.apiUrl + "uploads";

    // Derive a filename from the URL so szurubooru can use the extension as a type hint.
    let filename = "file.bin";
    try {
      const lastSegment = new URL(contentUrl).pathname.split("/").pop();
      if (lastSegment && lastSegment.includes(".")) filename = lastSegment;
    } catch { /* ignore */ }

    const formData = new FormData();
    formData.append("content", content, filename);

    const config: AxiosRequestConfig = {
      method: "POST",
      url: fullUrl,
      data: formData,
    };
    if (onProgress) {
      config.onUploadProgress = (e) => {
        if (e.total && e.total > 0) onProgress(e.loaded / e.total);
      };
    }
    config.headers = { ...this.baseHeaders, "Content-Type": "multipart/form-data" };
    return (await this.execute(config)).data;
  }

  static createFromConfig(siteConfig: SzuruSiteConfig): SzurubooruApi {
    return new SzurubooruApi(siteConfig.domain, siteConfig.username, siteConfig.authToken);
  }

  static createUpdatePostRequest(orig: Post, newPost: Post /*, anonymous = false*/) {
    const detail = <UpdatePostRequest>{ version: newPost.version };

    // Send only changed fields to avoid user privilege violation
    // if (anonymous === true) {
    //   detail.anonymous = true;
    // }

    if (orig.safety != newPost.safety) {
      detail.safety = newPost.safety;
    }

    if (orig.source != newPost.source) {
      detail.source = newPost.source;
    }

    const oldTags = orig.tags.map((x) => x.names[0]);
    const newTags = newPost.tags.map((x) => x.names[0]);
    if (isEqual(oldTags, newTags) == false) {
      detail.tags = newTags;
    }

    return detail;
  }

  private async apiGet(url: string, additionalHeaders: any = {}, cancelToken?: CancelToken): Promise<any> {
    const fullUrl = this.apiUrl + url;
    const config: AxiosRequestConfig = {
      method: "GET",
      url: fullUrl,
      cancelToken,
    };

    config.headers = { ...this.baseHeaders, ...additionalHeaders };
    return this.execute(config);
  }

  private async apiPost(url: string, data: any, additionalHeaders: any = {}): Promise<any> {
    const fullUrl = this.apiUrl + url;
    const config: AxiosRequestConfig = {
      method: "POST",
      url: fullUrl,
      data: data,
    };

    config.headers = { ...this.baseHeaders, ...additionalHeaders };
    return this.execute(config);
  }

  private async apiPut(url: string, data: any, additionalHeaders: any = {}): Promise<any> {
    const fullUrl = this.apiUrl + url;
    const config: AxiosRequestConfig = {
      method: "PUT",
      url: fullUrl,
      data: data,
    };

    config.headers = { ...this.baseHeaders, ...additionalHeaders };
    return this.execute(config);
  }

  private async execute(config: AxiosRequestConfig): Promise<any> {
    if (this.username && this.authToken) {
      const token = "Token " + btoa(`${this.username}:${this.authToken}`);
      if (!config.headers) config.headers = {};
      config.headers["Authorization"] = token;
    }

    try {
      return await axios(config);
    } catch (ex: any) {
      const error = ex.response?.data as SzuruError | undefined;
      throw error?.name ? error : ex;
    }
  }
}
