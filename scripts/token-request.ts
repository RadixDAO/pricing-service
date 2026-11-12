/**
 * Used by the GitHub workflows. Issue text is untrusted: it is only ever parsed here, never put
 * into a shell command.
 *
 *   tsx scripts/token-request.ts check <event.json> <outdir>
 *     Checks the token request in a GitHub `issues` event. Writes to <outdir>:
 *       comment.md   result for the issue
 *       result.json  {ok, kind, symbol, branch, title}
 *       tokens.json  the proposed file (only when ok)
 *       pr-body.md   pull request description (only when ok)
 *
 *   tsx scripts/token-request.ts recheck
 *     Re-checks every listed pool and opens one issue per token with problems (labelled
 *     token-recheck), unless one is already open. Needs GITHUB_TOKEN and GITHUB_REPOSITORY.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTokensFile } from "../src/config";
import { makeGateway } from "../src/gateway";
import { settings } from "../src/settings";
import { checkAdd, checkRemove, type Deps, parseRequest, recheck, resultMarkdown } from "../src/tokencheck";

const s = settings({
  DB: undefined as any,
  GATEWAY_URL: process.env.GATEWAY_URL,
  COINGECKO_API_KEY: process.env.COINGECKO_API_KEY,
});
const deps: Deps = { gw: makeGateway(s.gatewayUrl, fetch, s.httpTimeoutMs), fetchFn: fetch, s, now: Math.floor(Date.now() / 1000) };
const cfg = parseTokensFile(JSON.parse(readFileSync("tokens.json", "utf8")));
const runUrl = process.env.GITHUB_RUN_ID
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : undefined;

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "check") {
  const [eventPath, outdir] = args;
  mkdirSync(outdir, { recursive: true });
  const ev = JSON.parse(readFileSync(eventPath, "utf8"));
  const issue = ev.issue;
  const labels: string[] = (issue.labels ?? []).map((l: any) => l.name);
  const req = parseRequest(String(issue.body ?? ""), labels);
  const write = (f: string, v: string) => writeFileSync(join(outdir, f), v);

  if ("error" in req) {
    write("comment.md", `❌ **This request could not be read:** ${req.error}.\n\nEdit the issue to fix it; the checks run again automatically.`);
    write("result.json", JSON.stringify({ ok: false }));
  } else {
    const r = req.kind === "add" ? await checkAdd(req, cfg, deps) : checkRemove(req, cfg);
    write("comment.md", resultMarkdown(r, req, runUrl));
    const title = `${r.summary} (#${issue.number})`;
    write("result.json", JSON.stringify({ ok: r.ok, kind: req.kind, symbol: req.symbol, branch: `token-request/${issue.number}`, title }));
    if (r.ok && r.tokens) {
      write("tokens.json", JSON.stringify(r.tokens, null, 2) + "\n");
      write(
        "pr-body.md",
        [
          `${r.summary}, as requested in #${issue.number}.`,
          "",
          resultMarkdown(r, req, runUrl).split("\n").filter((l) => !l.startsWith("✅")).join("\n"),
          "",
          "**Before merging**, check that the token and its pools are what the requester intends, and that the pools are not trivially cheap to move. Merging deploys the change.",
          "",
          `Closes #${issue.number}`,
        ].join("\n"),
      );
    }
    console.log(`${r.summary}: ${r.ok ? "passed" : "failed"}`);
    for (const c of r.checks) console.log(`  ${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}`);
  }
} else if (cmd === "recheck") {
  const { findings, error } = await recheck(cfg, deps);
  if (error) {
    console.error(error);
    process.exit(1);
  }
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const gh = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "radixdao-pricing-service", ...(init.headers ?? {}) },
    });
    if (!r.ok) throw new Error(`GitHub ${path}: HTTP ${r.status}`);
    return r.json() as Promise<any>;
  };
  const open: any[] = repo && token ? await gh(`/issues?state=open&labels=token-recheck&per_page=100`) : [];
  for (const f of findings) {
    const title = `Recheck: ${f.symbol} ${f.unpriced ? "has no usable pool" : "has pools that fail the checks"}`;
    const body = [
      `The weekly recheck found problems with **${f.symbol}**:`,
      "",
      ...f.problems.map((p) => `- ${p}`),
      "",
      f.unpriced
        ? "The service currently shows **no price** for this token. Consider removing it (open a *Remove token* request) or proposing a working pool (an *Add token* request with the same symbol replaces its pools)."
        : "The token is still priced from its other pools. Consider removing the failing pools with an *Add token* request that lists only the working ones.",
      "",
      runUrl ? `<sub>Found by [this run](${runUrl}).</sub>` : "",
    ].join("\n");
    console.log(`${title}\n  ${f.problems.join("\n  ")}`);
    if (!repo || !token) continue;
    if (open.some((i) => i.title === title)) continue;
    await gh(`/issues`, { method: "POST", body: JSON.stringify({ title, body, labels: ["token-recheck"] }) });
  }
  if (findings.length === 0) console.log("all listed pools pass");
} else {
  console.error("usage: token-request.ts check <event.json> <outdir> | recheck");
  process.exit(2);
}
