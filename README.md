# Enhanced SPECTRA: performance evaluation artifacts

This repository contains the chaincode, network configuration, workload generator, raw measurements and analysis
scripts used for the experimental evaluation of **Enhanced SPECTRA**, a privacy-preserving agri-food traceability
framework on Hyperledger Fabric. It allows the experiments to be re-executed and the tables and figures of the
evaluation to be regenerated from the raw data.

The complete experimental protocol (design of each test, metrics, saturation criterion, statistics and detailed
results) is in [`docs/campaign_protocol.pdf`](docs/campaign_protocol.pdf).

## Contents

| Folder | Content |
|---|---|
| `chaincode/certificate` | Enhanced SPECTRA chaincode (JavaScript) and the definition of the private data collection `uidPdc` |
| `chaincode/userauth` | Governance chaincode (registration, roles, approval, authorization checks) |
| `network/test-network` | Fabric test-network adapted to two organisations (FarmersMSP, ProducersMSP), channel `milkchannel` |
| `network/reset_network.sh` | Creates the network, deploys both chaincodes and initialises the ledger and the UID pepper |
| `network/setup_identities.sh` | Registers and approves the benchmark identities and writes `identities.json` |
| `network/set_batch_timeout.sh` | Changes the orderer `BatchTimeout` through a channel configuration update (test T1-b) |
| `harness` | Workload generator (Fabric Gateway SDK) for tests T1–T5 and T8, resource and storage monitors |
| `analysis` | Scripts that compute the statistics, tables and figures from the raw data |
| `results` | Raw measurements of all tests (CSV and JSON) and console logs of each execution |
| `docs` | Experimental protocol |

Chaincode files (SHA-256):

```
074629aaa06faee0a0ad63245586f48f926a6d3894119759645d54e9b1489b16  chaincode/certificate/certificate.js
9a364c0204786c3dcace7136d98da9fd42a2476c4b915b2701a3833bb9362726  chaincode/userauth/userauth.js
```

## Software versions

| Component | Version |
|---|---|
| Hyperledger Fabric (peer, orderer, binaries) | 2.5.10 |
| Hyperledger Fabric CA | 1.5.22 |
| Node.js | 22.20.0 |
| Fabric Gateway SDK (`@hyperledger/fabric-gateway`) | 1.7 (exact versions in `harness/package-lock.json`) |
| Docker Engine with Docker Compose | — |
| jq | — |

The measurements were collected on a single host (Linux on WSL2); see Section 5 of the paper and Section 2 of the
protocol for the hardware and the network configuration (one peer per organisation, one Raft orderer, LevelDB, TLS,
endorsement policy requiring both organisations, `BatchTimeout` = 2 s, `MaxMessageCount` = 10).

## Setup

**1. Install Fabric 2.5.10 and Fabric CA 1.5.22** (samples, binaries and Docker images):

```bash
cd ~
curl -sSLO https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh
chmod +x install-fabric.sh
./install-fabric.sh --fabric-version 2.5.10 --ca-version 1.5.22 docker binary samples
```

The `fabric-samples` repository has no `v2.5.10` tag, so the script clones its main branch; this is expected, since
the test-network files used here are replaced in step 2 and the binaries and Docker images are those of 2.5.10.
The setup below was verified on a freshly installed `fabric-samples` before publication.

**2. Copy the network configuration and the chaincode into `fabric-samples`.** The scripts assume
`~/fabric-samples`; set `FABRIC_SAMPLES` to use a different location.

```bash
export FABRIC_SAMPLES=~/fabric-samples
cd enhanced-spectra-evaluation
cp -r network/test-network/. "$FABRIC_SAMPLES/test-network/"
mkdir -p "$FABRIC_SAMPLES/chaincode/spectra"
cp -r chaincode/certificate chaincode/userauth "$FABRIC_SAMPLES/chaincode/spectra/"
```

**3. Create the network and deploy the chaincode.** The script brings down any running test-network, creates the
channel, deploys `certificate` (with `uidPdc`) and `userauth`, initialises the governance ledger and sets a random
32-byte UID pepper, which is stored only in the private data collection.

```bash
./network/reset_network.sh
```

**4. Create the benchmark identities** (`bench-farmer`, `bench-producer`, `bench-consumer`). The script writes
`identities.json` in the repository root (format: `identities.example.json`).

```bash
./network/setup_identities.sh
```

`identities.json` contains the paths of the private keys of the generated identities and must not be published.

**5. Install the workload generator and run the functional pilot**, which executes a complete workflow
(production, transformation, packaging, binding, verification, consumption and repeated scan) and checks every
result:

```bash
cd harness
npm ci
node pilot.js
```

## Running the experiments

