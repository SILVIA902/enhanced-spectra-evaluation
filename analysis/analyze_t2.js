'use strict';

const fs = require('fs');
const path = require('path');

const CONFIGS = process.argv.slice(2).length ? process.argv.slice(2) : ['main'];
const CONFIG = CONFIGS[0];
const ROOT = path.join(__dirname, '..', 'results', 'T2');
const BASE = path.join(ROOT, CONFIG);
const OUT = path.join(BASE, 'analysis');
for (const c of CONFIGS) {
  if (!fs.existsSync(path.join(ROOT, c, 'sweep_summary.csv'))) { console.error(`sweep_summary.csv not found in ${path.join(ROOT, c)}`); process.exit(1); }
}
fs.mkdirSync(OUT, { recursive: true });

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map(l => {
    const v = l.split(','); const o = {};
    head.forEach((k, i) => { o[k] = v[i]; });
    return o;
  });
}
const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const ci95 = a => (a.length > 1 ? T975[Math.min(a.length - 1, 10)] * sd(a) / Math.sqrt(a.length) : NaN);
const f1 = v => (v === null || v === undefined || Number.isNaN(v) ? '--' : v.toFixed(1));
const f2 = v => (v === null || v === undefined || Number.isNaN(v) ? '--' : v.toFixed(2));
const n = x => (x === '' || x === undefined ? NaN : Number(x));

function shortName(c) {
  const org = c.includes('farmers') ? 'Farmers' : c.includes('producers') ? 'Producers' : '';
  if (c.startsWith('dev-peer')) return /-certificate_/.test(c) ? `cc-certificate-${org}` : `cc-userauth-${org}`;
  if (c.startsWith('peer0')) return `peer-${org}`;
  if (c.startsWith('orderer')) return 'orderer';
  return null;
}
function cpuOfLevel(dir, startedAt, warm, measure) {
  const f = path.join(dir, 'resources.csv');
  if (!fs.existsSync(f)) return {};
  const t0 = Date.parse(startedAt) + warm * 1000, t1 = t0 + measure * 1000;
  const acc = {};
  for (const x of readCsv(f)) {
    const t = n(x.epoch_ms), name = shortName(x.container || '');
    if (!name || t < t0 || t > t1) continue;
    (acc[name] ??= []).push(parseFloat(x.cpu_pct));
  }
  return Object.fromEntries(Object.entries(acc).map(([k, v]) => [k, mean(v)]));
}

