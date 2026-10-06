# Spike: LLM latency by model and CRE simulation limits

Measured on 2026-10-06 with CRE CLI v1.37.0, `@chainlink/cre-sdk` 1.23.0 and Bun 1.4.2.
All prompts are synthetic. No real wallet data and no secrets are involved.

**Why this exists.** These numbers were collected independently of the `cre-scaffold` branch (I only saw
that branch afterwards). That branch chooses Confidential HTTP for the review call (README section 4.6
there), and the numbers are consistent with that choice. They can also help pick the two models (an open
question in section 8). Section 5 lists what is still unverified.

## 1. Summary

| Question | Answer |
|---|---|
| Can a plain `HTTPClient` call an LLM inside `cre workflow simulate`? | Yes, with `gpt-5.4-mini` (about 2 s per call). |
| How long can a plain HTTP call take? | **10 s.** A 12 s response fails with `context deadline exceeded`. Confidential HTTP shows 1m30s. |
| How big can a plain HTTP request body be? | **120,000 raw bytes.** About 100 KB passed; 126,340 bytes was rejected. |
| Does prompt size drive latency? | For `gpt-5.4-nano` and `gpt-5.4-mini` the observed ranges were similar at about 6k and 51k input tokens (two runs per size). For the luna models latency rose with the larger prompt, but output tokens rose too, so the two effects are not separated here. |
| What goes with latency? | Output tokens, which include reasoning: the slower models produced more of them. |
| Which models were under 10 s in these runs? | `gpt-5.4-nano`, `gpt-5.4-mini`, and `gpt-5.6-luna` with `reasoning_effort: low` (two runs per table cell in section 4; only `gpt-5.4-mini` was also tried through CRE). |

## 2. CRE simulation limits

The simulator prints its limits on every run:

```
HTTP: req=120kb resp=250kb timeout=10s | ConfHTTP: req=125kb resp=500kb timeout=1m30s |
Consensus obs=25kb | ChainWrite evm_report=50kb evm_gas=10000000 solana_report=265b solana_cu=300000 |
WASM binary=100mb compressed=20mb
```

### 2.1 Plain HTTP timeout (10 s)

A throwaway workflow called `HTTPClient.sendRequest` (GET) against a local server that sleeps before
answering (`127.0.0.1`, so the simulator can reach localhost).

| Server delay | Result |
|---|---|
| 3 s | OK |
| 9 s | OK |
| 12 s | Fails: `Get "...": context deadline exceeded` |
| 25 s | Fails: same error |

For the 12 s case the server's log shows it received the request and slept the full 12 s, so CRE gave up
first.

### 2.2 Plain HTTP request body (120,000 bytes)

An LLM POST built from 25 synthetic finalists, with a padded size target (the exact prompt length of the
first two rows was not recorded):

| Prompt target | Result |
|---|---|
| about 10 KB | OK |
| about 100 KB | OK |
| about 125 KB | Rejected before reaching OpenAI: `HTTP request body of 126340 bytes exceeds the simulation limit of 120000 bytes. This limit mirrors a production constraint.` |

The 100 KB prompt would be about 134 KB after base64, and it passed, so base64 inflation does not seem to
count. This is an inference from one set of runs. The `cre-scaffold` README quotes 125 KB for Confidential
HTTP, and its review spike fixture has 3 finalists, so a full 25-finalist prompt (about 100 KB) is untested
on that path.

## 3. LLM call inside the simulator (plain HTTP)

Workflow: cron trigger, `runtime.getSecret`, then `runInNodeMode` calling OpenAI Chat Completions with 25
synthetic finalists. The model returns one integer weight (0 to 3) per finalist, and the result goes through
`ConsensusAggregationByFields` with `median` per field.

| Prompt | Model | Result |
|---|---|---|
| about 10 KB | `gpt-5.4-mini` | OK, 12 finalists picked, LLM call about 2 s |
| about 100 KB | `gpt-5.4-mini` | OK, 11 finalists picked, LLM call about 2 s |

Secret wiring was checked with a fake key (OpenAI answered `HTTP 401`, so the request path works) and with the
environment variable missing (a clear error from the CLI).

The simulator appears to run a single node, so real multi-node disagreement was not exercised.

## 4. Model latency, direct API (not through CRE)

`POST /v1/chat/completions` with `response_format: json_object`, from a single client network. Synthetic prompt of 25
finalists: about 10 KB (about 6.3k input tokens) and about 100 KB (about 51k input tokens). Two runs per
cell. Every one of the 20 responses was valid JSON.

| Model | Setting | About 10 KB | About 100 KB | Output tokens |
|---|---|---|---|---|
| `gpt-5.4-nano` | default | 4.2 to 4.6 s | 3.4 to 4.6 s | 360 to 435 |
| `gpt-5.4-mini` | default | 3.1 to 3.5 s | 3.3 to 3.9 s | 282 to 348 |
| `gpt-5.6-luna` | default | 9.4 to 9.8 s | 10.3 to 12.6 s | 780 to 1,117 |
| `gpt-5.6-luna` | `reasoning_effort: low` | not run | 6.7 to 6.8 s | 496 to 608 |
| `gpt-6-luna` | default | 12.6 to 18.4 s | 20.7 to 22.4 s | 980 to 1,940 |
| `gpt-6-luna` | `reasoning_effort: low` | not run | 11.2 to 14.9 s | 728 to 876 |

Reading: for `gpt-5.4-nano` and `gpt-5.4-mini`, the observed ranges were similar at both prompt sizes (two
runs per size, so small differences cannot be resolved). For the luna models
latency and output tokens rose together with the larger prompt, so this data cannot say which one caused
the increase. Against the 10 s plain-HTTP limit in these runs: `gpt-6-luna` was over it in every run;
`gpt-5.6-luna` with the default setting stayed just under it with the ~10 KB prompt (9.4 to 9.8 s) and went over
it with the ~100 KB prompt, and with low effort it was under it (100 KB only). Confidential HTTP has a longer
configured timeout (1m30s in the simulator limits, 60 s in the review config), which would leave room for
the slower settings; that path was not measured here. Cost was not measured.

## 5. Caveats and open items

- Two runs per cell, so ranges are wide. Differences of a second or so are not meaningful.
- Synthetic data. Only JSON validity was checked. **Pick quality was not evaluated.**
- Section 4 is the direct API, not the enclave path. The roughly 8 s that the `cre-scaffold` README reports
  for `gpt-5-mini` with 3 finalists is not comparable (different model, schema and path).
- Not verified: a full-size (25 finalists, about 100 KB) prompt through Confidential HTTP; multi-node
  consensus (the simulator appears to run one node); whether the limits above are identical after deploy.
- With integer weights, a median across several nodes could return a fractional value. Round downstream if
  per-field consensus is ever used.

## 6. How to reproduce

1. Run `cre workflow simulate <workflow> --target staging-settings` and read the "Simulation limits" line.
2. Timeout probe: a plain `HTTPClient` GET against a local server with a configurable delay.
3. Body-size probe: raise the prompt size until the simulator rejects the request body.
4. Latency: time `POST /v1/chat/completions` with the same synthetic prompt for each model and setting.

The API key was read from the macOS Keychain and handed to the process through its environment. It was never
printed or committed.
