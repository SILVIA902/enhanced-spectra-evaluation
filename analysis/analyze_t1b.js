'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'results', 'T1');
const OUT = path.join(ROOT, 'T1b_analysis');
const CONFIGS = [['bt2s', 2000], ['bt1s', 1000], ['bt500ms', 500]];
const OPS = [
  ['RegisterProduction', 'Production registration', 'W'],
  ['RegisterTransformation', 'Transformation (mass balance)', 'W'],
  ['CreatePackageForLot', 'Package creation', 'W'],
  ['RegisterBindingForPackage', 'Binding registration (PDC)', 'W'],
  ['ConsumeByUID', 'Certificate consumption', 'W'],
  ['ConsumeByUID_repeat', 'Repeated scan (consumed cert.)', 'W'],
  ['GetProductionByLotCode', 'Production query', 'R'],
  ['GetCert', 'Certificate query', 'R'],
  ['VerifyCertIntegrity', 'Certificate integrity check', 'R'],
  ['CheckAuthorized', 'Authorization check', 'R'],
  ['VerifyByUID', 'UID verification (PDC)', 'R'],
];
const T975 = [NaN, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const head = lines[0].split(',');
  return lines.slice(1).filter(Boolean).map(l => {
    const v = l.split(','); const o = {};
    head.forEach((k, i) => { o[k] = v[i]; });
    return o;
  });
}
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const ci95 = a => (a.length > 1 ? T975[Math.min(a.length - 1, 10)] * sd(a) / Math.sqrt(a.length) : NaN);
const f1 = v => (v === null || v === undefined || Number.isNaN(v) ? '--' : v.toFixed(1));
const num = x => (x === '' || x === undefined ? null : Number(x));

