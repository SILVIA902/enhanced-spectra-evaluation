'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = process.argv[2] || 'main';
const BASE = path.join(__dirname, '..', 'results', 'T4', CONFIG);
const OUT = path.join(BASE, 'analysis');
if (!fs.existsSync(path.join(BASE, 'run_info.json'))) { console.error(`run_info.json not found in ${BASE}`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const info = JSON.parse(fs.readFileSync(path.join(BASE, 'run_info.json'), 'utf8'));
const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const ci = a => (a.length > 1 ? T975[Math.min(a.length - 1, 10)] * sd(a) / Math.sqrt(a.length) : NaN);
const f0 = v => (Number.isFinite(v) ? v.toFixed(0) : '--');
const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '--');
const f2 = v => (Number.isFinite(v) ? v.toFixed(2) : '--');

const groups = {};
for (const d of fs.readdirSync(BASE).filter(x => /^[ABC]_\d+(\.\d+)?$/.test(x))) {
  for (const r of fs.readdirSync(path.join(BASE, d)).filter(x => /^r\d+$/.test(x))) {
    const f = path.join(BASE, d, r, 'metrics.json');
    if (fs.existsSync(f)) (groups[d] ??= []).push(JSON.parse(fs.readFileSync(f, 'utf8')));
  }
}
const order = k => { const [p, v] = k.split('_'); return p.charCodeAt(0) * 1e6 + Number(v); };
const keys = Object.keys(groups).sort((a, b) => order(a) - order(b));

const rows = keys.map(k => {
  const g = groups[k];
  const col = name => g.map(x => x[name]).filter(Number.isFinite);
  const failures = {};
  for (const x of g) for (const [c, v] of Object.entries(x.failures || {})) failures[c] = (failures[c] || 0) + v;
  return {
    key: k, profile: g[0].profile, param: g[0].param, reps: g.length,
    requests: mean(col('requests')), valid: col('valid').reduce((a, b) => a + b, 0),
    total: col('requests').reduce((a, b) => a + b, 0),
    bad: g.reduce((s, x) => s + x.failed + x.unresolved, 0), failures,
    completion: mean(col('completionMs')), completionCi: ci(col('completionMs')),
    drain: mean(col('drainMs')), spread: Math.max(...g.map(x => x.releaseSpreadMs ?? 0)),
    p50: mean(col('p50')), p95: mean(col('p95')), p99: mean(col('p99')), max: Math.max(...col('max')),
    maxOut: Math.max(...col('maxOutstanding')), blocks: mean(col('blocks')),
    burstsOk: g[0].profile === 'B' ? g.reduce((s, x) => s + x.burstsCompletedBeforeNext, 0) : null,
    burstsTot: g[0].profile === 'B' ? g.reduce((s, x) => s + x.perBurstCompletionMs.length, 0) : null,
    burstMax: g[0].profile === 'B' ? Math.max(...g.flatMap(x => x.perBurstCompletionMs)) : null,
    rate: g[0].profile === 'C' ? mean(col('achievedRate')) : null,
    cv: g[0].profile === 'C' ? mean(col('interArrivalCv')) : null,
    outP95: g[0].profile === 'C' ? mean(col('outstandingP95')) : null,
  };
});

fs.writeFileSync(path.join(OUT, 't4_summary.csv'),
  ['config,profile,param,reps,requests_per_run,valid_total,requests_total,invalid_or_unresolved,completion_mean_ms,' +
   'completion_ci95_ms,drain_mean_ms,release_spread_max_ms,p50_ms,p95_ms,p99_ms,max_ms,max_outstanding,blocks_per_run,' +
   'bursts_completed_before_next,bursts_total,burst_completion_max_ms,poisson_rate,interarrival_cv,outstanding_p95',
   ...rows.map(r => [r.key, r.profile, r.param, r.reps, r.requests, r.valid, r.total, r.bad, r.completion, r.completionCi,
     r.drain, r.spread, r.p50, r.p95, r.p99, r.max, r.maxOut, r.blocks, r.burstsOk, r.burstsTot, r.burstMax, r.rate, r.cv, r.outP95]
     .map(v => (typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(3) : '') : v ?? '')).join(','))].join('\n') + '\n');

const hhmm = iso => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
const A = rows.filter(r => r.profile === 'A'), B = rows.filter(r => r.profile === 'B'), C = rows.filter(r => r.profile === 'C');
const totReq = rows.reduce((s, r) => s + r.total, 0), totBad = rows.reduce((s, r) => s + r.bad, 0);
const desc = r => r.profile === 'A' ? `A: single burst, $B=${r.param}$`
  : r.profile === 'B' ? `B: ${info.pbSize} every ${info.pbPeriod}\\,s for ${info.pbDuration}\\,s`
  : `C: Poisson, $\\bar\\lambda=${r.param}$\\,TPS`;
const tableRows = rows.map(r => `${desc(r)} & ${f0(r.requests)} & ${r.valid}/${r.total} & ${f2(r.completion / 1000)} $\\pm$ ` +
  `${f2(r.completionCi / 1000)} & ${f0(r.p50)} & ${f0(r.p95)} & ${f0(r.p99)} & ${f0(r.maxOut)} & ${f1(r.blocks)} \\\\`);

