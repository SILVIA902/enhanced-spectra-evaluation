'use strict';

const fs = require('fs');
const path = require('path');

const CONFIGS = process.argv.slice(2).length ? process.argv.slice(2) : ['main'];
const CONFIG = CONFIGS[0];
const ROOT = path.join(__dirname, '..', 'results', 'T5');
const BASE = path.join(ROOT, CONFIG);
const OUT = path.join(BASE, 'analysis');
for (const c of CONFIGS) if (!fs.existsSync(path.join(ROOT, c, 'run_info.json'))) { console.error(`run_info.json not found in ${path.join(ROOT, c)}`); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const info = JSON.parse(fs.readFileSync(path.join(BASE, 'run_info.json'), 'utf8'));
const extraInfo = CONFIGS.slice(1).map(c => ({ cfg: c, ...JSON.parse(fs.readFileSync(path.join(ROOT, c, 'run_info.json'), 'utf8')) }));

const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const fs1 = v => (Number.isFinite(v) ? (v / 1000).toFixed(1) : '--');
const EXPECTED = {
  F4p: 'writes interrupted until the peers re-establish their connection through the remaining network',
  F1: 'writes unavailable (endorsement policy requires both organisations); reads through the Farmers peer unaffected',
  F2: 'writes cannot be ordered; reads unaffected',
  F3: 'requests needing the killed chaincode container fail or are delayed until the peer relaunches it',
  F4: 'as F1, without stopping the peer process',
};
const LABEL = { F4p: 'Peer (Producers): one of two networks removed', F1: 'Peer (Producers) stopped', F2: 'Orderer stopped', F3: 'Chaincode container killed', F4: 'Peer (Producers) fully partitioned' };

const laterHasF4 = extraInfo.some(x => x.faults.includes('F4'));
const plan = [];
for (const f of info.faults) plan.push({ f: f === 'F4' && laterHasF4 ? 'F4p' : f, dir: path.join(BASE, f) });
for (const x of extraInfo) for (const f of x.faults) plan.push({ f, dir: path.join(ROOT, x.cfg, f) });
const rows = [];
for (const { f, dir } of plan) {
  if (!fs.existsSync(dir)) continue;
  const runDirs = fs.readdirSync(dir).filter(x => /^r\d+$/.test(x));
  const S = runDirs.map(r => JSON.parse(fs.readFileSync(path.join(dir, r, 'summary.json'), 'utf8')));

  const during = runDirs.map((r, i) => {
    const sm = S[i];
    const fault = Date.parse(sm.startedAt) + sm.faultRelMs, restore = Date.parse(sm.startedAt) + sm.restoreRelMs;
    const lines = fs.readFileSync(path.join(dir, r, 'requests.csv'), 'utf8').trim().split('\n');
    const head = lines[0].split(',');
    const ix = k => head.indexOf(k);
    const rows2 = lines.slice(1).map(l => l.split(','));
    const pick = (stream, from, to) => rows2.filter(v => v[ix('stream')] === stream && Number(v[ix('t0_epoch_ms')]) >= from && Number(v[ix('t0_epoch_ms')]) < to);
    const okW = v => v[ix('status')] === 'VALID', okR = v => v[ix('status')] === 'OK';
    const lat = v => Number(v[ix('l_e2e_ms')]);
    const base = pick('write', 0, fault).filter(okW).map(lat).sort((a, b) => a - b);
    const wD = pick('write', fault, restore), rD = pick('read', fault, restore);
    const wOk = wD.filter(okW).map(lat), rOk = rD.filter(okR).map(lat);
    return {
      baseP95: base.length ? base[Math.floor(0.95 * (base.length - 1))] : NaN,
      wSub: wD.length, wOk: wOk.length, wMax: wOk.length ? Math.max(...wOk) : NaN,
      rSub: rD.length, rOk: rOk.length, rMax: rOk.length ? Math.max(...rOk) : NaN,
    };
  });
  const agg = k => { const o = {}; for (const s of S) for (const [c, v] of Object.entries(s.failures[k])) o[c] = (o[c] || 0) + v; return o; };
  const top = o => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c, v]) => `${c} (${v})`).join(', ') || 'none';
  const rc = k => S.reduce((s, x) => s + x.reconciliation[k], 0);
  rows.push({
    f, label: LABEL[f], expected: EXPECTED[f], reps: S.length,
    wGap: mean(S.map(s => s.writeOutage.maxGapMs)), rGap: mean(S.map(s => s.readOutage.maxGapMs)),
    wRec: mean(S.map(s => s.writeRecoveryMs).filter(Number.isFinite)), rRec: mean(S.map(s => s.readRecoveryMs).filter(Number.isFinite)),
    wFail: agg('write'), rFail: agg('read'), wTop: top(agg('write')), rTop: top(agg('read')),
    writes: S.reduce((s, x) => s + x.writes, 0), reads: S.reduce((s, x) => s + x.reads, 0),
    validOnBoth: rc('validOnBoth'), validClient: rc('validClient'), mismatch: rc('mismatch'),
    unknownValid: rc('unknownResolvedValid'), unknownNot: rc('unknownNotCommitted'), unknownInvalid: rc('unknownResolvedInvalid'),
    lotsChecked: rc('lotsChecked'), lotsMissing: rc('lotsMissing'),
    consistent: S.filter(s => s.consistent).length,
    injectErrors: S.filter(s => s.faultError || s.restoreError).length,
    baseP95: mean(during.map(d => d.baseP95)),
    wDuringPct: 100 * during.reduce((a, d) => a + d.wOk, 0) / Math.max(1, during.reduce((a, d) => a + d.wSub, 0)),
    wDuringMax: (a => (a.length ? Math.max(...a) : NaN))(during.map(d => d.wMax).filter(Number.isFinite)),
    rDuringPct: 100 * during.reduce((a, d) => a + d.rOk, 0) / Math.max(1, during.reduce((a, d) => a + d.rSub, 0)),
    rDuringMax: (a => (a.length ? Math.max(...a) : NaN))(during.map(d => d.rMax).filter(Number.isFinite)),
    perRunWritePct: during.map(d => (d.wSub ? 100 * d.wOk / d.wSub : NaN)),
  });
}
fs.writeFileSync(path.join(OUT, 't5_summary.json'), JSON.stringify(rows, null, 2));

