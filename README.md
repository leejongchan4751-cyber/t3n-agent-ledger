# T3N Agent Ledger

An append-only audit ledger for organisations running agents on Terminal 3.

Built for the Superteam × Terminal 3 build challenge, September 2026.

---

## The problem

Agent payment and execution rails shipped before agent *accounting* did. An
organisation can now provision agents, delegate scoped authority to them, and
let them spend — but it has no standing answer to the questions an auditor
asks first:

- How much did we spend since the last check, and on what?
- Who currently holds write access to which scope, and when did that change?
- Is anything drifting toward a budget ceiling before it hits one?

These are not exotic requirements. They are the baseline for putting an
autonomous actor in front of a company's money. The rails work well enough that
it is easy to ship without the ledger — which is exactly when it starts to
matter.

T3N already exposes the raw material: balances, a metering feed, scope writer
lists, and agent registry records. What was missing was something that reads
them on a schedule, keeps an immutable trail, and says something useful when a
number moves.

## What this does

One command, run on a timer:

1. **Collects** balance, metering feed, scope writers, and registry records for
   every watched agent.
2. **Compares** against the last *successfully collected* value for each item.
3. **Reports** spend, budget burn, authority changes, and new activity.
4. **Appends** the whole snapshot to `data/ledger.jsonl`. Records are never
   rewritten — that is the point of a ledger.
5. **Exits non-zero** when a budget threshold is breached, so a scheduler or CI
   job can escalate without parsing output.

### Reconciliation check

The ledger cross-checks two independent sources: the balance, and the metering
feed that is supposed to explain it. When the balance drops and the feed has no
matching rows, it says so:

```
[이번 주기 발견]
  [! ] 지출 110.16 크레딧이 발생했으나 미터링 피드에 대응 항목이 없습니다 — 비용 귀속 불가
  [  ] 이번 주기 지출 110.16 크레딧
```

> Spend of 110.16 credits occurred, but the metering feed has no corresponding
> entry — cost cannot be attributed.

This fired on the very first real run. See [BUGS.md](./BUGS.md) finding #2: the
feed returned `entries: []` while ~360 credits were consumed over a session. A
ledger that only trusted one source would have reported nothing wrong.

## Install

Requires Node 18+. No other dependencies.

```bash
npm install @terminal3/t3n-sdk@5.2.0
```

Set your key and edit `ledger.config.json`:

```bash
set T3N_API_KEY=0x...        # Windows
export T3N_API_KEY=0x...     # macOS / Linux
```

```json
{
  "env": "testnet",
  "ownerDid": "did:t3n:...",
  "orgDid": "did:t3n:...",
  "watchScopes": ["agent-cards"],
  "watchAgents": ["did:t3n:...", "did:t3n:..."],
  "budget": {
    "creditDecimals": 6,
    "initialCredits": 20000000000,
    "warnAtPercentSpent": 70,
    "alertAtPercentSpent": 90
  }
}
```

## Use

```bash
node ledger.js            # collect once — run this on a schedule
node ledger.js --report   # print the last summary without collecting
node ledger.js --doctor   # check environment and CLI reachability
```

Exit codes: `0` normal, `2` budget alert threshold breached.

Schedule it hourly with cron or Windows Task Scheduler. Nothing else to run.

## Design notes

The challenge asked for something useful **and easy to maintain after the
challenge ends**. Four decisions follow from that second half.

**No dependencies.** Node standard library plus the official T3N CLI. Nothing
to audit, nothing that breaks on a transitive upgrade, no supply chain beyond
the SDK itself.

**No external services.** The tool calls T3N and writes local files. There is no
third-party API whose outage or pricing change becomes your problem. An agent
that depends on someone else's uptime is an agent someone has to babysit.

**Invoked via `node` directly, not `npx`.** The CLI entry point
(`dist/cli/index.js`) is called with `process.execPath`. This avoids the
per-call package resolution cost, and sidesteps two platform problems: Node 24's
`DEP0190` warning when passing arguments through a shell, and `EINVAL` when
spawning a `.cmd` on Windows without one. Both were hit during development.

**Missing data is not a change.** Every comparison is made against the last
*successful* collection of that specific item, not the last run. An early build
reported "scope writers changed" when a collection had merely failed, and
silently missed a 130-credit spend for the same reason. For an audit tool this
class of bug is disqualifying: absence and mutation must never be conflated. The
state file now tracks per-item last-known-good values, and a failed collection
is reported as a collection failure rather than laundered into a finding.

**Partial failure degrades, it does not abort.** If the scope query fails but
the balance succeeds, the balance is still recorded and the failure is logged as
its own finding. An audit tool that stops at the first error leaves the biggest
gaps exactly when things are going wrong.

## Verified run

Against a live `testnet` tenant on 2026-09-13:

| Step | Result |
|---|---|
| Organisation created | `did:t3n:434282fc...c9ea` |
| Agents provisioned | 2, org-owned |
| Agent cards published | 2, publicly resolvable |
| Ledger collections | 5 |
| Spend detected | 110.16 credits, correctly attributed to the publish operation |
| Reconciliation gap detected | Yes — metering feed empty despite spend |
| False positives after fix | 0 |

Published agent cards:

- https://cn-api.sg.testnet.t3n.terminal3.io/api/agent-card/did:t3n:5957c0a2b1c1b52f94adf51a24338ce8ec76682f
- https://cn-api.sg.testnet.t3n.terminal3.io/api/agent-card/did:t3n:7faab43505230f804071b6f271580b7d648056d4

## Findings

Ten issues encountered while building, with reproduction steps and measured
figures: [BUGS.md](./BUGS.md). One is a blocker (TEE contracts cannot be built
because the WIT dependencies are not published anywhere public), two are high
severity, and one of those breaks the feedback loop itself — the package's own
`bugs` URL is a 404.

## Files

```
ledger.js            the tool — single file, no dependencies
ledger.config.json   configuration (contains DIDs only, no secrets)
BUGS.md              findings from the build
go.bat / go2.bat     reproducible verification runs used for the screenshots
data/ledger.jsonl    append-only audit trail
data/state.json      per-item last-known-good values
LEDGER_REPORT.txt    latest human-readable summary
```

## Licence

MIT.
