import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import { SCHEMA_SQL } from "./schema.js";

export class ComputerDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(SCHEMA_SQL);
    });
  }

  override async fetch(_request: Request): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  }
}