function loadConfig(cfg) {
  const BASEC = path.join(ROOT, cfg);
  const infoC = JSON.parse(fs.readFileSync(path.join(BASEC, 'run_info.json'), 'utf8'));
  const sweep = readCsv(path.join(BASEC, 'sweep_summary.csv'));
  const levels = [];
for (const w of infoC.workloads) {
  const rates = [...new Set(sweep.filter(r => r.workload === w).map(r => n(r.rate)))].sort((a, b) => a - b);
  for (const rate of rates) {
    const reps = sweep.filter(r => r.workload === w && n(r.rate) === rate);
    const cpu = { peer: [], orderer: [], cc: [] };
    for (const r of reps) {
      const dir = path.join(BASEC, w, `L${rate}`, `r${Number(r.rep)}`);
      const sumFile = path.join(dir, 'level_summary.json');
      if (!fs.existsSync(sumFile)) continue;
      const s = JSON.parse(fs.readFileSync(sumFile, 'utf8'));
      const c = cpuOfLevel(dir, s.startedAt, s.warm, s.measure);
      cpu.peer.push(mean([c['peer-Farmers'], c['peer-Producers']].filter(Number.isFinite)));
      if (Number.isFinite(c.orderer)) cpu.orderer.push(c.orderer);
      cpu.cc.push(['cc-certificate-Farmers', 'cc-certificate-Producers', 'cc-userauth-Farmers', 'cc-userauth-Producers']
        .map(k => c[k]).filter(Number.isFinite).reduce((a, b) => a + b, 0));
    }
    const failures = {};
    for (const r of reps) {
      const f = path.join(BASEC, w, `L${rate}`, `r${Number(r.rep)}`, 'level_summary.json');
      if (!fs.existsSync(f)) continue;
      const s = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const [k, v] of Object.entries(s.failures || {})) failures[k] = (failures[k] || 0) + v;
      if (s.unresolvedAfterDrain) failures.UNRESOLVED_AFTER_DRAIN = (failures.UNRESOLVED_AFTER_DRAIN || 0) + s.unresolvedAfterDrain;
    }
    const col = k => reps.map(r => n(r[k])).filter(Number.isFinite);
    levels.push({
      cfg, w, rate, reps: reps.length,
      lambda: mean(col('lambda_measured')), goodput: mean(col('goodput')), goodputCi: ci95(col('goodput')),
      p50: mean(col('p50_ms')), p95: mean(col('p95_ms')), p99: mean(col('p99_ms')),
      endorse: mean(col('endorse_mean_ms')), commit: mean(col('commit_mean_ms')),
      fail: 100 * mean(col('fail_rate')), maxOut: Math.max(...col('max_outstanding')),
      sustainable: reps.every(r => r.sustainable === 'true'), failures,
      reasons: [...new Set(reps.flatMap(r => (r.reasons ? r.reasons.split('|') : [])))].filter(Boolean),
      cpuPeer: mean(cpu.peer.filter(Number.isFinite)), cpuOrderer: mean(cpu.orderer), cpuCc: mean(cpu.cc.filter(Number.isFinite)),
    });
  }
}
  return { info: infoC, levels };
}

const loaded = CONFIGS.map(c => ({ cfg: c, ...loadConfig(c) }));
const info = loaded[0].info;
const levels = [];
const anchors = [];
for (const { cfg, levels: Ls } of loaded) {
  for (const l of Ls) {
    const prev = levels.find(x => x.w === l.w && x.rate === l.rate);
    if (prev) anchors.push({ w: l.w, rate: l.rate, ref: prev, other: l });
    else levels.push(l);
  }
}
const allWorkloads = [...new Set(loaded.flatMap(x => x.info.workloads))];
info.workloads = allWorkloads;
levels.sort((a, b) => (a.w === b.w ? a.rate - b.rate : allWorkloads.indexOf(a.w) - allWorkloads.indexOf(b.w)));

const result = {};
for (const w of info.workloads) {
  const L = levels.filter(l => l.w === w);
  let lastOk = null, sat = null;
  for (const l of L) { if (l.sustainable && !sat) lastOk = l; else if (!l.sustainable && !sat) sat = l; }
  result[w] = { lastOk, sat, maxGoodput: Math.max(...L.map(l => l.goodput)) };
}

let storage = null;
const sb = path.join(BASE, 'storage_before_write.csv'), sa = path.join(BASE, 'storage_after_write.csv');
if (fs.existsSync(sb) && fs.existsSync(sa)) {
  const toMap = f => Object.fromEntries(readCsv(f).map(x => [`${x.node}|${x.path}`, Number(x.kb)]));
  const b = toMap(sb), a = toMap(sa);
  let validTx = 0;
  for (const rate of levels.filter(l => l.w === 'write').map(l => l.rate)) {
    for (let rep = 1; rep <= info.reps; rep++) {
      const f = path.join(BASE, 'write', `L${rate}`, `r${rep}`, 'requests.csv');
      if (fs.existsSync(f)) validTx += readCsv(f).filter(x => x.status === 'VALID').length;
    }
  }
  const comp = (node, p) => (a[`${node}|${p}`] - b[`${node}|${p}`]);
  const P = 'peer0.farmers.example.com';
  storage = { validTx,
    blocks: comp(P, 'chains'), state: comp(P, 'stateLeveldb'), history: comp(P, 'historyLeveldb'),
    orderer: comp('orderer.example.com', 'chains') };
  storage.perTxPeer = (storage.blocks + storage.state + storage.history) / validTx;
  storage.perTxBlocks = storage.blocks / validTx;
}

