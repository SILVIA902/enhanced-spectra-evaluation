'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG = process.argv[2] || 'main';
const BASE = path.join(__dirname, '..', 'results', 'T8', CONFIG);
const OUT = path.join(BASE, 'analysis');
if (!fs.existsSync(path.join(BASE, 'measurements.csv'))) { console.error(`measurements.csv not found in ${BASE}`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const info = JSON.parse(fs.readFileSync(path.join(BASE, 'run_info.json'), 'utf8'));

const lines = fs.readFileSync(path.join(BASE, 'measurements.csv'), 'utf8').trim().split('\n');
const head = lines[0].split(',');
const all = lines.slice(1).map(l => { const v = l.split(','); const o = {}; head.forEach((k, i) => { o[k] = v[i]; }); return o; });
const ok = r => r.status === 'VALID' || r.status === 'OK';
const data = all.filter(r => Number(r.iter) > 0);
const failed = data.filter(r => !ok(r));
const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1)); };
const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '--');
const f2 = v => (Number.isFinite(v) ? v.toFixed(2) : '--');
function fit(pts) {
  const xm = mean(pts.map(p => p[0])), ym = mean(pts.map(p => p[1]));
  const sxx = pts.reduce((s, [x]) => s + (x - xm) ** 2, 0);
  const b = pts.reduce((s, [x, y]) => s + (x - xm) * (y - ym), 0) / sxx, a = ym - b * xm;
  const sst = pts.reduce((s, [, y]) => s + (y - ym) ** 2, 0), sse = pts.reduce((s, [x, y]) => s + (y - (a + b * x)) ** 2, 0);
  return { a, b, r2: sst ? 1 - sse / sst : 1 };
}
const pick = (part, param, stepRe, field) => data.filter(r => r.part === part && Number(r.param) === param && stepRe.test(r.step) && ok(r))
  .map(r => Number(r[field])).filter(Number.isFinite);

const A = info.parts.includes('A') ? info.fanin.map(n => ({
  n,
  trEnd: mean(pick('A', n, /^transformation$/, 'l_endorse_ms')), trEndSd: sd(pick('A', n, /^transformation$/, 'l_endorse_ms')),
  trE2e: mean(pick('A', n, /^transformation$/, 'l_e2e_ms')),
  pkEnd: mean(pick('A', n, /^package$/, 'l_endorse_ms')),
  biEnd: mean(pick('A', n, /^binding$/, 'l_endorse_ms')), biEndSd: sd(pick('A', n, /^binding$/, 'l_endorse_ms')),
  coEnd: mean(pick('A', n, /^consume$/, 'l_endorse_ms')),
  ver: mean(pick('A', n, /^verify$/, 'l_e2e_ms')), verSd: sd(pick('A', n, /^verify$/, 'l_e2e_ms')),
  certBytes: mean(pick('A', n, /^getcert$/, 'resp_bytes')),
  samples: pick('A', n, /^transformation$/, 'l_endorse_ms').length,
})) : [];

const B = info.parts.includes('B') ? info.depth.map(d => ({
  d,
  trEnd: mean(pick('B', d, /^transformation_/, 'l_endorse_ms')),
  lastTrEnd: mean(pick('B', d, new RegExp(`^transformation_${d}$`), 'l_endorse_ms')),
  biEnd: mean(pick('B', d, /^binding$/, 'l_endorse_ms')),
  coEnd: mean(pick('B', d, /^consume$/, 'l_endorse_ms')),
  ver: mean(pick('B', d, /^verify$/, 'l_e2e_ms')), verSd: sd(pick('B', d, /^verify$/, 'l_e2e_ms')),
  certBytes: mean(pick('B', d, /^getcert$/, 'resp_bytes')),
  chains: new Set(data.filter(r => r.part === 'B' && Number(r.param) === d && r.step === 'binding').map(r => r.iter)).size,
})) : [];

