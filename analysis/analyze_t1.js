'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = process.argv[2] || 'bt2s';
const BASE = path.join(__dirname, '..', 'results', 'T1', CONFIG);
const OUT = path.join(BASE, 'analysis');

const OPS = [
  ['RegisterProduction', 'Production registration', 'Production', 'W'],
  ['RegisterTransformation', 'Transformation (mass balance)', 'Transformation', 'W'],
  ['CreatePackageForLot', 'Package creation', 'Packaging', 'W'],
  ['RegisterBindingForPackage', 'Binding registration (PDC)', 'Binding', 'W'],
  ['ConsumeByUID', 'Certificate consumption', 'Consumption', 'W'],
  ['ConsumeByUID_repeat', 'Repeated scan (consumed cert.)', 'Repeated scan', 'W'],
  ['GetProductionByLotCode', 'Production query', 'Production query', 'R'],
  ['GetCert', 'Certificate query', 'Certificate query', 'R'],
  ['VerifyCertIntegrity', 'Certificate integrity check', 'Integrity check', 'R'],
  ['CheckAuthorized', 'Authorization check', 'Authorization', 'R'],
  ['VerifyByUID', 'UID verification (PDC)', 'UID verification', 'R'],
];

const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map(line => {
    const v = line.split(',');
    const o = {};
    head.forEach((k, i) => { o[k] = v[i]; });
    return o;
  });
}
const num = x => (x === '' || x === undefined ? null : Number(x));
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
function pctl(a, p) {
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
const ci95 = a => (a.length > 1 ? T975[Math.min(a.length - 1, 10)] * sd(a) / Math.sqrt(a.length) : NaN);
const f1 = v => (v === null || Number.isNaN(v) ? '--' : v.toFixed(1));
const f2 = v => (v === null || Number.isNaN(v) ? '--' : v.toFixed(2));

if (!fs.existsSync(BASE)) { console.error(`Folder not found: ${BASE}`); process.exit(1); }
const runs = fs.readdirSync(BASE).filter(d => /^r\d+$/.test(d))
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
if (!runs.length) { console.error(`No runs in ${BASE}`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const data = {};
const failures = [];
const infos = {};
const windows = {};
let totalRequests = 0;

for (const r of runs) {
  const dir = path.join(BASE, r);
  infos[r] = JSON.parse(fs.readFileSync(path.join(dir, 'run_info.json'), 'utf8'));
  const recs = readCsv(path.join(dir, 'requests.csv'));
  totalRequests += recs.length;
  let wStart = Infinity, wEnd = -Infinity;
  for (const x of recs) {
    const t0 = num(x.t0_epoch_ms), e2e = num(x.l_e2e_ms);
    if (t0 !== null) { wStart = Math.min(wStart, t0); wEnd = Math.max(wEnd, t0 + (e2e || 0)); }
    const ok = (x.status === 'VALID' || x.status === 'OK') && !x.failure_class;
    if (!ok) { failures.push({ run: r, op: x.op, status: x.status, failure: x.failure_class }); continue; }
    ((data[x.op] ??= {})[r] ??= []).push({
      e2e, endorse: num(x.l_endorse_ms), submit: num(x.l_submit_ms), commit: num(x.l_commit_ms) });
  }
  windows[r] = [wStart, wEnd];
}

const rows = [];
for (const [op, label, short, cls] of OPS) {
  if (!data[op]) continue;
  const perRun = runs.map(r => data[op][r] || []).filter(a => a.length);
  const all = perRun.flat();
  const e2e = all.map(x => x.e2e);
  const runMeans = perRun.map(a => mean(a.map(x => x.e2e)));
  const comp = k => (cls === 'W' ? mean(all.map(x => x[k])) : null);
  const endorseRunMeans = cls === 'W' ? perRun.map(a => mean(a.map(x => x.endorse))) : [];
  rows.push({
    op, label, short, cls, n: all.length, R: runMeans.length,
    mean: mean(e2e), sd: sd(e2e), ci: ci95(runMeans),
    cvRuns: 100 * sd(runMeans) / mean(runMeans),
    p50: pctl(e2e, 0.5), p95: pctl(e2e, 0.95), p99: pctl(e2e, 0.99),
    min: Math.min(...e2e), max: Math.max(...e2e),
    endorse: comp('endorse'), endorseCi: cls === 'W' ? ci95(endorseRunMeans) : null,
    endorseP95: cls === 'W' ? pctl(all.map(x => x.endorse), 0.95) : null,
    submit: comp('submit'), commit: comp('commit'),
  });
}

fs.writeFileSync(path.join(OUT, 't1_latency_summary.csv'),
  ['op,class,n,runs,mean_ms,sd_ms,ci95_runs_ms,cv_between_runs_pct,p50_ms,p95_ms,p99_ms,min_ms,max_ms,' +
   'endorse_mean_ms,endorse_ci95_ms,endorse_p95_ms,submit_mean_ms,commit_mean_ms',
   ...rows.map(x => [x.op, x.cls, x.n, x.R, x.mean, x.sd, x.ci, x.cvRuns, x.p50, x.p95, x.p99, x.min, x.max,
     x.endorse, x.endorseCi, x.endorseP95, x.submit, x.commit]
     .map(v => (typeof v === 'number' ? v.toFixed(3) : v ?? '')).join(','))].join('\n') + '\n');

const R = runs.length;
const iters = infos[runs[0]].iterations;
const tableRow = x => `${x.label} & ${x.n} & ${f1(x.mean)} $\\pm$ ${f1(x.ci)} & ${f1(x.p50)} & ${f1(x.p95)} & ` +
  `${f1(x.p99)} & ${f1(x.endorse)} & ${f1(x.submit)} & ${f1(x.commit)} \\\\`;
const latencyTex = [
  '% Generated by analyze_t1.js - requires \\usepackage{booktabs}',
  '\\begin{table}[t]',
  '\\centering\\small',
  `\\caption{T1: sequential per-operation latency in ms (${R} runs $\\times$ ${iters} measured iterations; ` +
  'one outstanding request). Mean $\\pm$ 95\\% confidence interval of the run-level means; percentiles on the ' +
  'pooled sample. Endorse: proposal execution and endorsement by both organisations (includes chaincode ' +
  'execution); Submit: delivery to the ordering service; Commit: block cutting, validation and commit ' +
  '(BatchTimeout = 2\\,s).}',
  '\\label{tab:t1-latency}',
  '\\setlength{\\tabcolsep}{3.5pt}',
  '\\begin{tabular}{lrrrrrrrr}',
  '\\toprule',
  'Operation & $N$ & Mean & P50 & P95 & P99 & Endorse & Submit & Commit \\\\',
  '\\midrule',
  '\\multicolumn{9}{l}{\\emph{State-changing}} \\\\',
  ...rows.filter(x => x.cls === 'W').map(tableRow),
  '\\midrule',
  '\\multicolumn{9}{l}{\\emph{Read-only}} \\\\',
  ...rows.filter(x => x.cls === 'R').map(tableRow),
  '\\bottomrule',
  '\\end{tabular}',
  '\\end{table}',
].join('\n');
fs.writeFileSync(path.join(OUT, 't1_latency_table.tex'), latencyTex + '\n');

const W = rows.filter(x => x.cls === 'W');
const coords = (k) => W.map(x => `(${x[k].toFixed(1)},${x.short})`).join(' ');
const yCoords = W.map(x => x.short).join(',');
const figTex = [
  '% Generated by analyze_t1.js - requires \\usepackage{pgfplots} and \\pgfplotsset{compat=1.18}',
  '\\begin{figure}[t]',
  '\\centering',
  '\\begin{tikzpicture}',
  '\\begin{axis}[xbar stacked, width=0.85\\linewidth, height=5cm, bar width=7pt,',
  `  symbolic y coords={${yCoords}}, ytick=data, y dir=reverse, xmin=0,`,
  '  xlabel={Latency (ms)}, tick label style={font=\\footnotesize},',
  '  legend style={font=\\footnotesize, at={(0.5,1.03)}, anchor=south, legend columns=3}]',
  `\\addplot coordinates {${coords('endorse')}};`,
  `\\addplot coordinates {${coords('submit')}};`,
  `\\addplot coordinates {${coords('commit')}};`,
  '\\legend{Endorse (incl.\\ chaincode execution), Submit, Commit (block cutting and validation)}',
  '\\end{axis}',
  '\\end{tikzpicture}',
  '',
  '\\vspace{2mm}',
  '\\begin{tikzpicture}',
  '\\begin{axis}[xbar, width=0.85\\linewidth, height=5cm, bar width=7pt,',
  `  symbolic y coords={${yCoords}}, ytick=data, y dir=reverse, xmin=0,`,
  '  xlabel={Endorse phase (ms)}, tick label style={font=\\footnotesize},',
  '  nodes near coords, nodes near coords style={font=\\scriptsize, anchor=west, xshift=4pt},',
  '  error bars/x dir=both, error bars/x explicit]',
  `\\addplot coordinates {${W.map(x => `(${x.endorse.toFixed(1)},${x.short}) +- (${x.endorseCi.toFixed(1)},0)`).join(' ')}};`,
  '\\end{axis}',
  '\\end{tikzpicture}',
  '\\caption{T1: decomposition of the latency of state-changing operations (top) and detail of the ' +
  'endorsement phase, which contains the chaincode execution (bottom; mean $\\pm$ 95\\% CI over runs).}',
  '\\label{fig:t1-decomposition}',
  '\\end{figure}',
].join('\n');
fs.writeFileSync(path.join(OUT, 't1_latency_figure.tex'), figTex + '\n');

function memMiB(s) {
  const m = /([\d.]+)\s*(KiB|MiB|GiB|kB|MB|GB|B)/.exec(String(s).split('/')[0]);
  if (!m) return NaN;
  const v = Number(m[1]);
  return { B: v / 1048576, KiB: v / 1024, kB: v / 1048.576,
    MiB: v, MB: v / 1.048576, GiB: v * 1024, GB: v * 1000 / 1.048576 }[m[2]];
}
function shortName(n) {
  const org = n.includes('farmers') ? 'Farmers' : n.includes('producers') ? 'Producers' : '';
  if (n.startsWith('dev-peer')) {
    const cc = /-(certificate|userauth)_/.exec(n);
    return `${cc ? cc[1] : 'chaincode'} CC (${org})`;
  }
  if (n.startsWith('peer0')) return `Peer (${org})`;
  if (n.startsWith('orderer')) return 'Orderer';
  return null;
}
const res = {};
for (const r of runs) {
  const file = path.join(BASE, r, 'resources.csv');
  if (!fs.existsSync(file)) continue;
  const [ws, we] = windows[r];
  const per = {};
  for (const x of readCsv(file)) {
    const t = num(x.epoch_ms), name = shortName(x.container || '');
    if (!name || t < ws || t > we) continue;
    (per[name] ??= { cpu: [], mem: [] });
    per[name].cpu.push(parseFloat(x.cpu_pct));
    per[name].mem.push(memMiB(x.mem_usage));
  }
  for (const [name, v] of Object.entries(per)) {
    (res[name] ??= { cpuMean: [], cpuMax: [], memMean: [], samples: 0 });
    res[name].cpuMean.push(mean(v.cpu));
    res[name].cpuMax.push(Math.max(...v.cpu));
    res[name].memMean.push(mean(v.mem));
    res[name].samples += v.cpu.length;
  }
}
const order = ['Peer (Farmers)', 'Peer (Producers)', 'Orderer', 'certificate CC (Farmers)',
  'certificate CC (Producers)', 'userauth CC (Farmers)', 'userauth CC (Producers)'];
const resRows = order.filter(n => res[n]).map(n => ({ name: n, ...res[n] }));
fs.writeFileSync(path.join(OUT, 't1_resources_summary.csv'),
  ['container,cpu_mean_pct,cpu_mean_sd,cpu_max_pct,mem_mean_mib,mem_mean_sd,samples',
   ...resRows.map(x => [x.name, mean(x.cpuMean), sd(x.cpuMean), Math.max(...x.cpuMax),
     mean(x.memMean), sd(x.memMean), x.samples].map(v => (typeof v === 'number' ? v.toFixed(3) : v)).join(','))
  ].join('\n') + '\n');
const resTex = [
  '% Generated by analyze_t1.js',
  '\\begin{table}[t]',
  '\\centering\\small',
  '\\caption{T1: container resource usage during the measurement window (docker stats, $\\approx$1\\,s ' +
  'sampling). CPU in \\% of one core; mean $\\pm$ SD of the run-level means; maximum over all samples.}',
  '\\label{tab:t1-resources}',
  '\\begin{tabular}{lrrr}',
  '\\toprule',
  'Container & CPU mean (\\%) & CPU max (\\%) & Memory (MiB) \\\\',
  '\\midrule',
  ...resRows.map(x => `${x.name} & ${f2(mean(x.cpuMean))} $\\pm$ ${f2(sd(x.cpuMean))} & ` +
    `${f2(Math.max(...x.cpuMax))} & ${f1(mean(x.memMean))} $\\pm$ ${f1(sd(x.memMean))} \\\\`),
  '\\bottomrule',
  '\\end{tabular}',
  '\\end{table}',
].join('\n');
fs.writeFileSync(path.join(OUT, 't1_resources_table.tex'), resTex + '\n');

const COMPONENTS = [['chains', 'Block files (peer)'], ['stateLeveldb', 'World state (LevelDB)'],
  ['pvtdataStore', 'Private data store'], ['historyLeveldb', 'History database']];
const perWorkflow = {};
let lastAfter = null;
for (const r of runs) {
  const b = path.join(BASE, r, 'storage_before.csv'), a = path.join(BASE, r, 'storage_after.csv');
  if (!fs.existsSync(b) || !fs.existsSync(a)) continue;
  const toMap = rows2 => Object.fromEntries(rows2.map(x => [`${x.node}|${x.path}`, Number(x.kb)]));
  const before = toMap(readCsv(b)), after = toMap(readCsv(a));
  lastAfter = after;
  const workflows = infos[r].warmup + infos[r].iterations;
  for (const key of Object.keys(after)) {
    const [node, comp] = key.split('|');
    const label = node.startsWith('orderer') ? 'Block files (orderer)'
      : (COMPONENTS.find(c => c[0] === comp) || [null, comp])[1];
    if (!node.startsWith('orderer') && !node.includes('farmers')) continue;
    (perWorkflow[label] ??= []).push((after[key] - before[key]) / workflows);
  }
}
const storOrder = [...COMPONENTS.map(c => c[1]), 'Block files (orderer)'];
const storRows = storOrder.filter(l => perWorkflow[l]).map(l => ({ label: l, v: perWorkflow[l] }));
const peerTotal = storRows.filter(x => x.label !== 'Block files (orderer)').reduce((s, x) => s + mean(x.v), 0);
fs.writeFileSync(path.join(OUT, 't1_storage_summary.csv'),
  ['component,kb_per_workflow_mean,kb_per_workflow_sd,runs',
   ...storRows.map(x => [x.label, mean(x.v).toFixed(3), sd(x.v).toFixed(3), x.v.length].join(','))
  ].join('\n') + '\n');
const storTex = [
  '% Generated by analyze_t1.js',
  '\\begin{table}[t]',
  '\\centering\\small',
  '\\caption{T1: persistent storage growth per complete workflow (production, transformation, packaging, ' +
  'binding, consumption and one repeated scan), in KB, measured per peer; mean $\\pm$ SD over runs ' +
  '(\\texttt{du}, 4\\,KB granularity).}',
  '\\label{tab:t1-storage}',
  '\\begin{tabular}{lr}',
  '\\toprule',
  'Component & KB per workflow \\\\',
  '\\midrule',
  ...storRows.map(x => `${x.label} & ${f2(mean(x.v))} $\\pm$ ${f2(sd(x.v))} \\\\`),
  '\\midrule',
  `Total per peer & ${f2(peerTotal)} \\\\`,
  '\\bottomrule',
  '\\end{tabular}',
  '\\end{table}',
].join('\n');
fs.writeFileSync(path.join(OUT, 't1_storage_table.tex'), storTex + '\n');

console.log(`\nT1 ${CONFIG}: ${R} run, ${totalRequests} requests, ${failures.length} failed`);
if (failures.length) console.log(failures.slice(0, 10));
console.log('\nLATENCY (ms)');
console.log('operation                          N      mean  +-CI95    P50    P95    P99  endorse  submit  commit  CV run');
for (const x of rows) {
  console.log(`${x.label.padEnd(33)} ${String(x.n).padStart(4)} ${f1(x.mean).padStart(8)} ${f1(x.ci).padStart(6)}` +
    ` ${f1(x.p50).padStart(6)} ${f1(x.p95).padStart(6)} ${f1(x.p99).padStart(6)} ${f1(x.endorse).padStart(8)}` +
    ` ${f1(x.submit).padStart(7)} ${f1(x.commit).padStart(7)} ${f2(x.cvRuns).padStart(6)}%`);
}
console.log('\nRESOURCES (CPU % of one core, memory MiB)');
for (const x of resRows) {
  console.log(`${x.name.padEnd(28)} CPU mean  ${f2(mean(x.cpuMean)).padStart(6)}  max ${f2(Math.max(...x.cpuMax)).padStart(6)}` +
    `  mem ${f1(mean(x.memMean)).padStart(7)}  (${x.samples} samples)`);
}
console.log('\nSTORAGE (KB per complete workflow, per peer)');
for (const x of storRows) console.log(`${x.label.padEnd(28)} ${f2(mean(x.v)).padStart(8)} +- ${f2(sd(x.v))}`);
console.log(`${'Total per peer'.padEnd(28)} ${f2(peerTotal).padStart(8)}`);
console.log(`\nFiles written to ${OUT}:`);
for (const f of fs.readdirSync(OUT)) console.log(`  ${f}`);
