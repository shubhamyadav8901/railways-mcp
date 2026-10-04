import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express, Request, Response } from "express";
import { pathToFileURL } from "node:url";
import { type AppContext, buildContext, loadConfig } from "./config.js";
import { SERVER_INFO, createMcpServer } from "./mcp.js";

/**
 * Stateless streamable-HTTP app: a new McpServer + transport per POST (the
 * SDK requires this in stateless mode so request ids can't collide). The
 * heavy state (timetables) lives in ctx and is shared.
 */
export function createApp(ctx: AppContext, opts: { host: string; allowedHosts?: string[] }): Express {
  // Host-header validation guards against DNS rebinding; on 0.0.0.0 it needs an explicit allow-list.
  const app = createMcpExpressApp({ host: opts.host, allowedHosts: opts.allowedHosts });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", server: SERVER_INFO, timetables: ctx.timetables.map((t) => ({ id: t.info.id, trains: t.trainCount })) });
  });

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error("mcp request failed:", e);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  const notAllowed = (_req: Request, res: Response): void => {
    res
      .status(405)
      .set("Allow", "POST")
      .json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  return app;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const started = Date.now();
  const ctx = buildContext(cfg);
  console.log(
    `loaded ${ctx.timetables.map((t) => `${t.info.id} (${t.trainCount} trains)`).join(", ")} in ${Date.now() - started} ms; ` +
      `disabled: ${ctx.disabled.map((d) => d.source).join(", ") || "none"}`,
  );
  const host = process.env.HOST ?? "0.0.0.0";
  if ((host === "0.0.0.0" || host === "::") && !cfg.allowedHosts) {
    console.warn("ALLOWED_HOSTS is not set: Host-header validation is off. Set it to your public hostname in production.");
  }
  const app = createApp(ctx, { host, allowedHosts: cfg.allowedHosts });
  app.listen(cfg.port, host, () => console.log(`MCP endpoint: http://${host}:${cfg.port}/mcp`));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
