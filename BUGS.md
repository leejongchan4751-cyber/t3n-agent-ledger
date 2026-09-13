# Findings from building on the T3N ADK

Environment used for every item below:

| | |
|---|---|
| SDK | `@terminal3/t3n-sdk@5.2.0` |
| Node | v24.21.0 |
| OS | Windows 11 (26200) |
| Network | `testnet` |
| Date | 2026-09-13 |

Findings are ordered by impact. Each one lists how to reproduce it, what I
expected, what actually happened, and why it matters.

---

## 1. [Blocker] TEE contracts cannot be built — the WIT dependencies are not obtainable

**Reproduce**

1. Follow `/developers/adk/get-started/walkthrough/write-contract`.
2. The page specifies this layout and imports:

   ```
   wit/
     world.wit
     deps/          <- host interface packages
   ```
   ```wit
   import host:tenant/tenant-context@1.2.0;
   import host:interfaces/logging@2.2.0;
   import host:interfaces/kv-store@2.2.0;
   import host:interfaces/http@2.2.0;
   import host:interfaces/http-with-placeholders@2.2.0;
   ```
3. Try to obtain `wit/deps/`.

**Expected** — a documented source: a download link, a template repository, a
`npm`/`cargo` package, or a CLI scaffold command.

**Actual** — no source exists on any public path I could find:

| Path checked | Result |
|---|---|
| `/get-started/prerequisites/set-up-dev-env` | No mention of WIT deps, no template repo |
| `/walkthrough/write-contract` | Requires `wit/deps/`, never says where it comes from |
| `/walkthrough/build-contract` | Build command only |
| `github.com/terminal3` | "doesn't have any public repositories yet" |
| `github.com/Terminal-3/trinity` (from package metadata) | **404 — private** |
| `@terminal3/t3n-sdk@5.2.0` package contents | No `.wit` files (`dir /s /b node_modules\@terminal3 \| findstr /i wit` returns nothing) |

**Impact** — Steps 1–5 of the walkthrough (write → build → register → invoke →
test) cannot be completed by any external developer. `cargo build --target
wasm32-wasip2` fails at bindgen because the imported interface packages are
absent. This blocks the entire contract half of the ADK.

**Suggested fix** — publish the host WIT packages (a public repo, or ship them
inside the npm package), and add a `t3n contract init` scaffold command.

---

## 2. [High] Credits are consumed but the metering feed stays empty

**Reproduce**

```
t3n token balance --json --env testnet     # note "available"
t3n org create --name "AgentLedger" --env testnet
t3n agent create --org <org-did> --name "ledger-agent" --env testnet
t3n agent card-publish --owner <org-did> --agent <agent-did> --env testnet
t3n token usage --limit 20 --json --env testnet
```

**Expected** — `entries` contains one row per billable operation, and
`last_settled_seq_no` advances.

**Actual** — measured across a full session:

| Operation | `available` after | Delta (credits) |
|---|---:|---:|
| start | 20,000,000,000 | — |
| `org create` | 19,919,897,820 | −80.10 |
| `agent create` ×2 | 19,899,840,000 | −20.06 |
| `agent card-publish` ×1 | 19,769,570,000 | −130.27 |
| `agent card-publish` ×1 | 19,639,350,000 | −110.16 |

Total consumed: **~360 credits**. At every point:

```json
{ "entries": [], "balance": { "last_settled_seq_no": 0, ... } }
```

`entries` was empty on every call and `last_settled_seq_no` never left `0`.
`--after` and `--limit` made no difference.

**Impact** — spend cannot be attributed to an operation, an agent, or a time.
For an enterprise this is the difference between an auditable ledger and an
unexplained balance decline. It is also precisely the gap this project set out
to close, and the reason the tool falls back to differencing balances instead
of reading the feed.

**Note** — `org create` costing ~80 credits versus ~10 for `agent create` is a
8× difference that a tenant would reasonably want itemised.

---

## 3. [High] `agent card-publish` silently targets the caller's own DID when arguments are missing

**Reproduce**

```
t3n agent card-publish --owner
```

(`--owner` present, its value missing — easy to hit when a long command is
split across lines.)

**Expected** — reject with "missing value for --owner".

**Actual** — the CLI ignores the dangling flag and prompts:

```
Publish your own DID's card publicly at https://.../api/agent-card/your own DID on testnet? [y/N]
```

It switched the target to the caller's own DID without saying so. Answering `y`
attempts a **public** publication of a different subject than the one typed.

