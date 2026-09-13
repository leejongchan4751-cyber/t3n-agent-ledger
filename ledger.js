#!/usr/bin/env node
/**
 * T3N Agent Ledger — 에이전트 활동·지출 감사 대장
 *
 * 왜 필요한가
 *   에이전트 결제·실행 규격은 갖춰졌지만, 조직이 "누가 어떤 권한으로
 *   무엇을 했고 얼마를 썼는지"를 사후가 아니라 상시로 들여다볼 대장이 없다.
 *   이 도구는 T3N이 이미 제공하는 소비 피드와 권한 조회를 주기적으로 읽어
 *   추가 전용(append-only) 대장에 쌓고, 예산 소진과 권한 변경을 조기에 알린다.
 *
 * 설계 원칙
 *   1. 외부 의존성 0 — Node 표준 라이브러리와 T3N 공식 CLI만 사용
 *   2. 추가 전용 — 기록을 고치지 않는다. 감사의 전제다
 *   3. 실패해도 멈추지 않음 — 일부 수집이 실패해도 나머지는 기록한다
 *   4. 설정은 한 곳 — ledger.config.json
 *
 * 사용법
 *   node ledger.js            수집 1회 실행 (스케줄러로 반복)
 *   node ledger.js --report   마지막 상태 요약만 출력
 *   node ledger.js --doctor   환경 자체 진단
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(HERE, "ledger.config.json");
const DATA_DIR = path.join(HERE, "data");
const LEDGER_PATH = path.join(DATA_DIR, "ledger.jsonl");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const REPORT_PATH = path.join(HERE, "LEDGER_REPORT.txt");

// CLI 진입점을 node 로 직접 실행한다.
//   - npx 를 거치지 않으므로 매 호출마다 패키지를 확인하는 비용이 없다
//   - 셸을 쓰지 않으므로 Node 24의 DEP0190 경고가 나지 않고,
//     Windows에서 .cmd 를 셸 없이 spawn 할 때 나는 EINVAL 도 피한다
const CLI_ENTRY = path.join(
  HERE,
  "node_modules",
  "@terminal3",
  "t3n-sdk",
  "dist",
  "cli",
  "index.js"
);

// ------------------------------------------------------------------ 유틸

function nowIso() {
  return new Date().toISOString();
}

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

/** 크레딧 원시값을 사람이 읽는 단위로 변환 */
function toCredits(raw, decimals) {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return n / Math.pow(10, decimals);
}