const hhmm = iso => new Date(iso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
const esc = s => s.replace(/_/g, '\\_');
const tot = k => rows.reduce((s, r) => s + r[k], 0);
const tex = String.raw`% Generated by analyze_t5.js - paste before \end{document}
\subsection{T5 -- Fault injection and recovery}
Executed on ${info.startedAt.slice(0, 10)} (${hhmm(info.startedAt)}--${hhmm(info.finishedAt)} CEST). Two concurrent open-loop
streams were submitted through the FarmersMSP gateway peer: \texttt{RegisterProduction} at ${info.wrate}\,TPS and
\texttt{VerifyByUID} at ${info.rrate}\,TPS (20\% of the maximum sustainable rates measured in T2). Each run consisted of
${info.baseline}\,s of normal operation, a ${info.fault}\,s fault window and ${info.observe}\,s of observation after
restoration; each fault was repeated ${info.reps} times.${extraInfo.length ? ` In the test-network each peer is attached to two
Docker networks; the first F4 series disconnected peer0.producers from only one of them (reported as F4p), and F4 was therefore
repeated disconnecting the peer from all its networks (${extraInfo.map(x => `${hhmm(x.startedAt)}--${hhmm(x.finishedAt)} CEST`).join(', ')}).` : ''} After each run, every submitted write was reconciled against the
ledger of both peers (\texttt{qscc GetTransactionByID}), every committed lot was read back from both peers, and the block
heights of the two peers were compared.

\begin{table}[H]
\centering\small
\caption{T5: availability and recovery under injected faults (mean over ${info.reps} runs). \emph{Gap}: longest interval
without a successful request in the run; \emph{Recovery}: time from restoration to the first successful request submitted
after it; \emph{OK in fault}: share of the requests submitted during the fault window that eventually
succeeded; \emph{Max lat.}: maximum end-to-end latency of the successful writes submitted during the fault window (baseline P95
before the fault: ${rows.map(r => `${r.f} ${fs1(r.baseP95)}\\,s`).join(', ')}); \emph{Consistent}: runs in which both peers converged to the same height, every client-confirmed write was
committed as valid on both peers, no failed endorsement was committed and every committed lot was readable on both
peers.}
\label{tab:t5}
\setlength{\tabcolsep}{4pt}
\begin{tabular}{lrrrrrrc}
\toprule
 & \multicolumn{4}{c}{State-changing} & \multicolumn{2}{c}{Read-only} & \\
\cmidrule(lr){2-5}\cmidrule(lr){6-7}
Fault & Gap & Recovery & OK in fault & Max lat. & Gap & OK in fault & Consistent \\
 & (s) & (s) & (\%) & (s) & (s) & (\%) & \\
\midrule
${rows.map(r => `${r.f}: ${r.label} & ${fs1(r.wGap)} & ${fs1(r.wRec)} & ${r.wDuringPct.toFixed(1)} & ${fs1(r.wDuringMax)} & ` +
  `${fs1(r.rGap)} & ${r.rDuringPct.toFixed(1)} & ${r.consistent}/${r.reps} \\\\`).join('\n')}
\bottomrule
\end{tabular}
\end{table}

\paragraph{Observations.}
\begin{itemize}
${rows.map(r => `  \\item \\textbf{${r.f} (${r.label.toLowerCase()}).} Expected: ${r.expected}. Observed: longest write gap
        ${fs1(r.wGap)}\\,s, writes recovered ${fs1(r.wRec)}\\,s after restoration (dominant write failures: \\texttt{${esc(r.wTop)}});
        longest read gap ${fs1(r.rGap)}\\,s (read failures: \\texttt{${esc(r.rTop)}}). Of the writes submitted during the fault
        window, ${r.wDuringPct.toFixed(1)}\\% eventually succeeded (per run: ${r.perRunWritePct.map(x => x.toFixed(0)).join(', ')}\\%), with a
        maximum latency of ${fs1(r.wDuringMax)}\\,s${r.wDuringPct > 5 ? ', i.e.\\ they were delayed until the component became available again rather than rejected' : ''}.`).join('\n')}
  \item \textbf{State after recovery.} In ${tot('consistent')} of ${tot('reps')} runs the ledger was consistent after recovery:
        ${tot('validOnBoth')} of ${tot('validClient')} client-confirmed writes were committed as valid on both peers,
        ${tot('unknownValid')} writes with an unknown client outcome were found committed and ${tot('unknownNot')} were not committed,
        ${tot('mismatch')} discrepancies were found, and ${tot('lotsMissing')} of ${tot('lotsChecked')} lot read-backs failed.${
        tot('mismatch') === 0 && tot('lotsMissing') === 0 ? ' No transaction was lost after confirmation, and no rejected transaction was committed.' : ''}
  \item \textbf{Scope.} With one peer per organisation, an endorsement policy requiring both organisations and a single-node
        ordering service, F1, F2 and F4 necessarily interrupt state-changing operations; the experiment characterises the
        availability and the recovery of the tested topology, not the fault tolerance of Fabric deployments with redundant
        peers or a multi-node Raft cluster.
\end{itemize}
`;
fs.writeFileSync(path.join(OUT, 't5_section.tex'), tex);

console.log(`\nT5 ${CONFIG}: ${rows.length} faults`);
for (const r of rows) {
  console.log(`${r.f} ${r.label}: write gap ${fs1(r.wGap)} s, recovery ${fs1(r.wRec)} s | read gap ${fs1(r.rGap)} s, ` +
    `recovery ${fs1(r.rRec)} s | consistent ${r.consistent}/${r.reps}${r.injectErrors ? ` | injection ERRORS: ${r.injectErrors}` : ''}`);
  console.log(`   writes submitted during the fault: successful ${r.wDuringPct.toFixed(1)}% (per run ${r.perRunWritePct.map(x => x.toFixed(0)).join('/')}%), ` +
    `max latency ${fs1(r.wDuringMax)} s (P95 before the fault ${fs1(r.baseP95)} s) | successful reads ${r.rDuringPct.toFixed(1)}%, max ${fs1(r.rDuringMax)} s`);
  console.log(`   write errors: ${r.wTop}; read errors: ${r.rTop}`);
  console.log(`   reconciliation: valid on both ${r.validOnBoth}/${r.validClient}, unknown outcome -> committed ${r.unknownValid}, ` +
    `not committed ${r.unknownNot}, invalid ${r.unknownInvalid}; mismatches ${r.mismatch}; missing lots ${r.lotsMissing}/${r.lotsChecked}`);
}
console.log(`\nLaTeX block: ${path.join(OUT, 't5_section.tex')}`);
