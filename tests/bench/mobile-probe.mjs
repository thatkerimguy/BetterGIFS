// GIFs+ in-Discord probe (Android, Valenced) over adb.
//
//   node bench/mobile-probe.mjs <label> [package]
//
// 1. Open a channel in Discord on the phone and open the GIF picker.
// 2. Run this. It resets Discord's frame stats, then asks you to search for
//    something new (a cold cache) and press Enter here the moment you submit.
// 3. It waits 8 s, scrolls the results 4 times (adb input swipe, 2 s apart),
//    waits 4 s, and records frames and bytes downloaded.
// Run it with GIFs+ on, then off (Valenced asks for a restart), with a different
// fresh search term each time. Results go to bench/results/mobile-probe.jsonl.

import { execFileSync } from "node:child_process";
import { appendFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

const label = process.argv[2] ?? "run";
const pkg = process.argv[3] ?? "app.valenced";
const adb = (...a) => execFileSync("adb", ["shell", ...a], { encoding: "utf8" });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function rxBytes() {
    // Device-wide received bytes on every interface but loopback (keep other apps idle)
    return adb("cat /proc/net/dev").split("\n").slice(2)
        .map(l => l.trim().split(/[:\s]+/))
        .filter(f => f[0] && f[0] !== "lo")
        .reduce((a, f) => a + Number(f[1] || 0), 0);
}

const size = adb("wm size").match(/(\d+)x(\d+)/);
const [w, h] = [Number(size[1]), Number(size[2])];

adb(`dumpsys gfxinfo ${pkg} reset`);
const rl = createInterface({ input: process.stdin, output: process.stdout });
await rl.question("Type a fresh search in the GIF picker, then press Enter here as you submit it... ");
rl.close();

const rx0 = rxBytes();
const t0 = Date.now();
await sleep(8000);
const rxOpen = rxBytes();
for (let i = 0; i < 4; i++) {
    adb(`input swipe ${w >> 1} ${Math.round(h * 0.8)} ${w >> 1} ${Math.round(h * 0.45)} 250`);
    await sleep(2000);
}
await sleep(4000);
const rx1 = rxBytes();

const g = adb(`dumpsys gfxinfo ${pkg}`);
const num = re => Number(g.match(re)?.[1] ?? NaN);
const result = {
    label, when: new Date().toISOString(), seconds: (Date.now() - t0) / 1000,
    mbFirst8s: +((rxOpen - rx0) / 1048576).toFixed(2),
    mbTotal: +((rx1 - rx0) / 1048576).toFixed(2),
    frames: num(/Total frames rendered: (\d+)/),
    jankyFrames: num(/Janky frames: (\d+)/),
    jankyPct: num(/Janky frames: \d+ \(([\d.]+)%\)/),
    p50Ms: num(/50th percentile: (\d+)ms/),
    p90Ms: num(/90th percentile: (\d+)ms/),
    p99Ms: num(/99th percentile: (\d+)ms/),
    slowUiThread: num(/Number Slow UI thread: (\d+)/),
    slowBitmapUploads: num(/Number Slow bitmap uploads: (\d+)/),
};
console.table(result);
const dir = new URL("./results/", import.meta.url);
await mkdir(dir, { recursive: true });
await appendFile(new URL("mobile-probe.jsonl", dir), JSON.stringify(result) + "\n");
