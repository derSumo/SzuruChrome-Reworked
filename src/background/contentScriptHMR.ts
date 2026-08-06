import { isFirefox, isForbiddenUrl } from "~/env";
import { isSupportedSourceUrl } from "~/shared/sourceSites";

// Firefox fetch files from cache instead of reloading changes from disk,
// hmr will not work as Chromium based browser
browser.webNavigation.onCommitted.addListener(({ tabId, frameId, url }) => {
  // Filter out non main window events.
  if (frameId !== 0) return;

  if (isForbiddenUrl(url)) return;
  if (!isSupportedSourceUrl(url)) return;

  void browser.permissions.contains({ origins: [new URL(url).origin + "/*"] }).then((granted) => {
    if (!granted) return;
    // Inject the latest script only on an opted-in scraper source.
    return browser.tabs.executeScript(tabId, {
      file: `${isFirefox ? "" : "."}/dist/contentScripts/index.global.js`,
      runAt: "document_end",
    });
  }).catch((error) => console.error(error));
});
