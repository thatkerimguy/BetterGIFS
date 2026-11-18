/*
 * Network benchmark: what each preview size costs on the wire, for real GIFs.
 * Every URL comes from the plugin's own rewriteUrl (lowres.ts), the same call a
 * tile makes, so a change in the rewrites shows up here.
 *
 *   node --import ./register.mjs --experimental-transform-types --no-warnings bench/network.ts
 *
 * Writes bench/results/network-<date>.json and prints a summary.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";

import { type Quality, rewriteUrl } from "../../vencord/gifPickerOptimizer/lowres.ts";

interface Item { source: string; desktop: string; favorite: string; mobile: string; }

const SCENARIOS = {
    /** Search / trending on desktop: mp4, shown as <video> */
    desktop: { field: "desktop", imagesOnly: false },
    /** A favourite on desktop: the stored .gif */
    favorite: { field: "favorite", imagesOnly: false },
    /** Mobile: tinywebp, always shown as an image */
    mobile: { field: "mobile", imagesOnly: true },
} as const;
const QUALITIES: Quality[] = ["original", "sd", "s", "xs"];
const PARALLEL = 6;

const corpus: { items: Item[]; } = JSON.parse(await readFile(new URL("./corpus.json", import.meta.url), "utf8"));

interface Sample { url: string; ok: boolean; bytes: number; ttfbMs: number; totalMs: number; }
const cache = new Map<string, Promise<Sample>>();

async function measure(url: string): Promise<Sample> {
    const t0 = performance.now();
    try {
        const res = await fetch(url);
        const ttfb = performance.now() - t0;
        const buf = await res.arrayBuffer();
        return { url, ok: res.ok, bytes: buf.byteLength, ttfbMs: ttfb, totalMs: performance.now() - t0 };
    } catch {
        return { url, ok: false, bytes: 0, ttfbMs: 0, totalMs: performance.now() - t0 };
    }
}

// Small pool so the CDN sees roughly what a browser would send
let running = 0;
const waiters: (() => void)[] = [];
async function pooled(url: string) {
    let p = cache.get(url);
    if (p) return p;
    p = (async () => {
        while (running >= PARALLEL) await new Promise<void>(r => waiters.push(r));
        running++;
        try { return await measure(url); } finally { running--; waiters.shift()?.(); }
    })();
    cache.set(url, p);
    return p;
}

// `--from <results file>` summarises an earlier run again instead of downloading
const fromArg = process.argv.indexOf("--from");
const rows: any[] = fromArg > 0 ? JSON.parse(await readFile(process.argv[fromArg + 1], "utf8")).rows : [];
if (fromArg < 0) await Promise.all(corpus.items.flatMap(item =>
    Object.entries(SCENARIOS).flatMap(([scenario, { field, imagesOnly }]) =>
        QUALITIES.map(async q => {
            const src = item[field];
            const url = q === "original" ? src : (rewriteUrl(src, q, undefined, { imagesOnly }) ?? src);
            const s = await pooled(url);
            rows.push({ scenario, source: item.source, quality: q, src, rewritten: url !== src, ...s });
        }))));

const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const kb = (n: number) => (n / 1024).toFixed(0);

const summary: any[] = [];
for (const scenario of Object.keys(SCENARIOS)) for (const source of ["tenor", "giphy"]) {
    const group = rows.filter(r => r.scenario === scenario && r.source === source);
    const original = new Map(group.filter(r => r.quality === "original" && r.ok).map(r => [r.src, r]));
    for (const q of QUALITIES) {
        // Like for like: GIFs whose original and this size both loaded
        const rs = group.filter(r => r.quality === q && r.ok && original.has(r.src));
        const bytes = rs.reduce((a, r) => a + r.bytes, 0);
        const baseBytes = rs.reduce((a, r) => a + original.get(r.src).bytes, 0);
        summary.push({
            scenario, source, quality: q, gifs: rs.length,
            medianKB: +kb(median(rs.map(r => r.bytes))),
            totalMB: +(bytes / 1048576).toFixed(2),
            vsOriginal: baseBytes ? +(bytes / baseBytes).toFixed(3) : null,
            medianMs: Math.round(median(rs.map(r => r.totalMs))),
            failed: group.filter(r => r.quality === q && !r.ok).length,
        });
    }
}

console.table(summary);
if (fromArg > 0) process.exit(0);
const dir = new URL("./results/", import.meta.url);
await mkdir(dir, { recursive: true });
const file = new URL(`network-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}.json`, dir);
await writeFile(file, JSON.stringify({ when: new Date().toISOString(), summary, rows }, null, 1));
console.log(`-> ${file.pathname}`);
