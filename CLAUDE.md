# KerimsPluginRepo — handoff notes

GifPickerOptimizer: a Discord GIF picker plugin with two builds.

- `vencord/gifPickerOptimizer/`: Vencord user plugin for desktop and web. **This is the one being installed and tested now.**
- `valenced/gif-picker-optimizer/`: plugin for Valenced (github.com/Valenced/valenced), a React Native mobile client mod. Replaced the old Raincord build. Not tested on a device yet.

`lowres.ts`, `queue.ts` and `cache.ts` are identical in `vencord/gifPickerOptimizer/` and `valenced/gif-picker-optimizer/js/`. Change both together.

## What the user asked for

1. Load GIFs one at a time, left to right and top to bottom. Each one finishes before the next starts.
2. Show a loading or progress indicator on tiles that haven't loaded.
3. Show low-resolution previews in the picker: XS/S/SD on Klipy and Tenor, and smaller versions of vx/fx/twitter and Discord links. The full-resolution GIF must still be what gets sent to chat.
4. Port the mobile build from Raincord to Valenced.
5. Unload GIFs that are off screen and load the ones on screen, with caching, so big favourite libraries perform well on mobile and desktop.
6. Optional (off by default): still image previews in the favourites tab instead of playing GIFs.

## The user's setup

- Windows. Give commands for cmd or PowerShell, not `mkdir -p` or `cp`.
- Vencord is built from source. The plugin is copied into `Vencord\src\userplugins\gifPickerOptimizer`, then `pnpm build` and `pnpm inject` are run.
- Copy only `vencord\gifPickerOptimizer`, never the whole repo. Vencord treats every folder in `userplugins` as a plugin.
- To re-copy after changes: `xcopy /E /I /Y ..\bettergifs\vencord\gifPickerOptimizer src\userplugins\gifPickerOptimizer`, then rebuild and restart Discord. For quicker iteration, `pnpm dev` (watch mode) followed by Ctrl+R in Discord also works.

## How the Vencord plugin works (`vencord/gifPickerOptimizer/index.tsx`)

### Rule: never touch the data, only what's displayed

Discord's "add favourite" action stores the item's `src`. Sending uses `item.url`. So the plugin never changes item objects or store data; it only changes which URL a tile *shows*. (Other plugins, such as BetterGifLoad, rewrite store data, which means favourites get saved at low resolution.)

### The webpack patch