fs.writeFileSync(path.join(OUT, 't2_levels.csv'),
  ['workload,rate,reps,lambda,goodput,goodput_ci95,p50_ms,p95_ms,p99_ms,endorse_ms,commit_ms,fail_pct,max_outstanding,' +
   'cpu_peer_pct,cpu_orderer_pct,cpu_chaincode_sum_pct,sustainable,reasons',
   ...levels.map(l => [l.w, l.rate, l.reps, l.lambda, l.goodput, l.goodputCi, l.p50, l.p95, l.p99, l.endorse, l.commit,
     l.fail, l.maxOut, l.cpuPeer, l.cpuOrderer, l.cpuCc, l.sustainable, l.reasons.join('|')]
     .map(v => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(3) : '') : v)).join(','))].join('\n') + '\n');

const hhmm = iso => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
const day = info.startedAt.slice(0, 10);
const refine = loaded.slice(1).map(x => x.info);
const refineText = refine.length ? ` Intermediate rates were added in a second session on ` +
  `${refine[0].startedAt.slice(0, 10)} (${refine.map(i => `${i.workloads.join('/')}: ${i.rates.join(', ')}\\,TPS, ` +
  `${hhmm(i.startedAt)}--${hhmm(i.finishedAt)} CEST`).join('; ')}) on a freshly re-created network with the same ` +
  `configuration, using the P95 reference of the first session (${Object.entries(refine[0].p95base || {}).concat(...refine.slice(1)
    .map(i => Object.entries(i.p95base || {}))).map(([k, v]) => `${k} ${v}\\,ms`).join(', ')}) for the saturation criterion. ` +
  (anchors.length ? `One rate per workload was repeated in both sessions as an anchor: ${anchors.map(a =>
    `${a.w === 'write' ? 'state-changing' : 'read-only'} ${a.rate}\\,TPS, goodput ${f1(a.ref.goodput)} vs ${f1(a.other.goodput)}\\,TPS, ` +
    `P95 ${f1(a.ref.p95)} vs ${f1(a.other.p95)}\\,ms`).join('; ')} (first vs second session).` : '') : '';
const label = { write: 'State-changing (\\texttt{RegisterProduction})', read: 'Read-only (\\texttt{VerifyByUID})' };
const tableRows = [];
for (const w of info.workloads) {
  tableRows.push(`\\multicolumn{10}{l}{\\emph{${label[w]}}} \\\\`);
  for (const l of levels.filter(x => x.w === w)) {
    tableRows.push(`${l.rate} & ${f1(l.lambda)} & ${f1(l.goodput)} $\\pm$ ${f1(l.goodputCi)} & ${f1(l.p50)} & ${f1(l.p95)} & ` +
      `${f1(l.p99)} & ${f2(l.fail)} & ${f1(l.cpuPeer)} & ${f1(l.cpuOrderer)} & ${l.sustainable ? 'yes' : 'no'} \\\\`);
  }
}
const coords = (w, k) => levels.filter(l => l.w === w && Number.isFinite(l[k]) && l[k] > 0)
  .map(l => `(${l.rate},${l[k].toFixed(2)})`).join(' ');
