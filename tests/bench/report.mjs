// Medians per label and strategy from a picker results file.
//   node bench/report.mjs bench/results/picker-<date>.jsonl [label-prefix]

import { readFile } from "node:fs/promises";

const [file, prefix = ""] = process.argv.slice(2);
const runs = (await readFile(file, "utf8")).trim().split("\n").map(l => JSON.parse(l)).filter(r => r.label.startsWith(prefix));
const med = xs => {
    const s = xs.filter(x => x != null).sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : null;
};
const groups = Map.groupBy(runs, r => `${r.label} ${r.strategy}`);
const table = [...groups].map(([k, rs]) => ({
    run: k,
    n: rs.length,
    conc: rs[0].concurrency,
    firstMs: med(rs.map(r => r.firstVisibleMs)),
    screenMeanMs: med(rs.map(r => r.meanVisibleMs)),
    screenFullMs: med(rs.map(r => r.allVisibleMs)),
    all50Ms: med(rs.map(r => r.allMs)),
    unfinished: rs.reduce((a, r) => a + r.unfinished + r.failed, 0),
    screenMB: +(med(rs.map(r => r.visibleBytes)) / 1048576).toFixed(2),
    totalMB: +(med(rs.map(r => r.totalBytes)) / 1048576).toFixed(2),
    jank: med(rs.map(r => r.jankFrames)),
    longTaskMs: med(rs.map(r => r.longTaskMs)),
}));
console.table(table);