function fmt(n) {
  if (n === null || n === undefined) return "?";
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// ------------------------------------------------------------------ CLI 호출

/**
 * T3N CLI를 호출해 JSON을 돌려준다.
 * 실패하면 throw 하지 않고 { ok:false, error } 를 돌려준다 —
 * 한 항목이 실패해도 나머지 수집은 계속돼야 하기 때문이다.
 */
function t3n(args, env) {
  if (!fs.existsSync(CLI_ENTRY)) {
    return {
      ok: false,
      error:
        `T3N CLI를 찾을 수 없습니다: ${CLI_ENTRY}\n` +
        `  이 폴더에서 다음을 실행하십시오: npm install @terminal3/t3n-sdk@5.2.0`,
      command: args.join(" "),
    };
  }
  const full = [CLI_ENTRY, ...args, "--env", env, "--json"];
  try {
    const out = execFileSync(process.execPath, full, {
      encoding: "utf8",
      timeout: 90_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const text = String(out).trim();
    if (!text) return { ok: true, data: null };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      // --json 을 지원하지 않는 명령은 평문을 돌려준다
      return { ok: true, data: { _raw: text } };
    }
  } catch (e) {
    const stderr = (e.stderr && String(e.stderr).trim()) || "";
    const stdout = (e.stdout && String(e.stdout).trim()) || "";
    return {
      ok: false,
      error: stderr || stdout || e.message || "unknown error",
      command: args.join(" "),
    };
  }
}

// ------------------------------------------------------------------ 수집

function collect(cfg) {
  const env = cfg.env || "testnet";
  const snapshot = {
    at: nowIso(),
    env,
    ownerDid: cfg.ownerDid || null,
    orgDid: cfg.orgDid || null,
    balance: null,
    usageEntries: [],
    lastSeq: null,
    scopeWriters: {},
    agents: {},
    errors: [],
  };

  // 1) 잔액
  const bal = t3n(["token", "balance"], env);
  if (bal.ok && bal.data) {
    snapshot.balance = bal.data;
    snapshot.lastSeq = bal.data.last_settled_seq_no ?? null;
  } else if (!bal.ok) {
    snapshot.errors.push({ step: "token balance", error: bal.error });
  }

  // 2) 소비 피드 — 지난번 이후 것만
  const prevSeq = readJson(STATE_PATH, {}).lastSeq;
  const usageArgs = ["token", "usage", "--limit", "100"];
  if (prevSeq !== undefined && prevSeq !== null) {
    usageArgs.push("--after", String(prevSeq));
  }
  const usage = t3n(usageArgs, env);
  if (usage.ok && usage.data) {
    const entries = Array.isArray(usage.data)
      ? usage.data
      : usage.data.entries || [];
    snapshot.usageEntries = entries;
    if (usage.data.balance && !snapshot.balance) {
      snapshot.balance = usage.data.balance;
    }
  } else if (!usage.ok) {
    snapshot.errors.push({ step: "token usage", error: usage.error });
  }

  // 3) 권한 스코프 — 누가 쓸 수 있는가
  if (cfg.orgDid) {
    for (const scope of cfg.watchScopes || []) {
      const w = t3n(
        ["org", "writers-get", "--org", cfg.orgDid, "--scope", scope],
        env
      );
      if (w.ok) {
        snapshot.scopeWriters[scope] = w.data;
      } else {
        snapshot.errors.push({ step: `writers-get ${scope}`, error: w.error });
      }
    }
  }

  // 4) 감시 대상 에이전트 기록
  for (const did of cfg.watchAgents || []) {
    const a = t3n(["agent", "registry", did, "--full"], env);
    if (a.ok) {
      snapshot.agents[did] = a.data;
    } else {
      snapshot.errors.push({ step: `agent registry ${did}`, error: a.error });
    }
  }

  return snapshot;
}

// ------------------------------------------------------------------ 변화 감지

function detectChanges(prev, curr, cfg) {
  const findings = [];
  const d = cfg.budget?.creditDecimals ?? 6;

  // 잔액 변화 = 지출
  const prevAvail = prev?.balance?.available;
  const currAvail = curr?.balance?.available;
  if (prevAvail !== undefined && currAvail !== undefined && prevAvail !== null) {
    const spentRaw = Number(prevAvail) - Number(currAvail);
    if (spentRaw > 0) {
      findings.push({
        kind: "spend",
        severity: "info",
        message: `이번 주기 지출 ${fmt(toCredits(spentRaw, d))} 크레딧`,
        raw: spentRaw,
      });

      // 대조 검증: 잔액은 줄었는데 미터링 피드에 대응 항목이 없으면
      // 그 지출은 어디에 쓰였는지 귀속시킬 수 없다. 감사상 결함이므로 경고한다.
      if ((curr.usageEntries?.length ?? 0) === 0) {
        findings.push({
          kind: "reconciliation",
          severity: "warn",
          message:
            `지출 ${fmt(toCredits(spentRaw, d))} 크레딧이 발생했으나 ` +
            `미터링 피드에 대응 항목이 없습니다 — 비용 귀속 불가`,
          spentRaw,
          feedEntries: 0,
        });
      }
    }
  }

  // 예산 소진율
  const baseline = prev?.budgetBaseline ?? curr?.balance?.available;
  if (baseline && curr?.balance?.available !== undefined) {
    const used = Number(baseline) - Number(curr.balance.available);
    const pct = (used / Number(baseline)) * 100;
    const warn = cfg.budget?.warnAtPercentSpent ?? 70;
    const alert = cfg.budget?.alertAtPercentSpent ?? 90;
    if (pct >= alert) {
      findings.push({
        kind: "budget",
        severity: "alert",
        message: `예산 ${pct.toFixed(1)}% 소진 — 임계 ${alert}% 초과`,
      });
    } else if (pct >= warn) {
      findings.push({
        kind: "budget",
        severity: "warn",
        message: `예산 ${pct.toFixed(1)}% 소진 — 경고선 ${warn}% 초과`,
      });
    }
  }

  // 크레딧 고갈 플래그
  if (curr?.balance?.credit_exhausted === true) {
    findings.push({
      kind: "budget",
      severity: "alert",
      message: "크레딧 소진됨 — 이후 작업이 거부됩니다",
    });
  }

  // 권한 변경
  // 양쪽 모두 실제로 수집에 성공했을 때만 비교한다.
  // 수집 실패로 비어 있는 값을 "변경"으로 읽으면 허위 경보가 된다.
  const prevScopes = prev?.scopeWriters || {};
  const currScopes = curr?.scopeWriters || {};
  const prevHas = Object.keys(prevScopes).length > 0;
  const currHas = Object.keys(currScopes).length > 0;
  if (prevHas && currHas) {
    if (JSON.stringify(prevScopes) !== JSON.stringify(currScopes)) {
      findings.push({
        kind: "authority",
        severity: "warn",
        message: "스코프 쓰기 권한자 목록이 변경되었습니다",
        before: prevScopes,
        after: currScopes,
      });
    }
  } else if (prevHas && !currHas) {
    findings.push({
      kind: "collection",
      severity: "warn",
      message: "권한 목록을 이번 주기에 수집하지 못했습니다 — 변경 여부 판정 불가",
    });
  }

  // 신규 활동
  if (curr.usageEntries?.length) {
    findings.push({
      kind: "activity",
      severity: "info",
      message: `신규 소비 항목 ${curr.usageEntries.length}건`,
    });
  }

  // 수집 실패
  for (const e of curr.errors || []) {
    findings.push({
      kind: "collection",
      severity: "warn",
      message: `수집 실패 [${e.step}] ${String(e.error).slice(0, 200)}`,
    });
  }

  return findings;
}

// ------------------------------------------------------------------ 리포트

function renderReport(snapshot, findings, cfg) {
  const d = cfg.budget?.creditDecimals ?? 6;
  const L = [];
  L.push("=".repeat(64));
  L.push("T3N AGENT LEDGER — 감사 요약");
  L.push("=".repeat(64));
  L.push(`수집 시각   : ${snapshot.at}`);
  L.push(`환경        : ${snapshot.env}`);
  L.push(`소유자 DID  : ${snapshot.ownerDid || "-"}`);
  L.push(`조직 DID    : ${snapshot.orgDid || "-"}`);
  L.push("");

  if (snapshot.balance) {
    const b = snapshot.balance;
    L.push("[잔액]");
    L.push(`  사용 가능 : ${fmt(toCredits(b.available, d))} 크레딧`);
    L.push(`  예약됨    : ${fmt(toCredits(b.reserved, d))}`);
    L.push(`  저장 보증 : ${fmt(toCredits(b.storage_deposit, d))}`);
    L.push(`  소진 여부 : ${b.credit_exhausted ? "예" : "아니오"}`);
    L.push(`  정산 시퀀스: ${b.last_settled_seq_no}`);
    L.push("");
  }

  const scopes = Object.keys(snapshot.scopeWriters || {});
  if (scopes.length) {
    L.push("[권한 스코프]");
    for (const s of scopes) {
      L.push(`  ${s}: ${JSON.stringify(snapshot.scopeWriters[s])}`);
    }
    L.push("");
  }

  L.push("[이번 주기 발견]");
  if (!findings.length) {
    L.push("  변화 없음");
  } else {
    const order = { alert: 0, warn: 1, info: 2 };
    for (const f of [...findings].sort((a, b) => order[a.severity] - order[b.severity])) {
      const tag =
        f.severity === "alert" ? "[!!]" : f.severity === "warn" ? "[! ]" : "[  ]";
      L.push(`  ${tag} ${f.message}`);
    }
  }
  L.push("");
  L.push("=".repeat(64));
  return L.join("\n");
}

// ------------------------------------------------------------------ 진단

function doctor(cfg) {
  const L = [];
  L.push("T3N Agent Ledger — 자체 진단");
  L.push("-".repeat(48));
  L.push(`Node 버전     : ${process.version}`);
  L.push(`플랫폼        : ${process.platform}`);
  L.push(`설정 파일     : ${fs.existsSync(CONFIG_PATH) ? "있음" : "없음"}`);
  L.push(`API 키 환경변수: ${process.env.T3N_API_KEY ? "설정됨" : "없음 ← 필요"}`);
  L.push(`CLI 진입점    : ${fs.existsSync(CLI_ENTRY) ? "있음" : "없음 ← npm install 필요"}`);
  L.push(`환경          : ${cfg.env}`);
  L.push(`대장 파일     : ${fs.existsSync(LEDGER_PATH) ? "있음" : "아직 없음"}`);

  const probe = t3n(["whoami"], cfg.env || "testnet");
  if (probe.ok) {
    const did = probe.data?._raw || probe.data?.did || JSON.stringify(probe.data);
    L.push(`CLI 응답      : 정상 (${String(did).trim()})`);
  } else {
    L.push(`CLI 응답      : 실패 — ${String(probe.error).slice(0, 300)}`);
  }
  return L.join("\n");
}

// ------------------------------------------------------------------ 메인

function main() {
  ensureDirs();
  const cfg = readJson(CONFIG_PATH, null);
  if (!cfg) {
    console.error(`설정 파일을 읽을 수 없습니다: ${CONFIG_PATH}`);
    process.exit(1);
  }

  const arg = process.argv[2];

  if (arg === "--doctor") {
    console.log(doctor(cfg));
    return;
  }

  if (arg === "--report") {
    const state = readJson(STATE_PATH, null);
    if (!state?.last) {
      console.log("아직 수집 기록이 없습니다. 먼저 `node ledger.js` 를 실행하십시오.");
      return;
    }
    console.log(renderReport(state.last, state.lastFindings || [], cfg));
    return;
  }

  if (!process.env.T3N_API_KEY) {
    console.error("T3N_API_KEY 환경변수가 없습니다.");
    console.error('  set T3N_API_KEY=0x...   (Windows)');
    process.exit(1);
  }

  const state = readJson(STATE_PATH, {
    runs: 0,
    lastSeq: null,
    last: null,
    budgetBaseline: null,
    good: {},
  });
  if (!state.good) state.good = {};

  const snapshot = collect(cfg);

  // 예산 기준선: 설정에 명시된 값이 최우선이고,
  // 없으면 최초로 수집에 성공한 잔액을 기준으로 삼는다.
  if (cfg.budget?.initialCredits != null) {
    state.budgetBaseline = cfg.budget.initialCredits;
  } else if (state.budgetBaseline == null) {
    state.budgetBaseline = snapshot.balance?.available ?? null;
  }

  // 비교 기준은 "마지막 수집"이 아니라 "항목별 마지막 성공 값"이다.
  // 실패한 수집이 기준을 오염시키면 없는 것과 바뀐 것을 구분할 수 없다.
  const prevForDiff = state.good.balance
    ? {
        balance: state.good.balance,
        scopeWriters: state.good.scopeWriters || {},
        usageEntries: [],
        budgetBaseline: state.budgetBaseline,
      }
    : null;
  const findings = detectChanges(prevForDiff, snapshot, cfg);

  // 추가 전용 대장에 기록 — 절대 덮어쓰지 않는다
  const record = {
    seq: (state.runs || 0) + 1,
    at: snapshot.at,
    env: snapshot.env,
    balance: snapshot.balance,
    newUsageCount: snapshot.usageEntries.length,
    usageEntries: snapshot.usageEntries,
    scopeWriters: snapshot.scopeWriters,
    findings,
    errors: snapshot.errors,
  };
  fs.appendFileSync(LEDGER_PATH, JSON.stringify(record) + "\n", "utf8");

  state.runs = record.seq;
  state.lastSeq = snapshot.lastSeq ?? state.lastSeq;
  state.last = snapshot;
  state.lastFindings = findings;

  // 성공한 항목만 골라 "마지막 성공 값"을 갱신한다.
  if (snapshot.balance) {
    state.good.balance = snapshot.balance;
    state.good.balanceAt = snapshot.at;
  }
  if (Object.keys(snapshot.scopeWriters || {}).length) {
    state.good.scopeWriters = snapshot.scopeWriters;
    state.good.scopeWritersAt = snapshot.at;
  }

  writeJson(STATE_PATH, state);

  const report = renderReport(snapshot, findings, cfg);
  fs.writeFileSync(REPORT_PATH, report, "utf8");
  console.log(report);

  const hasAlert = findings.some((f) => f.severity === "alert");
  process.exit(hasAlert ? 2 : 0);
}

main();
