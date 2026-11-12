import tokensJson from "../tokens.json";
import { handle } from "./api";
import { parseTokensFile } from "./config";
import { runCycle } from "./cycle";
import { type Env, settings } from "./settings";

// Bundled at build time: changing tokens.json means a redeploy, which goes through review.
const cfg = parseTokensFile(tokensJson);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env.DB, cfg, settings(env));
  },

  async scheduled(ctrl: ScheduledController, env: Env): Promise<void> {
    const now = Math.floor(ctrl.scheduledTime / 1000);
    const { log } = await runCycle(env.DB, cfg, settings(env), now);
    for (const line of log) console.log(line);
  },
} satisfies ExportedHandler<Env>;
