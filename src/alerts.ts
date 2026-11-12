/**
 * Alerts as GitHub issues. A condition must hold for `openAfter` consecutive cycles before an
 * issue is opened, and be clear for `closeAfter` cycles before it is closed, so short blips do
 * not spam the repository.
 */
import { errMsg, type FetchFn } from "./gateway";

export interface AlertSettings {
  githubToken?: string;
  alertRepo: string;
  openAfter: number;
  closeAfter: number;
  timeoutMs: number;
}

interface AlertRow {
  key: string;
  message: string;
  first_seen: number;
  last_seen: number;
  bad_streak: number;
  good_streak: number;
  issue_number: number | null;
}

export const ALERT_LABEL = "price-alert";

/** @param active key -> message for every condition that is bad in this cycle. */
export async function processAlerts(
  db: D1Database,
  active: Map<string, string>,
  now: number,
  s: AlertSettings,
  fetchFn: FetchFn = fetch,
): Promise<string[]> {
  const log: string[] = [];
  const { results: rows } = await db.prepare("SELECT * FROM alerts").all<AlertRow>();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const stmts: D1PreparedStatement[] = [];

  for (const [key, message] of active) {
    const r = byKey.get(key);
    const streak = (r?.bad_streak ?? 0) + 1;
    let issue = r?.issue_number ?? null;
    if (issue === null && streak >= s.openAfter) {
      issue = await openIssue(key, message, r?.first_seen ?? now, s, fetchFn, log);
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO alerts (key, message, first_seen, last_seen, bad_streak, good_streak, issue_number)
           VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
           ON CONFLICT(key) DO UPDATE SET message = ?2, last_seen = ?4, bad_streak = ?5, good_streak = 0, issue_number = ?6`,
        )
        .bind(key, message, r?.first_seen ?? now, now, streak, issue),
    );
  }

  for (const r of rows) {
    if (active.has(r.key)) continue;
    const good = r.good_streak + 1;
    if (good >= s.closeAfter) {
      if (r.issue_number !== null) await closeIssue(r.issue_number, now, s, fetchFn, log);
      stmts.push(db.prepare("DELETE FROM alerts WHERE key = ?").bind(r.key));
    } else {
      stmts.push(db.prepare("UPDATE alerts SET good_streak = ?, bad_streak = 0 WHERE key = ?").bind(good, r.key));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return log;
}

async function gh(path: string, method: string, body: unknown, s: AlertSettings, fetchFn: FetchFn): Promise<any> {
  const r = await fetchFn(`https://api.github.com/repos/${s.alertRepo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${s.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "radixdao-pricing-service",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(s.timeoutMs),
  });
  if (!r.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${r.status}`);
  return r.json();
}

async function openIssue(key: string, message: string, since: number, s: AlertSettings, fetchFn: FetchFn, log: string[]): Promise<number | null> {
  log.push(`ALERT ${key}: ${message}`);
  if (!s.githubToken) return null;
  try {
    const d = await gh(
      "/issues",
      "POST",
      {
        title: `Price alert: ${message.slice(0, 120)}`,
        body:
          `The pricing service reports a problem.\n\n` +
          `- **Condition:** \`${key}\`\n- **Details:** ${message}\n- **Since:** ${new Date(since * 1000).toISOString()}\n\n` +
          `While this lasts, affected prices are held at their last validated value for up to 15 minutes and then withdrawn. ` +
          `This issue closes automatically once the condition has cleared.`,
        labels: [ALERT_LABEL],
      },
      s,
      fetchFn,
    );
    return d.number;
  } catch (e) {
    log.push(`could not open alert issue: ${errMsg(e)}`);
    return null;
  }
}

async function closeIssue(n: number, now: number, s: AlertSettings, fetchFn: FetchFn, log: string[]) {
  log.push(`alert cleared, closing #${n}`);
  if (!s.githubToken) return;
  try {
    await gh(`/issues/${n}/comments`, "POST", { body: `Cleared at ${new Date(now * 1000).toISOString()}.` }, s, fetchFn);
    await gh(`/issues/${n}`, "PATCH", { state: "closed", state_reason: "completed" }, s, fetchFn);
  } catch (e) {
    log.push(`could not close alert issue #${n}: ${errMsg(e)}`);
  }
}
