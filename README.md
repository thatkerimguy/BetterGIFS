# GifPickerOptimizer

A plugin for **Vencord** (desktop/web) and **Valenced** (mobile) that changes Discord's GIF picker:

- **Sequential loading.** GIFs load one at a time, left to right and top to bottom. The next one starts only after the current one has loaded. You can raise the limit to 2–6 at once in settings.
- **Loading indicator.** Empty tiles show a pulsing ring while they wait their turn. While a tile loads it shows a spinner, or a percentage when the download size is known.
- **Low-resolution previews.** The picker shows an XS, S or SD version of each GIF. Clicking, tapping or favouriting a GIF still uses Discord's original item, so chat and your favourites always get the full-resolution GIF.
- **Off-screen unloading with caching.** GIFs you scroll far away from are unloaded, which frees memory and video decoders. When you scroll back they show again straight from cache, without waiting in the load queue. GIFs that are off screen and haven't loaded yet don't download at all. This keeps big favourite libraries smooth on both desktop and mobile.
- **Still favourites (optional, off by default).** The favourites tab shows still images instead of playing GIFs. The GIF you send still animates.

| Source | How the preview is made |
|---|---|
| Klipy (Discord's default) | One extra call to Discord's own `/gifs/search` or `/gifs/trending-gifs` per results page, using a smaller `media_format` (`tinywebm`/`nanowebm`, or `nanowebp` on mobile). Klipy gives every size a random file name, so the small URL can't be worked out from the full one. |
| Tenor | URL rewrite to `nano`/`tiny` mp4 or webp |
| Giphy | URL rewrite to `100w`/`200w`/`480w` |
| Discord attachments, `media.discordapp.net`, `images-ext-*` (vx/fx/twitter and other embeds) | Discord media proxy with `width`, `height`, `format=webp` and `animated=true` |
| `pbs.twimg.com` | `name=240x240` / `360x360` / `small` |

If a preview fails to load, the tile falls back to the original URL.

### Where still favourites come from

| Source | Still image |
|---|---|
| Tenor | Tenor's PNG poster frame |
| Giphy | Giphy's single-frame `_s` rendition |
| Twitter GIFs (`video.twimg.com/tweet_video`) | The matching `pbs.twimg.com/tweet_video_thumb` image |
| Discord attachments and embeds | Discord's media proxy without `animated=true` (first frame), or `format=jpeg` for videos |
| Anything else, including Klipy | **Desktop:** the first frame is drawn onto a canvas and the GIF is released. **Mobile:** stays animated, because React Native can't pause an animated image from JavaScript. |

## Vencord

Vencord only loads user plugins in a build you make from source.

```bash
git clone https://github.com/Vendicated/Vencord && cd Vencord
pnpm install --frozen-lockfile
```

Copy the `vencord\gifPickerOptimizer` folder to `Vencord\src\userplugins\gifPickerOptimizer`, then:

```bash
pnpm build
```

```bash
pnpm inject
```

Enable **GifPickerOptimizer** in Settings → Vencord → Plugins. The default quality is **S**.

## Valenced

Valenced plugins are built with the [Valenced plugin template](https://github.com/Valenced/valenced-plugin-template). The template needs [Bun](https://bun.com/) to build.

1. Clone the template and install its dependencies:

   ```bash
   git clone https://github.com/Valenced/valenced-plugin-template
   ```

   ```bash
   cd valenced-plugin-template
   ```

   ```bash
   bun install
   ```

2. Copy the `valenced\gif-picker-optimizer` folder into the template's `plugins` folder, so you have `plugins\gif-picker-optimizer\manifest.json`.

3. Build the JS bundle. The output is `plugins\gif-picker-optimizer\build\js\index.js`:

   ```bash
   bun run build gif-picker-optimizer
   ```

   To build the installable ZIP (`build\dist\thatkerimguy.gif-picker-optimizer@1.1.0.zip`), run `gradlew packageGifPickerOptimizer`. That needs the JDK and Android SDK listed in the template's README.

4. Load it in Valenced, either with `bun run serve` during development or by publishing the template repository as a plugin repository and adding its URL in Valenced.

Then enable **GifPickerOptimizer** in Valenced's plugin list. The default quality is **XS**, because Discord mobile already loads the S (`tinywebp`) rendition of Klipy GIFs.