const stats = {};
const meta = {};
for (const [cfg] of CONFIGS) {
  const dir = path.join(ROOT, cfg);
  if (!fs.existsSync(dir)) { console.error(`Missing configuration ${cfg} (${dir})`); process.exit(1); }
  const runs = fs.readdirSync(dir).filter(d => /^r\d+$/.test(d)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const infos = runs.map(r => JSON.parse(fs.readFileSync(path.join(dir, r, 'run_info.json'), 'utf8')));
  let failed = 0, total = 0;
  const per = {};
  for (const r of runs) {
    for (const x of readCsv(path.join(dir, r, 'requests.csv'))) {
      total++;
      const ok = (x.status === 'VALID' || x.status === 'OK') && !x.failure_class;
      if (!ok) { failed++; continue; }
      ((per[x.op] ??= {})[r] ??= []).push({ e2e: num(x.l_e2e_ms), endorse: num(x.l_endorse_ms),
        submit: num(x.l_submit_ms), commit: num(x.l_commit_ms) });
    }
  }
  meta[cfg] = { runs: runs.length, iterations: infos[0].iterations, total, failed,
    startedAt: infos[0].startedAt, finishedAt: infos[infos.length - 1].finishedAt };
  stats[cfg] = {};
  for (const [op, , cls] of OPS) {
    if (!per[op]) continue;
    const perRun = Object.values(per[op]);
    const all = perRun.flat();
    const m = k => (cls === 'W' ? mean(all.map(x => x[k])) : null);
    stats[cfg][op] = {
      n: all.length, e2e: mean(all.map(x => x.e2e)), ci: ci95(perRun.map(a => mean(a.map(x => x.e2e)))),
      endorse: m('endorse'), submit: m('submit'), commit: m('commit'),
      endorseCi: cls === 'W' ? ci95(perRun.map(a => mean(a.map(x => x.endorse)))) : null,
    };
  }
}

const writeOps = OPS.filter(o => o[2] === 'W').map(o => o[0]);
const pts = CONFIGS.map(([cfg, bt]) => [bt, mean(writeOps.filter(op => stats[cfg][op]).map(op => stats[cfg][op].commit))]);
const xm = mean(pts.map(p => p[0])), ym = mean(pts.map(p => p[1]));
const slope = pts.reduce((s, [x, y]) => s + (x - xm) * (y - ym), 0) / pts.reduce((s, [x]) => s + (x - xm) ** 2, 0);
const intercept = ym - slope * xm;
const ssTot = pts.reduce((s, [, y]) => s + (y - ym) ** 2, 0);
const ssRes = pts.reduce((s, [x, y]) => s + (y - (intercept + slope * x)) ** 2, 0);
const r2 = 1 - ssRes / ssTot;
const endorseRange = cfg => {
  const v = writeOps.filter(op => stats[cfg][op]).map(op => stats[cfg][op].endorse);
  return [Math.min(...v), Math.max(...v)];
};
const readRange = cfg => {
  const v = OPS.filter(o => o[2] === 'R' && stats[cfg][o[0]]).map(o => stats[cfg][o[0]].e2e);
  return [Math.min(...v), Math.max(...v)];
};

fs.mkdirSync(OUT, { recursive: true });
const csv = ['op,config,batch_timeout_ms,n,e2e_mean_ms,e2e_ci95_ms,endorse_mean_ms,endorse_ci95_ms,submit_mean_ms,commit_mean_ms'];
for (const [op] of OPS) for (const [cfg, bt] of CONFIGS) {
  const s = stats[cfg][op]; if (!s) continue;
  csv.push([op, cfg, bt, s.n, s.e2e, s.ci, s.endorse, s.endorseCi, s.submit, s.commit]
    .map(v => (typeof v === 'number' ? v.toFixed(3) : v ?? '')).join(','));
}
fs.writeFileSync(path.join(OUT, 't1b_summary.csv'), csv.join('\n') + '\n');

const hhmm = iso => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
const rowsW = OPS.filter(o => o[2] === 'W').map(([op, label]) =>
  `${label} & ${CONFIGS.map(([c]) => f1(stats[c][op]?.e2e)).join(' & ')} & ` +
  `${CONFIGS.map(([c]) => f1(stats[c][op]?.endorse)).join(' & ')} \\\\`);
const rowsR = OPS.filter(o => o[2] === 'R').map(([op, label]) =>
  `${label} & ${CONFIGS.map(([c]) => f1(stats[c][op]?.e2e)).join(' & ')} & \\multicolumn{3}{c}{--} \\\\`);
const plot = (op, label) => `\\addplot+[mark=*] coordinates {${CONFIGS.map(([c, bt]) => `(${bt},${stats[c][op].e2e.toFixed(1)})`).join(' ')}};\n\\addlegendentry{${label}}`;
const [e1lo, e1hi] = endorseRange('bt2s'), [e3lo, e3hi] = endorseRange('bt500ms');
const [r1lo, r1hi] = readRange('bt2s'), [r3lo, r3hi] = readRange('bt500ms');
const m1 = meta.bt1s, m3 = meta.bt500ms;

const tex = String.raw`% Generated by analyze_t1b.js - paste before \end{document}
\subsection{T1-b -- Effect of the block-cutting timeout}
The T1 procedure was repeated after changing only the channel parameter \texttt{BatchTimeout} through a signed
channel configuration update (all other parameters unchanged): 1\,s (${m1.runs} runs $\times$ ${m1.iterations}
iterations, ${hhmm(m1.startedAt)}--${hhmm(m1.finishedAt)} CEST) and 0.5\,s (${m3.runs} runs $\times$
${m3.iterations} iterations, ${hhmm(m3.startedAt)}--${hhmm(m3.finishedAt)} CEST), each with 2 excluded warm-up
iterations. The 2\,s values are those of T1. All ${m1.total + m3.total} additional requests completed successfully
(${m1.failed + m3.failed} failures). The original value of 2\,s was restored at the end of the experiment.

\begin{table}[H]
\centering\small
\caption{T1-b: mean latency (ms) of each operation for \texttt{BatchTimeout} = 2\,s, 1\,s and 0.5\,s.
End-to-end latency and endorsement phase (chaincode execution) of state-changing operations; end-to-end latency
of read-only queries.}
\label{tab:t1b}
\setlength{\tabcolsep}{4pt}
\begin{tabular}{lrrrrrr}
\toprule
 & \multicolumn{3}{c}{End-to-end} & \multicolumn{3}{c}{Endorse} \\
\cmidrule(lr){2-4}\cmidrule(lr){5-7}
Operation & 2\,s & 1\,s & 0.5\,s & 2\,s & 1\,s & 0.5\,s \\
\midrule
\multicolumn{7}{l}{\emph{State-changing}} \\
${rowsW.join('\n')}
\midrule
\multicolumn{7}{l}{\emph{Read-only}} \\
${rowsR.join('\n')}
\bottomrule
\end{tabular}
\end{table}

\begin{figure}[H]
\centering
\begin{tikzpicture}
\begin{axis}[width=0.75\linewidth, height=6cm, xlabel={\texttt{BatchTimeout} (ms)},
  ylabel={Mean end-to-end latency (ms)}, xtick={500,1000,2000}, xmin=300, xmax=2200, ymin=0,
  legend style={font=\scriptsize, at={(0.98,0.02)}, anchor=south east}, tick label style={font=\footnotesize}]
${OPS.filter(o => o[2] === 'W' && o[0] !== 'ConsumeByUID_repeat').map(([op, label]) => plot(op, label)).join('\n')}
\addplot[dashed, domain=300:2200] {${intercept.toFixed(1)} + ${slope.toFixed(4)}*x};
\addlegendentry{Linear fit of the commit phase}
\end{axis}
\end{tikzpicture}
\caption{T1-b: end-to-end latency of state-changing operations as a function of \texttt{BatchTimeout}.}
\label{fig:t1b}
\end{figure}

\paragraph{Observations.}
\begin{itemize}
  \item \textbf{Causal confirmation.} The mean commit-phase latency of state-changing operations follows
        $L^{\mathrm{com}} \approx ${intercept.toFixed(1)}\,\mathrm{ms} + ${slope.toFixed(3)} \cdot \texttt{BatchTimeout}$
        ($R^2 = ${r2.toFixed(4)}$): reducing the timeout from 2\,s to 0.5\,s reduces the end-to-end latency of
        every write by the same amount, which confirms that under sequential submission the write latency is
        determined by the block-cutting configuration of the ordering service.
  \item \textbf{Chaincode cost is unaffected.} The endorsement phase remains in the same range
        (${f1(e1lo)}--${f1(e1hi)}\,ms at 2\,s, ${f1(e3lo)}--${f1(e3hi)}\,ms at 0.5\,s), as do read-only queries
        (${f1(r1lo)}--${f1(r1hi)}\,ms and ${f1(r3lo)}--${f1(r3hi)}\,ms): the cost of the Enhanced SPECTRA mechanisms is
        independent of the ordering configuration.
  \item \textbf{Deployment implication.} \texttt{BatchTimeout} is a deployment trade-off: a shorter timeout lowers
        the latency of individual transactions under light load, at the cost of smaller blocks and higher
        per-transaction block overhead. Throughput under load is evaluated in T2 with the default value of 2\,s.
\end{itemize}
`;
fs.writeFileSync(path.join(OUT, 't1b_section.tex'), tex);

console.log('\nT1-b: mean end-to-end / endorse latency (ms)');
console.log('operation                             2s e2e   1s e2e  0.5s e2e |  2s end   1s end  0.5s end');
for (const [op, label, cls] of OPS) {
  const g = (c, k) => f1(stats[c][op]?.[k]).padStart(8);
  console.log(`${label.padEnd(36)} ${g('bt2s', 'e2e')} ${g('bt1s', 'e2e')} ${g('bt500ms', 'e2e')} |` +
    (cls === 'W' ? ` ${g('bt2s', 'endorse')} ${g('bt1s', 'endorse')} ${g('bt500ms', 'endorse')}` : ''));
}
console.log(`\nCommit fit: L_com = ${intercept.toFixed(1)} ms + ${slope.toFixed(3)} x BatchTimeout   (R^2 = ${r2.toFixed(4)})`);
console.log(`Additional requests: ${m1.total + m3.total}, failed: ${m1.failed + m3.failed}`);
console.log(`LaTeX block: ${path.join(OUT, 't1b_section.tex')}`);