const ptsOf = (rows, x, y) => rows.filter(r => Number.isFinite(r[y])).map(r => [r[x], r[y]]);
const fA = A.length > 1 ? { tr: fit(ptsOf(A, 'n', 'trEnd')), bi: fit(ptsOf(A, 'n', 'biEnd')), ver: fit(ptsOf(A, 'n', 'ver')), cert: fit(ptsOf(A, 'n', 'certBytes')) } : null;
const fB = B.length > 1 ? { tr: fit(ptsOf(B, 'd', 'trEnd')), bi: fit(ptsOf(B, 'd', 'biEnd')), ver: fit(ptsOf(B, 'd', 'ver')), cert: fit(ptsOf(B, 'd', 'certBytes')) } : null;

fs.writeFileSync(path.join(OUT, 't8_summary.json'), JSON.stringify({ A, B, fitA: fA, fitB: fB, failed: failed.length,
  retries: info.retries }, null, 2));

const hhmm = iso => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
const totalTx = data.filter(r => r.op !== 'VerifyByUID' && r.op !== 'GetCert').length;
const coord = (rows, x, y) => rows.filter(r => Number.isFinite(r[y])).map(r => `(${r[x]},${r[y].toFixed(2)})`).join(' ');
const nMax = A.length ? Math.max(...A.map(r => r.n)) : 0, dMax = B.length ? Math.max(...B.map(r => r.d)) : 0;
const a1 = A.find(r => r.n === Math.min(...A.map(x => x.n))), aN = A.find(r => r.n === nMax);
const b1 = B.find(r => r.d === Math.min(...B.map(x => x.d))), bN = B.find(r => r.d === dMax);

const figure = String.raw`\begin{figure}[t]
\centering
${A.length ? String.raw`\begin{tikzpicture}
\begin{axis}[width=0.48\linewidth, height=4.8cm, xlabel={Input lots per transformation ($n$)}, ylabel={Latency (ms)},
  xmin=0, ymin=0, tick label style={font=\scriptsize}, label style={font=\footnotesize},
  legend style={font=\scriptsize, at={(0.02,0.98)}, anchor=north west, draw=none}, title={(a) Breadth}, title style={font=\footnotesize}]
\addplot+[mark=*] coordinates {${coord(A, 'n', 'trEnd')}};
\addlegendentry{Transformation $L^{\mathrm{end}}$}
\addplot+[mark=square*] coordinates {${coord(A, 'n', 'biEnd')}};
\addlegendentry{Binding $L^{\mathrm{end}}$}
\addplot+[mark=triangle*] coordinates {${coord(A, 'n', 'ver')}};
\addlegendentry{UID verification}
\end{axis}
\end{tikzpicture}` : ''}\hfill
${B.length ? String.raw`\begin{tikzpicture}
\begin{axis}[width=0.48\linewidth, height=4.8cm, xlabel={Successive transformations ($d$)}, ylabel={Latency (ms)},
  xmin=0, ymin=0, tick label style={font=\scriptsize}, label style={font=\footnotesize},
  legend style={font=\scriptsize, at={(0.02,0.98)}, anchor=north west, draw=none}, title={(b) Depth}, title style={font=\footnotesize}]
\addplot+[mark=*] coordinates {${coord(B, 'd', 'lastTrEnd')}};
\addlegendentry{Last transformation $L^{\mathrm{end}}$}
\addplot+[mark=square*] coordinates {${coord(B, 'd', 'biEnd')}};
\addlegendentry{Binding $L^{\mathrm{end}}$}
\addplot+[mark=triangle*] coordinates {${coord(B, 'd', 'ver')}};
\addlegendentry{UID verification}
\end{axis}
\end{tikzpicture}` : ''}
\caption{Cost as a function of supply-chain complexity (sequential submission, mean values): (a) one transformation with
$n$ input lots; (b) a chain of $d$ successive transformations before packaging and binding.}
\label{fig:eval-complexity}
\end{figure}`;

const paperText = String.raw`% Generated by analyze_t8.js - paragraph and figure for Section 5
\subsection{Effect of Supply-Chain Complexity}
\label{sec:eval-complexity}

To assess how the mechanisms scale with the structure of the supply chain, we measured, under sequential submission,
(a)~a transformation merging $n \in \{${info.fanin.join(', ')}\}$ input lots, followed by packaging, binding, verification and
consumption of the resulting certificate, and (b)~chains of $d \in \{${info.depth.join(', ')}\}$ successive transformations
before packaging (Figure~\ref{fig:eval-complexity}). ${A.length ? (fA.tr.b * nMax > 5 && fA.tr.r2 > 0.8
  ? `The cost of a transformation grows linearly with its number of inputs, by ${f2(fA.tr.b)}\\,ms of chaincode execution
