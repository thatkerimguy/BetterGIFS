/* Runs the picker simulation rounds and posts each result back to the server. */

import { autoConcurrency, run, type RunOptions } from "./picker";

const p = new URLSearchParams(location.search);
const mode = (p.get("mode") ?? (/Android|iPhone/.test(navigator.userAgent) ? "mobile" : "desktop")) as RunOptions["mode"];
const rounds = Number(p.get("rounds") ?? 3);
const count = Number(p.get("count") ?? 50);
const strategies = (p.get("strategies") ?? "discord,gifs-s,gifs-xs").split(",") as RunOptions["strategy"][];
// Desktop: Auto like the plugin; mobile: the plugin's default 3
const concurrency = Number(p.get("concurrency") ?? (mode === "desktop" ? autoConcurrency() : 3));
const label = p.get("label") ?? mode;

const log = document.getElementById("log")!;
const host = document.getElementById("host")!;
const say = (s: string) => { log.textContent += s + "\n"; };

const { items } = await (await fetch("corpus.json")).json();
(window as any).BENCH_SIZES = await (await fetch("sizes.json")).json();
// The one Giphy GIF with missing renditions would only measure an error
const usable = items.filter((i: any) => !i.desktop.includes("XJtM2nNFCzT3etvzOB"));

const session = Date.now().toString(36);
say(`${label}: ${mode}, ${rounds} rounds x ${strategies.join("/")}, ${count} GIFs, concurrency ${concurrency}`);
for (let r = 0; r < rounds; r++) {
    // Rotate the order so no strategy always gets the warmest connections
    const order = strategies.map((_, i) => strategies[(i + r) % strategies.length]);
    for (const strategy of order) {
        const opts: RunOptions = {
            mode, strategy, count, concurrency,
            seed: 1000 + r, // same GIFs for every strategy within a round
            nonce: `${session}-${r}-${strategy}`,
            timeoutMs: 10_000, capMs: 90_000,
        };
        const res = await run(usable, opts, host);
        await fetch("result", { method: "POST", body: JSON.stringify({ label, session, round: r, ...res }) });
        say(`round ${r + 1} ${strategy.padEnd(8)} first ${res.firstVisibleMs} ms, screen ${res.allVisibleMs} ms (mean ${res.meanVisibleMs}), all ${res.allMs} ms, ${(res.totalBytes / 1048576).toFixed(1)} MB, jank ${res.jankFrames}`);
        await new Promise(r => setTimeout(r, 1500));
    }
}
say("DONE");
document.title = "DONE";