const ideal = levels.filter(l => l.w === 'write').map(l => `(${l.rate},${l.rate})`).join(' ');
const sentence = w => {
  const r = result[w]; if (!r) return '';
  const ok = r.lastOk ? `the highest sustainable offered rate was ${r.lastOk.rate}\\,TPS (goodput ${f1(r.lastOk.goodput)}\\,TPS, ` +
    `P95 ${f1(r.lastOk.p95)}\\,ms)` : 'no tested rate was sustainable';
  const top = r.sat ? Object.entries(r.sat.failures).sort((a, b) => b[1] - a[1])[0] : null;
  const sat = r.sat ? `; the criterion was first violated at ${r.sat.rate}\\,TPS (${r.sat.reasons.join(', ').replace(/%/g, '\\%')}), ` +
    `where the goodput reached ${f1(r.sat.goodput)}\\,TPS` +
    (top ? ` and the dominant failure class was \\texttt{${top[0].replace(/_/g, '\\_')}}` : '')
    : '; no tested rate violated the saturation criterion';
  return ok + sat;
};
const wr = result.write, rd = result.read;
const tex = String.raw`% Generated by analyze_t2.js - paste before \end{document}
\subsection{T2 -- Offered load and saturation}
Executed on ${day} (${hhmm(info.startedAt)}--${hhmm(info.finishedAt)} CEST) with the benchmark harness acting as an
open-loop load generator (fixed inter-arrival times, ${info.clients} client connections per identity; requests are
released on schedule without waiting for previous responses). Offered rates ${info.rates.join(', ')}\,TPS; for each
rate ${info.reps} repetitions of ${info.warm}\,s warm-up, ${info.measure}\,s measurement window and up to
${info.drain}\,s drain. Only requests \emph{submitted} in the measurement window are counted; throughput and
goodput are averages over the window. The state-changing workload is \texttt{RegisterProduction} (independent keys,
includes the \texttt{userauth} authorization call, no prepared assets required); the read-only workload is
\texttt{VerifyByUID} on ${info.readUids} prepared bound UIDs. A workload sweep stops after two consecutive
non-sustainable rates. \texttt{BatchTimeout} = 2\,s, \texttt{MaxMessageCount} = 10.${refineText}

\begin{table}[H]
\centering\small
\caption{T2: offered load sweep (mean over ${info.reps} repetitions; goodput $\pm$ 95\% CI). $\lambda$: measured
submission rate; goodput: valid transactions per second; latency percentiles of valid requests; CPU: mean of the two
peers and of the orderer in \% of one core during the measurement window; sustainable: saturation criterion of
Section~2.5 satisfied in every repetition.}
\label{tab:t2}
\setlength{\tabcolsep}{3.5pt}
\begin{tabular}{rrrrrrrrrc}
\toprule
Offered & $\lambda$ & Goodput & P50 & P95 & P99 & Fail & CPU peer & CPU ord. & Sust. \\
(TPS) & (TPS) & (TPS) & (ms) & (ms) & (ms) & (\%) & (\%) & (\%) & \\
\midrule
${tableRows.join('\n')}
\bottomrule
\end{tabular}
\end{table}

\begin{figure}[H]
\centering
\begin{tikzpicture}
\begin{axis}[width=0.48\linewidth, height=5.5cm, xmode=log, log basis x=2, ymode=log, log basis y=2,
  xlabel={Offered rate (TPS)}, ylabel={Goodput (TPS)}, log ticks with fixed point, tick label style={font=\scriptsize},
  legend style={font=\scriptsize, at={(0.02,0.98)}, anchor=north west}]
\addplot+[mark=*] coordinates {${coords('write', 'goodput')}};
\addlegendentry{State-changing}
${info.workloads.includes('read') ? `\\addplot+[mark=square*] coordinates {${coords('read', 'goodput')}};\n\\addlegendentry{Read-only}` : ''}
\addplot[dashed, gray] coordinates {${ideal}};
\addlegendentry{Goodput = offered}
\end{axis}
\end{tikzpicture}\hfill
\begin{tikzpicture}
\begin{axis}[width=0.48\linewidth, height=5.5cm, xmode=log, log basis x=2, ymode=log,
  xlabel={Offered rate (TPS)}, ylabel={P95 latency (ms)}, log ticks with fixed point, tick label style={font=\scriptsize},
  legend style={font=\scriptsize, at={(0.98,0.5)}, anchor=east}]
\addplot+[mark=*] coordinates {${coords('write', 'p95')}};
\addlegendentry{State-changing}
${info.workloads.includes('read') ? `\\addplot+[mark=square*] coordinates {${coords('read', 'p95')}};\n\\addlegendentry{Read-only}` : ''}
\end{axis}
\end{tikzpicture}
\caption{T2: goodput (left) and P95 latency (right) as a function of the offered rate (logarithmic axes).}
\label{fig:t2}
\end{figure}

\paragraph{Observations.}
\begin{itemize}
  \item \textbf{State-changing workload:} ${sentence('write')}.
${rd ? `  \\item \\textbf{Read-only workload:} ${sentence('read')}.` : ''}
  \item \textbf{Latency under load.} For state-changing transactions the latency first \emph{decreases} with the offered
        rate, because blocks reach \texttt{MaxMessageCount} = 10 before the 2\,s \texttt{BatchTimeout} expires (T1-b), and
        increases again only when the system approaches saturation.
${storage ? `  \\item \\textbf{Storage under load.} The ${storage.validTx} valid \\texttt{RegisterProduction} transactions of the sweep
        added ${f1(storage.blocks / 1024)}\\,MB of block files, ${f1(storage.state / 1024)}\\,MB of world state and
        ${f1(storage.history / 1024)}\\,MB of history database per peer, i.e.\\ ${f2(storage.perTxPeer)}\\,KB per transaction
        (${f2(storage.perTxBlocks)}\\,KB of block files) with batched blocks.` : ''}
  \item \textbf{Scope.} The load generator runs on the same host as the network; the reported capacity is therefore a
        lower bound for the tested single-host configuration and not a property of Fabric or of Enhanced SPECTRA in
        general.
\end{itemize}
`;
fs.writeFileSync(path.join(OUT, 't2_section.tex'), tex);