per input lot ($R^2 = ${f2(fA.tr.r2)}$), from ${f1(a1.trEnd)}\\,ms for one lot to ${f1(aN.trEnd)}\\,ms for ${nMax}, since mass
balance and input consumption read and update every input.`
  : `The chaincode execution of a transformation did not grow appreciably with its number of inputs (${f1(a1.trEnd)}\\,ms for
one lot, ${f1(aN.trEnd)}\\,ms for ${nMax}).`) + ` The binding of the resulting certificate, which embeds the list of inputs,
took ${f1(a1.biEnd)}\\,ms for one input and ${f1(aN.biEnd)}\\,ms for ${nMax}, and UID verification ${f1(a1.ver)} and
${f1(aN.ver)}\\,ms respectively.` : ''}  ${B.length ? (Math.abs(fB.ver.b * dMax) < 3 && Math.abs(fB.bi.b * dMax) < 3
  ? `The depth of the chain had no measurable effect: with ${dMax} upstream transformations, binding took ${f1(bN.biEnd)}\\,ms
and verification ${f1(bN.ver)}\\,ms, against ${f1(b1.biEnd)} and ${f1(b1.ver)}\\,ms with a single one, because the
certificate commits to the hashes of its immediate inputs and transformation instead of re-traversing the lineage at
verification time.`
  : `With ${dMax} upstream transformations, binding took ${f1(bN.biEnd)}\\,ms and verification ${f1(bN.ver)}\\,ms, against
${f1(b1.biEnd)} and ${f1(b1.ver)}\\,ms with a single one.`) : ''} In all cases the end-to-end latency
remained dominated by block cutting.

${figure}
`;

const protoText = String.raw`% Generated by analyze_t8.js - paste before \end{document}
\subsection{T8 -- Effect of supply-chain complexity}
Executed on ${info.startedAt.slice(0, 10)} (${hhmm(info.startedAt)}--${hhmm(info.finishedAt)} CEST), sequential submission.
Part A: one EXTRACTION transformation with $n \in \{${info.fanin.join(', ')}\}$ input lots (${info.runs} runs $\times$ ${info.iters}
iterations, 1 warm-up iteration per run excluded), followed by packaging, binding, ${info.verify} UID verifications,
certificate query and consumption. Part B: chains of $d \in \{${info.depth.join(', ')}\}$ successive DRYING transformations
(${info.chains} chains per depth, 1 warm-up chain excluded), followed by the same steps. Input lots were prepared in parallel
and are not part of the measurements. ${totalTx} measured transactions; ${failed.length} failures;
${info.retries} retries of a measured step because the previous step had not yet been committed on the second peer.

${A.length ? String.raw`\begin{table}[H]
\centering\small
\caption{T8-A: chaincode execution ($L^{\mathrm{end}}$, mean $\pm$ SD, ms), UID verification latency and certificate size as
a function of the number of input lots.}
\label{tab:t8a}
\setlength{\tabcolsep}{3.5pt}
\begin{tabular}{rrrrrrr}
\toprule
$n$ & Samples & Transf. & Packaging & Binding & Verif. & Cert.\ (B) \\
\midrule
${A.map(r => `${r.n} & ${r.samples} & ${f1(r.trEnd)} $\\pm$ ${f1(r.trEndSd)} & ${f1(r.pkEnd)} & ${f1(r.biEnd)} $\\pm$ ${f1(r.biEndSd)} & ${f1(r.ver)} & ${r.certBytes.toFixed(0)} \\\\`).join('\n')}
\bottomrule
\end{tabular}
\end{table}` : ''}

${B.length ? String.raw`\begin{table}[H]
\centering\small
\caption{T8-B: chaincode execution ($L^{\mathrm{end}}$, ms) and UID verification latency as a function of the chain depth.}
\label{tab:t8b}
\setlength{\tabcolsep}{3.5pt}
\begin{tabular}{rrrrrrr}
\toprule
$d$ & Chains & Transf.\ (mean) & Last transf. & Binding & Verif. & Cert.\ (B) \\
\midrule
${B.map(r => `${r.d} & ${r.chains} & ${f1(r.trEnd)} & ${f1(r.lastTrEnd)} & ${f1(r.biEnd)} & ${f1(r.ver)} & ${r.certBytes.toFixed(0)} \\\\`).join('\n')}
\bottomrule
\end{tabular}
\end{table}` : ''}

${figure.replace('[t]', '[H]')}

\paragraph{Observations.}
\begin{itemize}
${fA ? `  \\item \\textbf{Breadth.} Linear fits: transformation ${f2(fA.tr.a)} + ${f2(fA.tr.b)}\\,$n$\\,ms ($R^2 = ${f2(fA.tr.r2)}$); binding
        ${f2(fA.bi.a)} + ${f2(fA.bi.b)}\\,$n$\\,ms ($R^2 = ${f2(fA.bi.r2)}$); verification ${f2(fA.ver.a)} + ${f2(fA.ver.b)}\\,$n$\\,ms
        ($R^2 = ${f2(fA.ver.r2)}$); certificate size ${fA.cert.a.toFixed(0)} + ${fA.cert.b.toFixed(1)}\\,$n$ bytes.` : ''}
${fB ? `  \\item \\textbf{Depth.} Slopes per additional upstream transformation: binding ${f2(fB.bi.b)}\\,ms, verification
        ${f2(fB.ver.b)}\\,ms, certificate size ${fB.cert.b.toFixed(1)} bytes; the verification cost does not depend on the depth of
        the chain because only the immediate transformation is hashed into the certificate.` : ''}
  \item \textbf{Scope.} Inputs within a transformation are processed by a single chaincode invocation, whose payload limit
        (16\,KB) and the implementation limit of 100 input lots bound the breadth that can be expressed in one transaction.
\end{itemize}
`;
fs.writeFileSync(path.join(OUT, 't8_section.tex'), protoText);
fs.writeFileSync(path.join(OUT, 't8_paper.tex'), paperText);

