/** Minimal Radix Gateway client: status, transaction preview, entity details. */

export type FetchFn = typeof fetch;

export interface Gateway {
  post<T = any>(path: string, body: unknown): Promise<T>;
}

export function makeGateway(baseUrl: string, fetchFn: FetchFn = fetch, timeoutMs = 10_000): Gateway {
  const base = baseUrl.replace(/\/+$/, "");
  return {
    async post(path, body) {
      const r = await fetchFn(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "radixdao-pricing-service" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`gateway ${path}: HTTP ${r.status}`);
      return (await r.json()) as any;
    },
  };
}

// A fixed public key is enough for preview with assume_all_signature_proofs.
const SIGNER_KEYS = [
  { key_type: "EcdsaSecp256k1", key_hex: "0388207bf34f38fe057884e1efba2f54d1bfb3daf59894db12b1709315cfc77617" },
];
const PREVIEW_FLAGS = {
  use_free_credit: true,
  assume_all_signature_proofs: true,
  skip_epoch_check: true,
  disable_auth_checks: false,
};

export async function getEpoch(gw: Gateway): Promise<number> {
  const d = await gw.post("/status/gateway-status", {});
  return d.ledger_state.epoch;
}

/** Preview a manifest; returns programmatic_json per instruction. Throws if the preview did not succeed. */
export async function preview(gw: Gateway, manifest: string, epoch: number): Promise<any[]> {
  const d = await gw.post("/transaction/preview", {
    manifest,
    start_epoch_inclusive: epoch,
    end_epoch_exclusive: epoch + 2,
    tip_percentage: 0,
    nonce: 1,
    signer_public_keys: SIGNER_KEYS,
    flags: PREVIEW_FLAGS,
  });
  const rc = d.receipt;
  if (rc.status !== undefined && rc.status !== "Succeeded") {
    throw new Error(`preview ${rc.status}: ${String(rc.error_message ?? "").slice(0, 160)}`);
  }
  return rc.output.map((o: any) => o.programmatic_json);
}

export interface Call {
  component: string;
  method: string;
  /** Manifest argument literals, e.g. ['Decimal("1.5")', "false"]. */
  args?: string[];
}

export function callManifest(c: Call): string {
  return [`CALL_METHOD`, `Address("${c.component}")`, `"${c.method}"`, ...(c.args ?? [])].join("\n") + "\n;";
}

/**
 * Run many read-only calls in as few previews as possible. A failing call fails its whole
 * preview, so on failure the batch is split in half until the failing calls are isolated.
 */
export async function batchCalls(gw: Gateway, epoch: number, calls: Call[]): Promise<Array<{ ok: true; value: any } | { ok: false; error: string }>> {
  if (calls.length === 0) return [];
  try {
    const out = await preview(gw, calls.map(callManifest).join("\n"), epoch);
    if (out.length !== calls.length) throw new Error(`preview returned ${out.length} outputs for ${calls.length} calls`);
    return out.map((value) => ({ ok: true as const, value }));
  } catch (e) {
    if (calls.length === 1) return [{ ok: false, error: errMsg(e) }];
    const mid = Math.ceil(calls.length / 2);
    const [a, b] = await Promise.all([batchCalls(gw, epoch, calls.slice(0, mid)), batchCalls(gw, epoch, calls.slice(mid))]);
    return [...a, ...b];
  }
}

const POOL_RE = /pool_rdx1[0-9a-z]{50,}/g;

export interface EntityHoldings {
  /** resource address -> amount */
  amounts: Map<string, number>;
  /** native pool_rdx1… addresses referenced in the component state */
  refs: string[];
}

/** Fungible balances (Global aggregation) for components and the native pools they reference. */
export async function holdings(gw: Gateway, addresses: string[]): Promise<Map<string, EntityHoldings>> {
  const out = new Map<string, EntityHoldings>();
  const fetchChunked = async (addrs: string[]) => {
    const chunks: string[][] = [];
    for (let i = 0; i < addrs.length; i += 20) chunks.push(addrs.slice(i, i + 20));
    const results = await Promise.all(
      chunks.map((c) => gw.post("/state/entity/details", { addresses: c, aggregation_level: "Global" })),
    );
    for (const d of results) {
      for (const it of d.items) {
        const amounts = new Map<string, number>();
        for (const r of it.fungible_resources?.items ?? []) if ("amount" in r) amounts.set(r.resource_address, Number(r.amount));
        const state = JSON.stringify(it.details?.state ?? {});
        out.set(it.address, { amounts, refs: [...new Set(state.match(POOL_RE) ?? [])] });
      }
    }
  };
  await fetchChunked([...new Set(addresses)]);
  const refs = [...new Set([...out.values()].flatMap((h) => h.refs))].filter((r) => !out.has(r));
  if (refs.length) await fetchChunked(refs);
  return out;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