console.log(`\nT2 ${CONFIG} (${info.startedAt} -> ${info.finishedAt})`);
for (const a of anchors) console.log(`ANCHOR ${a.w} ${a.rate} TPS: goodput ${f1(a.ref.goodput)} -> ${f1(a.other.goodput)}, P50 ${f1(a.ref.p50)} -> ${f1(a.other.p50)}, P95 ${f1(a.ref.p95)} -> ${f1(a.other.p95)} ms (${a.ref.cfg} -> ${a.other.cfg})`);
console.log('workload  offered  lambda  goodput  +-CI    P50     P95     P99   err%  CPUpeer  CPUord  sust.');
for (const l of levels) {
  console.log(`${l.w.padEnd(8)} ${String(l.rate).padStart(7)} ${f1(l.lambda).padStart(7)} ${f1(l.goodput).padStart(8)} ${f1(l.goodputCi).padStart(5)}` +
    ` ${f1(l.p50).padStart(7)} ${f1(l.p95).padStart(7)} ${f1(l.p99).padStart(7)} ${f2(l.fail).padStart(6)} ${f1(l.cpuPeer).padStart(8)}` +
    ` ${f1(l.cpuOrderer).padStart(7)}  ${l.sustainable ? 'yes' : 'NO ' + l.reasons.join(',')}`);
}
console.log('\nFAILURE CLASSES (non-sustainable levels, sum over repetitions)');
for (const l of levels.filter(x => !x.sustainable)) console.log(`${l.w} ${l.rate} TPS: ${JSON.stringify(l.failures)}`);
for (const w of info.workloads) {
  const r = result[w];
  console.log(`\n${w}: maximum sustainable rate ${r.lastOk ? r.lastOk.rate + ' TPS (goodput ' + f1(r.lastOk.goodput) + ')' : '-'};` +
    ` saturation at ${r.sat ? r.sat.rate + ' TPS' : 'not reached'}; maximum observed goodput ${f1(r.maxGoodput)} TPS`);
}
if (storage) console.log(`storage: ${storage.validTx} valid tx, ${f2(storage.perTxPeer)} KB/tx per peer (blocks ${f2(storage.perTxBlocks)} KB/tx)`);
console.log(`\nLaTeX block: ${path.join(OUT, 't2_section.tex')}`);