**Impact** — a malformed command can publish the wrong identity publicly.
Publication is a public, externally-visible action; argument parsing for it
should fail closed.

---

## 4. [High] An error message tells you to run a command that does not exist

**Reproduce** — trigger the error in finding #3:

```
error: RPC Error: AgentCardNotFound: no private card to publish;
write it with org-data-write at the canonical entry id first
```

**Expected** — guidance naming a real command.

**Actual** — `org-data-write` appears nowhere in `t3n --help`. The full command
surface is `token`, `did`, `org create|writers-*`, `agent create|registry|
set-card|create-card|card-set|card-get|card-publish|card-unpublish|host-card`,
`contract get`, `whoami`. The closest real command is `agent card-set --file`.

**Impact** — the recovery path is a dead end. A developer following the error
verbatim cannot proceed.

---

## 5. [Medium] `agent create` reports a hosted card that the publish path then cannot find

**Reproduce**

```
t3n agent create --org <org> --name ledger-agent --env testnet
# -> "private default card hosted (publish with: t3n agent card-publish ...)"
t3n agent card-publish --owner        # malformed, see #3
# -> AgentCardNotFound
```

**Actual** — with correct arguments `agent card-get` does return a valid card,
so the card exists. But because of #3 the failure surfaces as
`AgentCardNotFound`, which reads as "the card `agent create` promised was never
created". The two findings compound into a misleading diagnosis.

**Impact** — wasted debugging on a non-existent problem. Fixing #3 resolves
this.

---

## 6. [Medium] Package metadata points at URLs that 404

`node_modules/@terminal3/t3n-sdk/package.json`:

```json
"repository": { "url": "https://github.com/Terminal-3/trinity", ... },
"bugs":       { "url": "https://github.com/Terminal-3/trinity/issues" },
"homepage":   "https://github.com/Terminal-3/trinity/tree/main/client/t3n-sdk#readme"
```

All three return 404. **There is no working public channel to report any of the
issues in this document.** This one blocks the feedback loop itself.

---

## 7. [Medium] Environment naming is inconsistent across surfaces

- Quickstart doc: `setEnvironment("testnet")`
- Signup page (`terminal3.io`, where credits are claimed): `setEnvironment("sandbox")`
- CLI default: `T3N_ENV` defaults to `testnet`
- Package metadata: `supportedEnvironments: ["sandbox", "testnet", "production"]`

Credits were claimed on the `sandbox` page, yet `token balance` reports the same
20,000,000,000 on **both** `sandbox` and `testnet`, and `whoami` returns the same
DID on both. Whether these are one backend or two separately funded ones is not
documented.

**Impact** — a developer cannot tell which environment holds their credits, or
whether work done in one is visible in the other.

---

## 8. [Medium] `common-errors` contradicts the code examples

`/tips/common-errors` states:

> `TenantClient` construction requires passing `baseUrl: getNodeUrl()` explicitly.

No example in Quickstart or the walkthrough passes `baseUrl`. Following the
examples literally therefore produces a client the troubleshooting page says is
misconfigured. One of the two pages is wrong; a reader cannot tell which.

---

## 9. [Low] `agent registry --full` prints an Ethereum address as a decimal byte array

**Actual**

```
owner_eth_address  89,87,192,162,177,193,181,47,148,173,245,26,36,51,140,232,236,118,104,47
agent_uri
```

**Expected** — `0x5957c0a2b1c1b52f94adf51a24338ce8ec76682f`.

The value is correct but unusable for copy-paste or visual comparison against a
DID. `agent_uri` is also printed as an empty field with no explanation of
whether that is expected for an org-provisioned agent.

---

## 10. [Low] Documented pages with no content

`/developers/adk/use-cases/payroll-agent` is listed in `llms.txt` as a use-case
example but contains only a pointer to another page. A reader arriving from the
index finds nothing.

---

## What worked well

Not everything was friction, and the parts that worked are the reason this
project was finishable at all:

- **Self-service credit claim.** No approval queue. Key in hand in under a minute.
- **`--json` on every command.** This is what made an automated ledger possible
  without scraping human-readable output. It should be advertised more loudly.
- **Idempotent writes.** Re-running `org writers-add` returned "already writers
  on scope — nothing to do" instead of erroring or duplicating. Exactly right
  for scheduled automation.
- **Explicit publish confirmation.** `card-publish` prompts before making
  something public, and prints the resulting URL. Good default.
- **`common-errors` page.** Genuinely useful content — the quota, ACL and
  version-collision entries read like they came from real support tickets.
