// Serves the picker simulation and collects its results.
//
//   node bench/picker/server.mjs [port]
//
// Desktop: open http://localhost:<port>/?rounds=3
// Phone:   adb reverse tcp:<port> tcp:<port>, then open the same URL in Chrome on the phone.
// Results are appended to bench/results/picker-<date>.jsonl.

import { createServer } from "node:http";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { build } from "esbuild";

const port = Number(process.argv[2] ?? 8787);
const here = new URL("./", import.meta.url);
const benchDir = new URL("../", import.meta.url);
const resultsDir = new URL("results/", benchDir);
await mkdir(resultsDir, { recursive: true });
const out = new URL(`picker-${new Date().toISOString().slice(0, 10)}.jsonl`, resultsDir);

const bundle = await build({
    entryPoints: [new URL("main.ts", here).pathname.replace(/^\/(\w:)/, "$1")],
    bundle: true, format: "esm", target: "es2022", write: false,
});
const js = bundle.outputFiles[0].text;

// Sizes from the newest network run, for when the browser hides them (no Timing-Allow-Origin)
const sizes = {};
const nets = (await readdir(resultsDir)).filter(f => f.startsWith("network-")).sort();
if (nets.length) {
    for (const r of JSON.parse(await readFile(new URL(nets.at(-1), resultsDir), "utf8")).rows) if (r.ok) sizes[r.url] = r.bytes;
}

const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>GIFs+ picker bench</title>
<style>body{margin:8px;background:#1e1f22;color:#dbdee1;font:12px monospace}#log{white-space:pre-wrap}</style>
<div id=host></div><pre id=log></pre><script type=module src="main.js"></script>`;

createServer(async (req, res) => {
    const path = req.url.split("?")[0];
    if (req.method === "POST" && path === "/result") {
        let body = "";
        for await (const c of req) body += c;
        await appendFile(out, body.replace(/\n/g, " ") + "\n");
        const r = JSON.parse(body);
        console.log(`${r.label} r${r.round} ${r.strategy.padEnd(8)} first=${r.firstVisibleMs} screen=${r.allVisibleMs} all=${r.allMs} MB=${(r.totalBytes / 1048576).toFixed(1)} jank=${r.jankFrames}`);
        return res.end("ok");
    }
    const send = (type, data) => { res.setHeader("content-type", type); res.setHeader("cache-control", "no-store"); res.end(data); };
    if (path === "/") return send("text/html", html);
    if (path === "/main.js") return send("text/javascript", js);
    if (path === "/corpus.json") return send("application/json", await readFile(new URL("corpus.json", benchDir)));
    if (path === "/sizes.json") return send("application/json", JSON.stringify(sizes));
    res.statusCode = 404;
    res.end();
}).listen(port, () => console.log(`picker bench on http://localhost:${port}/  ->  ${out.pathname}`));
