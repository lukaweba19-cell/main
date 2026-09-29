import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { handleXReactorCheck } from "./xreactor.controller.js";
import { $ref } from "../../plugins/schemas.js";
import { XReactorRequest } from "./xreactor.schema.js";
import {
  edgeTokenOk,
  hostIsXReactor,
  XREACTOR_EDGE_HEADER,
} from "./xreactor.acl.js";

/** ACL hook: host isolation + optional shared-secret edge token. */
async function xreactorAcl(request: FastifyRequest, reply: FastifyReply) {
  if (!hostIsXReactor(request.headers.host)) {
    return reply.code(403).send({
      message: "Forbidden: /xreactor is only served via the designated domain",
    });
  }
  if (!edgeTokenOk(request.headers[XREACTOR_EDGE_HEADER])) {
    return reply.code(403).send({ message: "Forbidden: bad edge token" });
  }
}

const USAGE_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>XReactor — API usage</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background: #0a0a0b; color: #e4e4e7;
    font: 14px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  main { max-width: 720px; margin: 0 auto; padding: 2.2rem 1.1rem 3.5rem; }
  h1 { font-size: 1.35rem; letter-spacing: 0.02em; margin: 0 0 0.3rem; }
  h1 span { color: #34d399; }
  .sub { color: #a1a1aa; margin: 0 0 1.6rem; }
  h2 { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.14em;
    color: #71717a; margin: 2rem 0 0.8rem; border-bottom: 1px solid #1f1f23; padding-bottom: 0.45rem; }
  .snippet { position: relative; margin: 0 0 1.1rem; }
  .lang { position: absolute; top: 0.55rem; right: 0.7rem; font-size: 0.62rem;
    text-transform: uppercase; letter-spacing: 0.12em; color: #6b7280; pointer-events: none; }
  pre { margin: 0; background: #121214; border: 1px solid #26262b; border-radius: 10px;
    padding: 0.95rem 1rem; overflow-x: auto; white-space: pre; font-size: 0.8rem; line-height: 1.55; }
  code.inline { background: #18181b; border: 1px solid #27272a; border-radius: 6px;
    padding: 0.1rem 0.4rem; color: #93c5fd; }
  .c { color: #6b7280; } /* comment */
  .g { color: #34d399; } /* good */
  .b { color: #f87171; } /* bad */
  .pill { display: inline-block; padding: 0.1rem 0.55rem; border-radius: 999px;
    font-size: 0.72rem; margin-right: 0.4rem; }
  .pill.allowed { background: rgba(52,211,153,.12); color: #34d399; border: 1px solid rgba(52,211,153,.35); }
  .pill.disallowed { background: rgba(248,113,113,.12); color: #f87171; border: 1px solid rgba(248,113,113,.35); }
  .row { margin: 0 0 0.55rem; color: #a1a1aa; }
</style>
</head>
<body>
<main>
  <h1>xreactor <span>/xreactor</span></h1>
  <p class="sub">Send a url — get <span class="pill allowed">allowed</span> or <span class="pill disallowed">disallowed</span> back. Checks the page (plus up to 3 pages it links) for any mention of &quot;cloud&quot; in any spelling.</p>

  <h2>Endpoint</h2>
  <div class="snippet"><pre>GET  <code class="inline">https://xreactor-bot.duckdns.org/xreactor?url=&lt;page-url&gt;</code>
POST <code class="inline">https://xreactor-bot.duckdns.org/xreactor</code>   body: {"url": "&lt;page-url&gt;"}</pre></div>

  <h2>Request examples</h2>

  <div class="snippet"><div class="lang">curl — GET</div><pre>curl "https://xreactor-bot.duckdns.org/xreactor?url=https://example.com"</pre></div>

  <div class="snippet"><div class="lang">curl — POST</div><pre>curl -X POST https://xreactor-bot.duckdns.org/xreactor \\
  -H "Content-Type: application/json" \\
  -d '{"url": "https://example.com"}'</pre></div>

  <div class="snippet"><div class="lang">php</div><pre>&lt;?php
$page = urlencode("https://example.com");
$json = file_get_contents(
  "https://xreactor-bot.duckdns.org/xreactor?url=" . $page
);
$result = json_decode($json, true)["result"];

if ($result === "allowed") {
  echo "no cloud mention\n";
} else {
  echo "cloud mention found\n";
}</pre></div>

  <div class="snippet"><div class="lang">javascript</div><pre>const res = await fetch("https://xreactor-bot.duckdns.org/xreactor", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ url: "https://example.com" }),
});
const data = await res.json();
console.log(data.result); // <span class="g">allowed</span> | <span class="b">disallowed</span></pre></div>

  <div class="snippet"><div class="lang">python</div><pre>import requests

r = requests.get(
    "https://xreactor-bot.duckdns.org/xreactor",
    params={"url": "https://example.com"},
    timeout=300,
)
print(r.json()["result"])  # <span class="g">allowed</span> | <span class="b">disallowed</span></pre></div>

  <h2>Responses</h2>

  <div class="snippet"><div class="lang">200 — no cloud mention</div><pre>{
  <span class="g">"result": "allowed"</span>,
  "seedUrl": "https://example.com",
  "pages": [
    { "url": "https://example.com", "status": "ok",
      "cloudFound": false, "matches": [], "markdownChars": 2892,
      "followedFrom": null }
  ],
  "links": {
    "found": 6,
    "followed": ["https://example.com/page-2", "…"],
    "skippedAds": 25, "skippedBinary": 0, "skippedOther": 12
  },
  "timings": { "totalMs": 141233 }
}</pre></div>

  <div class="snippet"><div class="lang">200 — cloud mention found</div><pre>{
  <span class="b">"result": "disallowed"</span>,
  "seedUrl": "https://example.com",
  "pages": [
    { "url": "https://example.com", "status": "ok",
      "cloudFound": true,
      "matches": [
        { "variant": "cloud*",
          "excerpt": "…hosted in the <span class="b">cloud</span> with 99.9% uptime…" }
      ],
      "markdownChars": 4210, "followedFrom": null }
  ],
  "links": { "found": 6, "followed": [], "skippedAds": 3,
             "skippedBinary": 0, "skippedOther": 9 },
  "timings": { "totalMs": 38411 }
}</pre></div>

  <div class="snippet"><div class="lang">400 / 403</div><pre>{"message": "Invalid URL: …"}                                <span class="c"># 400 bad url</span>
{"message": "Forbidden: /xreactor is only served via the designated domain"}
                                                             <span class="c"># 403 wrong host</span></pre></div>
</main>
</body>
</html>`;

async function routes(server: FastifyInstance) {
  // Plugin-scoped hook: applies to every route registered below (GET + POST
  // /xreactor) without touching fastify's route-generic inference.
  server.addHook("onRequest", xreactorAcl);

  server.post(
    "/xreactor",
    {
      schema: {
        operationId: "xreactor_check",
        description:
          "Scrape a URL (plus up to 3 linked pages), detect any mention of 'cloud' in any spelling, and return allowed or disallowed",
        tags: ["XReactor"],
        summary: "Cloud-mention compliance check for a URL",
        body: $ref("XReactorCheckRequest"),
        response: {
          200: $ref("XReactorResponse"),
        },
      },
    },
    async (request: XReactorRequest, reply: FastifyReply) =>
      handleXReactorCheck(server.sessionService, server.cdpService, request, reply),
  );

  server.get(
    "/xreactor",
    {
      schema: {
        operationId: "xreactor_check_get",
        description: "GET variant of the xreactor check: pass ?url=...",
        tags: ["XReactor"],
        summary: "Cloud-mention compliance check (GET variant)",
      },
    },
    async (request, reply) => {
      const url = (request.query as any)?.url as string | undefined;
      if (!url || !url.trim()) {
        // Browser-friendly docs: request examples + response shapes, nothing else.
        reply.type("text/html; charset=utf-8");
        return reply.send(USAGE_PAGE_HTML);
      }
      (request as any).body = { url };
      return handleXReactorCheck(
        server.sessionService,
        server.cdpService,
        request as unknown as XReactorRequest,
        reply,
      );
    },
  );
}

export default routes;