All commands are run from `harness/`. Each test writes into `results/<test>/<configuration>/`. The parameters
below are those used for the results in `results/`; the console output of each execution is in `results/*.log`.

| Test | Purpose | Command |
|---|---|---|
| T1 | Per-operation latency and its decomposition (sequential) | `./run_t1.sh 5 60 3 bt2s` |
| T1-b | Effect of `BatchTimeout` | `../network/set_batch_timeout.sh 1s && ./run_t1.sh 5 30 2 bt1s`<br>`../network/set_batch_timeout.sh 500ms && ./run_t1.sh 5 30 2 bt500ms`<br>`../network/set_batch_timeout.sh 2s` |
| T2 | Offered load, saturation, storage growth | `node t2.js --rates 10,20,40,80,160,320,640,1280 --config main` |
| T2 (refinement) | Intermediate rates on a re-created network | `node t2.js --workloads write --rates 160,200,240 --p95base write=946.3 --config refine_write`<br>`node t2.js --workloads read --rates 320,360,400 --p95base read=18.4 --config refine_read2` |
| T3 | Concurrent conflicting operations (security invariants) | `node t3.js --config main` |
| T4 | Transactional bursts and Poisson arrivals | `node t4.js --poisson 80,128 --config main` |
| T5 | Fault injection and recovery (peer, orderer, chaincode container, network partition) | `node t5.js --config main`<br>`node t5.js --faults F4 --config f4full` |
| T8 | Effect of supply-chain complexity (fan-in and chain depth) | `node t8.js --config main` |

Notes:

- T5 stops, kills and disconnects Docker containers of the test-network (`peer0.producers.example.com`,
  `orderer.example.com`, the chaincode container); it must be run on a host dedicated to the experiment.
- T2 and T4 drive the network to saturation; run them on an otherwise idle host. Absolute values depend on the
  hardware; the evaluation reports the mean of run-level means with 95% confidence intervals across runs.
- Options of each script (defaults in brackets):

```
run_t1.sh [runs=5] [iterations=60] [warm-up=3] [config=bt2s]
t2.js  [--workloads write,read] [--rates 10,20,40,80,160,320,640] [--warm 15] [--measure 30] [--drain 30]
       [--reps 3] [--clients 32] [--p95base write=<ms>,read=<ms>] [--config main]
t3.js  [--reps 3] [--targets 10] [--ks 2,5,10,20] [--subtests a,b1,b2,c] [--prep 20] [--config main]
t4.js  --poisson <rates> [--profiles A,B,C] [--reps 5] [--bursts 10,50,100,200] [--pb-size 50] [--pb-period 5]
       [--pb-duration 60] [--pc-duration 60] [--seed 20261021] [--gap 10] [--clients 32] [--config main]
t5.js  [--faults F1,F2,F3,F4] [--reps 3] [--wrate 32] [--rrate 64] [--baseline 60] [--fault 30] [--observe 90]
       [--config main]
t8.js  [--parts A,B] [--fanin 1,5,10,25,50,100] [--depth 1,5,10,20] [--runs 3] [--iters 8] [--chains 5]
       [--verify 5] [--config main]
```

  T3 subtests: `a` concurrent consumption of the same UID; `b1` same UID bound to different packages; `b2` different
  UIDs bound to the same package; `c` concurrent transformations of the same input lot. T5 faults: `F1` stop/start
  of `peer0.producers`, `F2` stop/start of the orderer, `F3` kill of the chaincode container, `F4` disconnection of
  `peer0.producers` from its Docker networks.

## Regenerating the results

The analysis scripts read the raw data in `results/` and write the summaries, LaTeX tables and figures in an
`analysis` subfolder of each test. They require only Node.js.

```bash
cd analysis
node analyze_t1.js bt2s
node analyze_t1b.js
node analyze_t2.js main refine_write refine_read2
node analyze_t3.js main
node analyze_t4.js main
node analyze_t5.js main f4full
node analyze_t8.js main
```

## Raw data

`results/<test>/<configuration>/` contains, for every request, the timestamps of the client-side phases (proposal
creation, endorsement, submission, commit status), the transaction ID, the block number, the validation code and the
failure class, together with the per-test summaries, the container resource samples, the ledger storage snapshots and
the run parameters. The console output of each execution is in `results/*.log`. The scripts in `analysis/` read these files
directly.

## Security note

The repository contains no keys or certificates: all cryptographic material is generated locally by the
test-network. The UID pepper is generated randomly by `reset_network.sh` at every network creation and is never
written to disk outside the private data collection.

## License

Apache License 2.0. The files under `network/test-network` derive from the Hyperledger Fabric samples and retain
their original license headers.
