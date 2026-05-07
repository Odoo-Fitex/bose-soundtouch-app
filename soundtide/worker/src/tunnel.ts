/**
 * Durable Object that holds the household tunnel WebSocket from the Pi and
 * relays inbound HTTP requests across it.
 *
 * Protocol:
 *   PWA --HTTP--> Worker /agent/* --DO /__forward--> WS frame {id, method, path, headers, body}
 *   Pi processes, sends back {id, status, body}; the DO resolves the matching pending promise.
 */

interface PendingRequest {
  resolve: (resp: Response) => void;
  reject: (err: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface AgentMessage {
  id?: string;
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: unknown;
  status?: number;
}

export class Tunnel implements DurableObject {
  private agent: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private nextId = 1;

  constructor(private state: DurableObjectState, private env: any) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Pi connecting in.
    if (req.headers.get("upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.bindAgent(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // Worker sending us a forward request.
    if (req.method === "POST" && url.pathname === "/__forward") {
      const env = await req.json() as AgentMessage;
      if (!this.agent || this.agent.readyState !== 1 /* OPEN */) {
        return new Response(JSON.stringify({ error: "agent offline" }), { status: 502, headers: { "content-type": "application/json" } });
      }
      const id = String(this.nextId++);
      const promise = new Promise<Response>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("timeout"));
        }, 15_000);
        this.pending.set(id, { resolve, reject, timeout });
      });
      this.agent.send(JSON.stringify({ id, method: env.method, path: env.path, headers: env.headers, body: env.body }));
      try {
        return await promise;
      } catch {
        return new Response(JSON.stringify({ error: "agent timeout" }), { status: 504, headers: { "content-type": "application/json" } });
      }
    }

    return new Response("not found", { status: 404 });
  }

  private bindAgent(ws: WebSocket) {
    ws.accept();
    if (this.agent) {
      try { this.agent.close(); } catch {}
    }
    this.agent = ws;
    ws.addEventListener("message", (ev) => {
      try {
        const data = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer)) as AgentMessage;
        if (!data.id) return;
        const p = this.pending.get(data.id);
        if (!p) return;
        clearTimeout(p.timeout);
        this.pending.delete(data.id);
        const status = typeof data.status === "number" ? data.status : 200;
        const payload = typeof data.body === "string" ? data.body : JSON.stringify(data.body ?? null);
        p.resolve(new Response(payload, { status, headers: { "content-type": "application/json" } }));
      } catch {
        // ignore garbage
      }
    });
    ws.addEventListener("close", () => {
      if (this.agent === ws) this.agent = null;
      // fail any in-flight requests so the PWA gets a quick error.
      for (const [, p] of this.pending) {
        clearTimeout(p.timeout);
        p.resolve(new Response(JSON.stringify({ error: "agent disconnected" }), { status: 502, headers: { "content-type": "application/json" } }));
      }
      this.pending.clear();
    });
  }
}
