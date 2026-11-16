# GifPickerOptimizer

A plugin for **Vencord** (desktop/web) and **Raincord / rain** (mobile) that changes Discord's GIF picker:

- **Sequential loading.** GIFs load one at a time, left to right and top to bottom. The next one starts only after the current one has loaded. You can raise the limit to 2–6 at once in settings.
- **Loading indicator.** Empty tiles show a pulsing ring while they wait their turn. While a tile loads it shows a spinner, or a percentage when the download size is known.
- **Low-resolution previews.** The picker shows an XS, S or SD version of each GIF. Clicking, tapping or favouriting a GIF still uses Discord's original item, so chat and your favourites always get the full-resolution GIF.

| Source | How the preview is made |
|---|---|
| Klipy (Discord's default) | One extra call to Discord's own `/gifs/search` or `/gifs/trending-gifs` per results page, using a smaller `media_format` (`tinywebm`/`nanowebm`, or `nanowebp` on mobile). Klipy gives every size a random file name, so the small URL can't be worked out from the full one. |
| Tenor | URL rewrite to `nano`/`tiny` mp4 or webp |
| Giphy | URL rewrite to `100w`/`200w`/`480w` |
| Discord attachments, `media.discordapp.net`, `images-ext-*` (vx/fx/twitter and other embeds) | Discord media proxy with `width`, `height`, `format=webp` and `animated=true` |
| `pbs.twimg.com` | `name=240x240` / `360x360` / `small` |

If a preview fails to load, the tile falls back to the original URL.

## Vencord

Vencord only loads user plugins in a build you make from source.

```bash
git clone https://github.com/Vendicated/Vencord && cd Vencord
pnpm install --frozen-lockfile
```

Copy the `vencord/gifPickerOptimizer` folder to `Vencord/src/userplugins/gifPickerOptimizer`, then:

```bash
pnpm build
```

```bash
pnpm inject
```

Enable **GifPickerOptimizer** in Settings → Vencord → Plugins. The default quality is **S**.

## Raincord (rain)

rain builds its plugins into its bundle. Copy `raincord/gifpickeroptimizer` to `rain/src/plugins/gifpickeroptimizer`. rain finds plugin folders on its own, so nothing needs registering. Then build:

```bash
bun install
```

```bash
bun run build
```

Load that build on your device, either through `bun run serve` or by pointing rain's custom loader at `dist/rain.js`. Then enable **GifPickerOptimizer** in rain's plugin list. The default quality is **XS**, because Discord mobile already loads the S (`tinywebp`) rendition of Klipy GIFs.