const aText = A.length ? `Single bursts of ${A.map(r => r.param).join(', ')} requests (released within at most ` +
  `${f1(Math.max(...A.map(r => r.spread)))}\\,ms) were completed in ${A.map(r => `${f2(r.completion / 1000)}\\,s`).join(', ')} ` +
  `respectively, from the first submission to the last commit, with P95 latencies of ${A.map(r => `${f0(r.p95)}`).join(', ')}\\,ms.` : '';
const bText = B.length ? ` In the periodic profile, ${B[0].burstsOk} of ${B[0].burstsTot} bursts were fully committed before the ` +
  `next burst was released (maximum burst completion time ${f2(B[0].burstMax / 1000)}\\,s), so no backlog accumulated between bursts.` : '';
const cText = C.length ? ` Under Poisson arrivals (${C.map(r => `${f1(r.rate)}\\,TPS achieved, inter-arrival CV ${f2(r.cv)}`).join('; ')}) ` +
  `the P95 latency was ${C.map(r => `${f0(r.p95)}\\,ms`).join(' and ')} and the number of outstanding requests stayed below ` +
  `${C.map(r => f0(r.maxOut)).join(' and ')} respectively.` : '';

const tex = String.raw`% Generated by analyze_t4.js - paste before \end{document}
\subsection{T4 -- Transactional bursts}
Executed on ${info.startedAt.slice(0, 10)} (${hhmm(info.startedAt)}--${hhmm(info.finishedAt)} CEST) with the state-changing
operation \texttt{RegisterProduction} and ${info.clients} client connections. Submission schedules were precomputed and
saved with their seed (${info.seed}); requests are released open-loop at their scheduled offsets.
Profile~A releases $B$ requests at the same instant; profile~B releases ${info.pbSize} requests every ${info.pbPeriod}\,s for
${info.pbDuration}\,s (inter-burst interval ${info.pbPeriod}\,s, burst duration $\approx$0\,s); profile~C draws exponential
inter-arrival times with mean rates ${info.poisson.join(' and ')}\,TPS over ${info.pcDuration}\,s
(approximately 50\% and 80\% of the maximum sustainable state-changing rate measured in T2). Each configuration was
repeated ${info.reps} times with ${info.gap}\,s of idle time between runs. Completion time is measured from the first
submission to the last commit of the run.

\begin{table}[H]
\centering\small
\caption{T4: burst and Poisson workloads (mean over ${info.reps} repetitions; completion time $\pm$ 95\% CI). Requests: per
run; Valid: over all repetitions; latency percentiles of valid transactions; Max out.: maximum number of outstanding
requests; Blocks: blocks used per run.}
\label{tab:t4}
\setlength{\tabcolsep}{3.5pt}
\begin{tabular}{lrrrrrrrr}
\toprule
Profile & Requests & Valid & Completion (s) & P50 & P95 & P99 & Max out. & Blocks \\
 & & & & (ms) & (ms) & (ms) & & \\
\midrule
${tableRows.join('\n')}
\bottomrule
\end{tabular}
\end{table}

\paragraph{Observations.}
\begin{itemize}
  \item \textbf{Correctness under bursts.} ${totReq - totBad} of ${totReq} requests were committed as valid
        (${totBad} invalid or unresolved).
  \item \textbf{Burst absorption.} ${aText}${bText}
${C.length ? `  \\item \\textbf{Random arrivals.}${cText}` : ''}
  \item \textbf{Batching effect.} Larger bursts fill blocks of \texttt{MaxMessageCount} = 10 transactions immediately,
        so the latency of a burst is driven by the number of blocks to be cut and committed rather than by the
        2\,s \texttt{BatchTimeout}.
\end{itemize}
`;
fs.writeFileSync(path.join(OUT, 't4_section.tex'), tex);

console.log(`\nT4 ${CONFIG}: ${rows.length} configurations, ${totReq} requests, ${totBad} invalid or unresolved`);
console.log('config      rep   requests  valid       completion(s)      P50    P95    P99   max out.   blocks  extra');
for (const r of rows) {
  const extra = r.profile === 'B' ? `bursts completed before the next ${r.burstsOk}/${r.burstsTot}, max ${f2(r.burstMax / 1000)} s`
    : r.profile === 'C' ? `tasso ${f1(r.rate)} TPS, CV ${f2(r.cv)}` : `spread ${f1(r.spread)} ms`;
  console.log(`${r.key.padEnd(10)} ${String(r.reps).padStart(4)} ${f0(r.requests).padStart(10)} ${`${r.valid}/${r.total}`.padStart(11)}` +
    ` ${`${f2(r.completion / 1000)} +- ${f2(r.completionCi / 1000)}`.padStart(17)} ${f0(r.p50).padStart(6)} ${f0(r.p95).padStart(6)}` +
    ` ${f0(r.p99).padStart(6)} ${f0(r.maxOut).padStart(9)} ${f1(r.blocks).padStart(8)}  ${extra}` +
    (r.bad ? `  ERRORS ${JSON.stringify(r.failures)}` : ''));
}
console.log(`\nLaTeX block: ${path.join(OUT, 't4_section.tex')}`);