console.log(`\nT8 ${CONFIG}: ${totalTx} measured transactions, ${failed.length} failed, ${info.retries} retries`);
if (A.length) {
  console.log('\nA - breadth    n   samples  transf.end  pack.end  bind.end  cons.end  verify(ms)    certificate(B)');
  for (const r of A) console.log(`           ${String(r.n).padStart(5)} ${String(r.samples).padStart(9)} ${f1(r.trEnd).padStart(10)} ${f1(r.pkEnd).padStart(10)} ${f1(r.biEnd).padStart(9)} ${f1(r.coEnd).padStart(9)} ${f1(r.ver).padStart(13)} ${r.certBytes.toFixed(0).padStart(15)}`);
  console.log(`  transformation fit: ${f2(fA.tr.a)} + ${f2(fA.tr.b)} x n  (R2 ${f2(fA.tr.r2)}); binding: ${f2(fA.bi.a)} + ${f2(fA.bi.b)} x n (R2 ${f2(fA.bi.r2)}); verification: ${f2(fA.ver.a)} + ${f2(fA.ver.b)} x n`);
}
if (B.length) {
  console.log('\nB - depth      d   chains  transf.mean  last transf.   bind.end  cons.end  verify(ms)    certificate(B)');
  for (const r of B) console.log(`             ${String(r.d).padStart(5)} ${String(r.chains).padStart(7)} ${f1(r.trEnd).padStart(12)} ${f1(r.lastTrEnd).padStart(14)} ${f1(r.biEnd).padStart(9)} ${f1(r.coEnd).padStart(9)} ${f1(r.ver).padStart(13)} ${r.certBytes.toFixed(0).padStart(15)}`);
  console.log(`  slopes per upstream transformation: binding ${f2(fB.bi.b)} ms, verification ${f2(fB.ver.b)} ms, certificate ${fB.cert.b.toFixed(1)} B`);
}
console.log(`\nLaTeX blocks: ${path.join(OUT, 't8_section.tex')}  and  ${path.join(OUT, 't8_paper.tex')}`);
