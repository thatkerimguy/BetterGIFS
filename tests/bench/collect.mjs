// Builds bench/corpus.json: real Tenor and Giphy GIFs, taken from their public
// search pages (no API key). Klipy sits behind a Cloudflare challenge, so it is
// not in the corpus; the in-Discord probes cover it.
//
//   node bench/collect.mjs [perQuery]

import { writeFile } from "node:fs/promises";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const QUERIES = ["cat", "dog", "happy", "dance", "meme", "thumbs-up", "laugh", "anime"];
const perQuery = Number(process.argv[2] ?? 8);

async function page(url) {
    const res = await fetch(url, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.text();
}

const tenor = new Map();
const giphy = new Map();

for (const q of QUERIES) {
    try {
        const html = await page(`https://tenor.com/search/${q}-gifs`);
        let n = 0;
        // media id = <base><2-char rendition code>
        for (const m of html.matchAll(/https:\/\/media\.tenor\.com\/([A-Za-z0-9_-]+)\/([a-z0-9-]+)\.(?:gif|webp|mp4)/g)) {
            const base = m[1].slice(0, -2);
            if (tenor.has(base) || n >= perQuery) continue;
            tenor.set(base, { source: "tenor", query: q, base, slug: m[2] });
            n++;
        }
    } catch (e) { console.warn(String(e)); }
    try {
        const html = await page(`https://giphy.com/search/${q}`);
        let n = 0;
        for (const m of html.matchAll(/https:\/\/media\d?\.giphy\.com\/media\/(?:v1\.[^/]+\/)?([A-Za-z0-9]{8,})\/(?:100|200)\.gif/g)) {
            if (giphy.has(m[1]) || n >= perQuery) continue;
            giphy.set(m[1], { source: "giphy", query: q, id: m[1] });
            n++;
        }
    } catch (e) { console.warn(String(e)); }
}

// The URL each Discord build would hold as the item's src:
//   desktop search/trending: mp4 (Discord's default media_format), shown as <video>
//   desktop favourite: the .gif Discord's add-favourite code stores
//   mobile: tinywebp, shown as an animated image
const items = [];
for (const t of tenor.values()) {
    items.push({
        ...t,
        desktop: `https://media.tenor.com/${t.base}Po/${t.slug}.mp4`,
        favorite: `https://media.tenor.com/${t.base}AC/${t.slug}.gif`,
        mobile: `https://media.tenor.com/${t.base}A1/${t.slug}.webp`,
    });
}
for (const g of giphy.values()) {
    items.push({
        ...g,
        desktop: `https://media.giphy.com/media/${g.id}/giphy.mp4`,
        favorite: `https://media.giphy.com/media/${g.id}/giphy.gif`,
        mobile: `https://media.giphy.com/media/${g.id}/200w.webp`,
    });
}

const out = new URL("./corpus.json", import.meta.url);
await writeFile(out, JSON.stringify({ collected: new Date().toISOString(), items }, null, 1));
console.log(`${tenor.size} Tenor + ${giphy.size} Giphy GIFs -> ${out.pathname}`);