- Find string: `"renderEmptyFavorite"`. That module holds the GIF picker results list (class `W`) and the tile component (class `H`, exported as `uG`). Inside `renderItem`, Discord does `(0,r.jsx)(H,{item:u,index:t,format:u.format,src:u.src,coords:s,onClick:…,renderExtras:…,imagePool,videoPool,…})`.
- The patch replaces `H` with `$self.SequentialResult` and passes `Result:H` and `resultType:this?.props?.resultType` (the list's `resultType`, used to detect the favourites tab).
- Match: `/(\(0,\i\.jsx\)\()(\i),\{(?=item:(\i),index:\i,format:\3\.format,src:\3\.src)/`. This was checked against the datamined code.
- Reference copy of Discord's code: github.com/Wumpus-Central/discrapper-canary, `chunks/884037.js` (the picker) and `chunks/821102.js` (GIFPickerViewStore). Chunk IDs change between Discord builds, so search by string instead of chunk ID.
- How tile `H` loads:
  - Images: preloaded on a detached pooled `<img>`, then an `<img>` is rendered once `onload` fires.
  - Videos: in `componentDidMount`, a pooled `<video>` (`preload=auto`, autoplay) is added to the tile.
  - In both cases `H` reads `src` from props.

### `SequentialResult` phases

1. **queued**: renders its own placeholder `div` (`.vc-gpo-tile`, `style={coords}`) instead of `H`, so nothing downloads yet. Clicking the placeholder calls `onClick(item)`, so it still sends.
2. **loading**: when the queue says go, it picks the preview URL with `pickSrc` and renders `H` with `src=preview` and `key=preview`. `renderExtras` is wrapped to add `LoadOverlay` inside H's root element.
   - `LoadOverlay` attaches capture-phase listeners (`progress`, `canplaythrough`, `error`) to the parent element for videos. Progress is `buffered / duration`.
   - For images it loads the same URL in a probe `Image()`. The browser shares the request, so it doesn't download twice.
3. **done**: `H` is rendered as normal.

**Off-screen unloading (`unloadOffscreen`, `offscreenMargin`):**
- Two `ViewportWatcher`s: "visible" (50px, feeds queue priority) and "near" (`offscreenMargin` px). Their IntersectionObservers are rooted on the picker's scroll container (`findScroller`), because rooted on the window `rootMargin` does nothing: the scroller clips the tiles first. (The old 100px window margin had no effect for that reason.)
- The watched element is the placeholder, the still tile, or `.vc-gpo-sentinel`, an `inset:0` div rendered through `renderExtras` inside H.
- Not near → "parked": a plain placeholder is rendered instead of H, so H unmounts and returns its pooled `<video>`. A queued/loading ticket is cancelled, so off-screen GIFs never download.
- Back near → if the URL is in `loaded` (an LRU, `cacheSize`), it shows at once without queueing; the browser HTTP cache serves it.

**Still favourites (`stillFavorites`):**
- Favourites are detected by `resultType` matching /favou?rite/ or, as a fallback, items with a numeric `order` and no `id` (frecency favourites have that shape on desktop and mobile).
- `stillUrl()` in `lowres.ts` gives a still rendition when the source has one: Tenor PNG posters (`Ag`/`AN`/`Ae`/`AD`, checked against the Tenor API), Giphy `_s` renditions, `video.twimg.com/tweet_video` → `pbs.twimg.com/tweet_video_thumb`, and Discord's media proxy without `animated=true` (`format=jpeg` for videos).
- Otherwise (Klipy, etc.) `StillTile` loads the preview, captures the first frame with `createImageBitmap` (falling back to a canvas copy), draws it with object-fit cover, and releases the element. Frames are kept in an LRU (`frames`, 300).
- Still tiles are the plugin's own div (like the placeholder), not H. Clicks and the context menu still go to Discord's handlers with the original item.
- Fallback chain on error: still URL → low-res preview (frame captured) → original.

**Errors and timeouts:**
- If the preview fails, the tile switches to the original `src`.
- After `loadTimeout` seconds, the queue slot is freed while the GIF keeps loading.
- If the component throws, the ErrorBoundary fallback renders the original tile.

### Queue (`queue.ts`)

- Ordering:
  - Tiles on screen come first (an IntersectionObserver feeds this).
  - Then item **index**: the masonry layout places items in index order, so index is the true reading order. Pixel tops in a masonry grid are staggered and give the wrong order.
- `block()` holds the queue while the Klipy low-res lookup is in flight (3-second cap), so full-size files don't start downloading in the meantime.

### Low-res sources

**Klipy** (`lookupLowRes`):
- Klipy gives every size a random file name, so the URL can't be rewritten.
- On `GIF_PICKER_QUERY_SUCCESS` (a flux handler), the plugin calls `RestAPI.get` on `/gifs/search` (or `/gifs/trending-gifs` when there's no query).
- The request uses the same q, locale and limit, with `media_format` set to `tinywebm` (S) or `nanowebm` (XS). Linux desktop uses `tinywebp` by default, so XS there becomes `nanowebp`.
- Results are mapped back to tiles by `id` or `url`.
- SD for Klipy keeps Discord's default size.

**Everything else** is rewritten in `lowres.ts` `rewriteUrl`:

| Source | Rewrite |
|---|---|
| Tenor | Last two characters of the media id: image `A2`/`A1`/`Ax` (nano/tiny/full webp, all animated; `A5` is a static frame), video `P2`/`P1`/`P1` (nano/tiny mp4; `P3` is tinywebm). Checked against Tenor's API 2026-11. |
| Giphy | `100w` / `200w` / `480w` |
| cdn/media.discordapp.net and images-ext (vx/fx/twitter embeds) | Discord media proxy with `width`, `height`, `format=webp`, `animated=true` |
| pbs.twimg.com | `name=` parameter |

A preview is only used if it's the same media type as the original (video stays video, image stays image), because H renders based on `format`.

## Verified vs unverified

**Changed on 2026-11-16 (1.5.0, second review + cache reset; repo renamed):**
- The GitHub repo is now `thatkerimguy/KerimsPluginRepo`; the Valenced repository URL is `https://thatkerimguy.github.io/KerimsPluginRepo/index.json` (the old BetterGIFS Pages URL stops working; users re-add the new one).
- Klipy favourite lookups (`klipyFormats`) only run for favourites (`isFavoriteItem`). Search/trending results get previews from `lookupLowRes` only; before, at S/SD on mobile every Klipy result did its own `/gifs/search`.
- `KlipyResolver` skips a media_format for the session after 2 failed searches in a row if it never worked (`usable()`), in both `resolve` and `peek`.
- Saves wait for the saved cache to load (`loadDone`): Klipy and mobile Tenor saves replace the whole file, so saving earlier could drop saved entries.
- A preview shown from the `loaded` cache that fails now falls back like a fresh load: mobile handles `onError` in phase `done`; desktop keeps `LoadOverlay` mounted (quietly) for previews in phase `done`.
- Desktop `offscreenMargin` has `onChange: () => nearWatcher.refresh()`, which re-observes mounted tiles with the new margin.
- Mobile favourites-only hint is a plain "Search for GIFs above." (no favourites hook).
- Cache settings: `LruCache.approxBytes()` (strings + 200 B per entry, from the Bun measurements), `KlipyResolver.stats()/clear()` (clear also saves `{}` and ignores a load still in flight via `generation`), mobile `TenorPageResolver.stats()/clear()`. Mobile settings read them through `cacheControl` in `shared.ts`; Vencord has an `OptionType.COMPONENT` setting (`CacheSettings`) refreshed every 2 s. Reset doesn't touch Discord's own image cache.

**Fixed on 2026-11-16 (1.4.1, code review findings):**
- Desktop `ViewportWatcher` leaked an IntersectionObserver pair per picker open (each holding the closed picker's DOM through its root). Observers are now reference counted and disconnected with their last element.
- Desktop Klipy lookups race `loadTimeout` like mobile, so a long serial lookup chain can't keep tiles spinning.
- `KlipyResolver.search` replaces a saved miss ("") when a later search returns that GIF.
- Desktop favourites only: `componentDidMount` is patched to `$self.mountCategories(trendingCategories, fetch)`, which keeps Discord's fetch action. If the option is turned off while the picker is open, `needsCategories` starts the fetch (outside render) instead of showing the skeleton forever.
- A ticket `start()` that throws now falls back to loading the original instead of leaving the tile queued forever (both builds).
- Mobile `TenorPageResolver` remembers failed lookups (network error, timeout) for 5 minutes in memory, so remounting tiles don't fire a HEAD request each time.
- `loaded` is resized when the setting changes (Vencord `onChange`; mobile: an effect in `OptimizedResultsList`), not in every tile render.
- Mobile favourites-only hint only suggests starring GIFs when there are no favourites (a picker with `hideFavorites` has none to show).

**Changed on 2026-11-16 (1.4.0, favourites only keeps the main page + smaller caches):**
- `favoritesOnly` no longer replaces the main page with the favourites list (the user wants the normal main page, with search and the Favorites category, minus the featured categories).
  - Desktop: three replacements in the `"hideFavoritesTile:"` module's categories component `k`: `componentDidMount` only fetches trending when `$self.needsCategories(...)`, `getData` uses `$self.featured(trendingCategories)` (a stable empty array when on), and `renderContent` shows the loading skeleton only when `needsCategories`. The old `frontPage` patch is gone. Regexes were tested against a hand-minified copy of the chunk.
  - Mobile: the `GIFPickerCategoriesPage` patch renders one row with Discord's `GIFPickerCategoryView` for `props.favoritesCategory` (same row height and gutter as Discord's page) and empty spacers, or a hint text when there's no favourites category. Discord's page would pad to 20 rows of grey skeletons with only one category, so it isn't reused.
- Memory, measured in Bun with full caches: `loaded` 0.26 MB (1000), `failed` 0.11 MB, `apiPreviews` 2.1 MB → 0.5 MB (now an LRU of 1200 instead of a Map cleared at 3000), Tenor pages 2.5 MB for 5000 favourites (only grows with favourites, unchanged), Klipy: unrelated search results go to an unsaved LRU of 500 and move to the saved cache only when a favourite uses one (40 lookups saved 2040 entries before, 40 now).
- Desktop still frames were the big one: up to 300 full-size bitmaps (about 40 to 200 MB). `LruCache` now takes an optional `weigh`; frames are captured with `createImageBitmap` resize to cover the tile in device pixels and limited to 24 MB. Evicted canvases are zero-sized to free them.
- `LoadedCache` values are timestamps (numbers) instead of objects. `LruCache.set` on an existing key now calls `onEvict` for the replaced value.

**Added on 2026-11-16 (1.3.0, favourites only + faster GIF tab switch):**
- Desktop `favoritesOnly`: the picker parent (find `"hideFavoritesTile:"`, discrapper `chunks/649529.js`) renders the categories grid `L` when `this.state.resultType` is null, else the results list with favourites data when it's `FAVORITES`. The patch swaps `this.state` in `renderContent` for `$self.frontPage(this.state, hideFavorites, FAVORITES)`. The header still reads the real state, so it keeps the search bar and no back arrow. Typing sets `SEARCH` as before. The regex was checked against a minified copy of the code, not in real Discord.
- Mobile `favoritesOnly`: patches `type` of the memo `GIFPickerCategoriesPage` default and renders `GIFPickerResultsList` with `useFavoriteGIFsMobile().favorites`, the picker's `onPressGIF` (taken from a context provided by the GIFPicker patch) and a `columnWidth` measured with `onLayout`. Falls back to Discord's page when the picker has `hideFavorites`.
- Mobile `fastTabSwitch`: patches `type` of the memo `GIFPicker` default. The first render is an empty frame with a spinner, and the picker mounts after `requestAnimationFrame` or `InteractionManager.runAfterInteractions` (capped at 300 ms). Picker and categories page render as their own components (`PickerInner`, `CategoriesPageInner`) so the hook order never changes.
- Why the switch is slow on mobile: on mount, GIFPicker dispatches `initializeSearch`/`resetSearch`, fetches trending search terms, and the categories page fetches trending categories and renders up to 20 rows of animated category GIFs. Not profiled on a device: the deferral helps if the picker mount is the slow part. If the emoji picker's unmount is the slow part, it won't.

**Fixed on 2026-11-16 (1.2.2, favourites stuck loading on mobile):**
- Discord mobile's `transformFavoriteGifUrl` (`modules/gif_picker/native/GIFPickerUtils.tsx`) rewrites favourites before the picker shows them: proxied (images-ext) ones get `animated=true` (the proxy turns mp4 into animated webp), and Tenor favourites become `<tenor page URL>.gif`, which 302-redirects to `media1.tenor.com/m/<id>AAAAC/<name>.gif`.
- 1.2.0 unwrapped proxied Tenor mp4s into direct Tenor **mp4** URLs. The mobile tile is an image component, can't show mp4, and apparently never fires onLoad/onError, so tiles spun forever.
- Mobile now calls `rewriteUrl(..., { imagesOnly: true })` (Tenor/Giphy give animated webp; proxied unknown videos get resized `format=webp&animated=true` through images-ext) and rejects any video preview URL.
- `TenorPageResolver` (mobile only, `index.tsx`) follows the page URL redirect once with `fetch(HEAD)` and saves page → media in `tenor-pages.json`.
- Klipy lookups on mobile always ask for image formats.
- Safety nets: lookups (`resolving`) can't hold a tile longer than `loadTimeout`; `KlipyResolver` waits at most 2 s for its saved cache and 8 s per search; a mobile preview still loading after 2 × `loadTimeout` falls back to the next option (`error()`).
- Unverified on a device: that RN `fetch` HEAD exposes the redirected `res.url`, and that images-ext resizes proxied videos into animated webp.

**Fixed and verified on 2026-11-16 (1.2.0, low-res for favourites):**
- The queue effect's cleanup used to cancel a ticket as soon as it started loading (its deps include `phase`), so loading wasn't strictly sequential. Now only unstarted tickets are cancelled there; started ones are freed by finishing, parking (`drop`) or unmounting.
- Unit tests (Bun) for proxy unwrapping, the Tenor codes and `KlipyResolver` (format fallback, caching of other results, misses, persistence) pass. Tenor URLs generated for the user's reported GIFs were fetched live: all 200; the webps are animated.

**Verified on 2026-11-16 (Valenced port + unloading + still favourites):**
- Valenced build: `tsc -b` passes (and catches a planted error), `valenced-plugin build` produces `build/js/index.js`. Biome only reports style (tabs vs spaces, import type).
- Vencord build: `pnpm build` passes, `tsc --noEmit` on all of Vencord has 0 errors, oxlint only reports the license header rule that applies to built-in plugins.
- Unit tests (Bun) for `rewriteUrl`, `stillUrl` and the LRU caches pass. Generated Tenor still/preview URLs return 200 live.
- **Not run in real Discord or on a device.** Check: tiles unload and come back when scrolling a big favourites list; the sentinel sits inside H (if tiles never unload, H's root isn't positioned and the sentinel covers the whole list, which is the safe failure); still favourites show; clicking a still/parked tile sends the original.

**Verified in the earlier cloud session:**
- Both builds typecheck. The full Vencord build passed; the rain build and eslint passed.
- jsdom test with a replica of Discord's `H` tile:
  - strictly one download at a time, in index order;
  - previews shown, and the original item sent, including when clicking a queued tile;
  - Klipy tiles waited for the lookup;
  - a 404 preview fell back to the original.
- A react-test-renderer test of the mobile build passed the equivalent checks.

**Not yet verified in real Discord. Check these first:**
1. **Does the patch apply?** If not, the console shows a Vencord warning about the `renderEmptyFavorite` patch. Use Vencord's patch helper or the devtools search to find the current `renderItem` code and update the regex.
2. **Does Discord's API accept `media_format=tinywebm` / `nanowebm`?**
   - Check the DevTools Network tab for the second `/gifs/search` request.
   - If it fails, the console shows a warning starting with `[GifPickerOptimizer] Couldn't fetch low resolution Klipy previews`.
   - Discord's own code lists these names (they date from the Tenor era), but whether the server still accepts them is unconfirmed.
   - Fallback idea: try other format names, or use `preview`/`gif_src` from the response.
3. **Tenor size codes.** They come from the Endcord/BetterGifLoad plugin's reverse-engineering. A wrong code 404s and then falls back to the original.
4. **The tile's root must be positioned.** `.vc-gpo-overlay` uses `position:absolute; inset:0` inside H's root. If the indicator shows up in the wrong place, check whether `coords` includes `position:absolute`.
5. **Progress:**
   - Video tiles should show a %.
   - Image tiles (webp, or Linux desktop) only get a spinner, because images can't report progress.
   - Discord's CSP probably blocks the `fetch()` streaming approach that would give image progress, so it wasn't attempted.
6. **Favourites:** sending a favourite must post the original URL, and adding a favourite must store the full-resolution `src`.

## Known limitations

- **Klipy favourites** (fixed in 1.2.0): Discord's add-favourite code (desktop chunk with `"favoriteGifs"` + `GIF_FAVORITED`) stores `gifSrc` (the full .gif) instead of the mp4, and proxies it through images-ext when the src is a Discord media URL. `klipy.ts` `KlipyResolver` searches `/gifs/search` for the slug of the favourite's `url` (`klipy.com/gifs/<slug>`) with `media_format` `nanowebp`/`tinywebp` (images) or the selected video family, matches by page URL, caches every result (also misses) in an LRU of 5000, and persists it (desktop: `DataStore` key `GifPickerOptimizer_klipyPreviews`; mobile: `klipy-previews.json` in the plugin's storage). Lookups run one at a time, 300 ms apart. Tiles show a spinner in the `resolving` phase meanwhile. **Unverified:** whether Discord's API accepts `nanowebp`/`tinywebp` on desktop and whether search finds the exact GIF for every slug. A miss just shows the original.
- **Proxied favourites** (fixed in 1.2.0): `unwrapProxyUrl` turns `images-ext-N.discordapp.net/external/<sig>/https/<host>/<path>` back into the source URL for Tenor, Giphy, Klipy and twimg hosts.
- **Videos without a smaller version:** Twitter `video.twimg.com` GIFs and mp4 attachments have no smaller rendition, and the media proxy can't shrink a video and keep it animated. They only get sequential loading.
- **Desktop progress:** the percentage only appears for video tiles.

## Mobile (Valenced) notes

- Plugin layout follows github.com/Valenced/valenced-plugin-template: `manifest.json` (id `thatkerimguy.gif-picker-optimizer`), `tsconfig.json` extending `../../tsconfig.base.json`, JS entry `js/index.tsx`. JS-only, no native code.
- APIs used: `plugin({ jsonStorage, start({ cleanup, jsonStorage, logger }), SettingsComponent })`, `getModuleWithImportedPath` from `@valenced/discord/utils/modules/finders`, `instead` from `@valenced/patcher`, `onFluxEventDispatched` / `Stores` from `@valenced/discord/flux` (the flux patch **must return the payload** or the event is blocked), `getModules(withProps("HTTP","get","post","put","patch","del"))` for HTTP (same as the community tenor-gif-search plugin), `Design` components and `Page` for settings.
- It patches `default` on `modules/gif_picker/native/GIFPickerItemView.tsx` using `instead`.
- It always calls the original render, which uses hooks, with the original item. Then it swaps the `Image` element in the returned tree:
  - for a queued placeholder, or
  - for a clone with the preview `source` plus `onLoad`, `onError` and `onProgress`.
- Discord mobile already uses `tinywebp`, so the default quality is XS, which requests `nanowebp`.
- **Off-screen unloading:** `GIFPickerResultsList.tsx` renders a `MasonryFlashList` whose `viewedItemIndexes` Set only grows, so every tile ever scrolled past stays loaded. The plugin also patches that module's `default`: `OptimizedResultsList` finds the list element (has `onViewableItemsChanged` + `renderItem`), wraps `onViewableItemsChanged` with a stable callback that feeds a `ViewportStore` (first/last viewable index), and provides it through React context. `OptimizedItem` is parked when its index is more than `offscreenBuffer` items outside that range: the Image is replaced with an empty frame and queued work is cancelled. On return, a URL in `loaded` shows at once (native image cache).
- **Still favourites on mobile** only work for sources `stillUrl()` covers. React Native can't pause an animated image from JS, so Klipy favourites stay animated.
- `lowres.ts` parses URLs by hand: React Native's `URL` polyfill doesn't reliably implement `searchParams.set`.
- Mobile reference source: github.com/Wumpus-Central/discord-mobile-datamining, `discord_app/modules/gif_picker/`.
- Build: copy the folder into the template's `plugins/`, `bun install`, `bun run build gif-picker-optimizer` (npm can't build the template's git-hosted CLI; use Bun). ZIP: `gradlew packageGifPickerOptimizer` (needs JDK 25 + Android SDK).

## Settings (Vencord)

| Setting | Default |
|---|---|
| quality (`xs`/`s`/`sd`/`original`) | `s` |
| sequential | on |
| concurrency | 3 (was 1 before 1.3.1) |
| prioritizeVisible | on |
| loadTimeout | 10 s |
| showProgress | on |
| klipyLookup | on |
| unloadOffscreen | on |
| offscreenMargin | 800 px (mobile: `offscreenBuffer`, 12 items) |
| cacheSize | 1000 |
| stillFavorites | off |
| favoritesOnly | off |
| fastTabSwitch (mobile only) | on |

Mobile defaults are the same except quality `xs` and no `prioritizeVisible` (always on).

## Suggested next steps

1. Install on Vencord and go through the verification list above.
2. If the Klipy lookup works, compare file sizes: the Network tab's transferred size for the full vs tiny vs nano versions.
3. Consider publishing the Vencord plugin as a standalone user plugin repo layout, with a README for other users.
