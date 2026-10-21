import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { analyzeJavaScriptApplication } from "../../../src/application/JavaScriptApplicationService.js";
import { fetchWebScripts } from "../../../src/application/WebScriptFetchService.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascriptApplicationAnalysis.js";
import {
  webScriptFetchResultSchema,
  type WebScriptFetchResult,
} from "../../../src/domain/webScriptFetch.js";
import { WebScriptFetchError } from "../../../src/domain/webScriptFetchError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

interface Resource {
  readonly body: string;
  readonly type: string;
}

const BIG = `export const big = '${"x".repeat(2000)}';\n`;

const SITE: Readonly<Record<string, Resource>> = {
  "/": {
    type: "text/html; charset=utf-8",
    body: `<!doctype html><html><head>
      <link rel="modulepreload" href="/app/dep.js">
      <link rel="preload" as="script" href="pre.js">
      <script type="module" src="/app/main.js"></script>
      <script src="app/rel.js"></script>
      <script src="https://cdn.other.test/vendor.js"></script>
      <script src="/app/missing.js"></script>
      <script src="/app/redirected.js"></script>
      <script src="/app/big.js"></script>
      <script type="application/json">{"ignored":true}</script>
      <script>window.__boot = 1; import("./app/lazy.js");</script>
    </head><body>hello</body></html>`,
  },
  "/app/main.js": {
    type: "text/javascript",
    body: "import { marker } from './dep.js';\nimport lodash from 'lodash';\nexport const result = [marker, lodash];\n",
  },
  "/app/dep.js": {
    type: "application/javascript; charset=utf-8",
    body: "export const marker = 'fetched';\n",
  },
  "/app/rel.js": { type: "text/javascript", body: "export const rel = 1;\n" },
  "/pre.js": { type: "text/javascript", body: "export const pre = 1;\n" },
  "/app/lazy.js": { type: "text/javascript", body: "export default 'lazy';\n" },
  "/app/final.js": {
    type: "text/javascript",
    body: "export const final = true;\n",
  },
  "/app/big.js": { type: "text/javascript", body: BIG },
};
const FETCHED_PATHS = [
  "/app/main.js",
  "/app/dep.js",
  "/app/rel.js",
  "/pre.js",
  "/app/lazy.js",
  "/app/big.js",
];

const serve = async (): Promise<{
  readonly origin: string;
  readonly requests: string[];
  readonly close: () => Promise<void>;
}> => {
  const requests: string[] = [];
  const server: Server = createServer((incoming, response) => {
    const path = incoming.url ?? "/";
    requests.push(path);
    if (path === "/app/redirected.js") {
      response.writeHead(302, { location: "/app/final.js" }).end();
      return;
    }
    const entry = SITE[path];
    if (entry === undefined) {
      response.writeHead(404, { "content-type": "text/plain" }).end("nope");
      return;
    }
    response.writeHead(200, { "content-type": entry.type }).end(entry.body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new TypeError("Expected a TCP listener address");
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};

const sha = (bytes: Buffer | string): string =>
  createHash("sha256").update(bytes).digest("hex");

const resource = (path: string): Resource => {
  const entry = SITE[path];
  if (entry === undefined) throw new Error(`Unknown fixture ${path}`);
  return entry;
};

const parsed = (evidence: { readonly normalized_result: unknown }) =>
  webScriptFetchResultSchema.parse(evidence.normalized_result);

const script = (result: WebScriptFetchResult, url: string) => {
  const found = result.scripts.find((candidate) => candidate.url === url);
  if (found === undefined) throw new Error(`Expected a record for ${url}`);
  return found;
};

const exportedContent = (result: WebScriptFetchResult, url: string) => {
  const record = script(result, url);
  if (record.content.state !== "exported")
    throw new Error(`Expected ${url} to be exported`);
  return record.content;
};

type FakeResponse = Response | (() => Response);

const requestUrl = (input: string | URL | Request): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

const fakeFetch = (
  resources: Readonly<Record<string, FakeResponse>>,
  requested: string[],
  onRequest?: (url: string) => void,
): typeof fetch => {
  const implementation = async (
    input: string | URL | Request,
  ): Promise<Response> => {
    const url = requestUrl(input);
    requested.push(url);
    onRequest?.(url);
    const entry = resources[url];
    if (entry === undefined) return new Response("not found", { status: 404 });
    return typeof entry === "function" ? entry() : entry;
  };
  return implementation as typeof fetch;
};

const js =
  (body: string): (() => Response) =>
  () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/javascript" },
    });
const html =
  (body: string): (() => Response) =>
  () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/html" },
    });

const outputDirectory = async (): Promise<string> =>
  join(await createTestTempDirectory("rea-web-script-fetch-"), "fetched");

describe("browserless website script fetch: live origin", () => {
  it("fetches the page and follows markup URLs and literal imports into verified files", async () => {
    const site = await serve();
    try {
      const output = await outputDirectory();
      const fetched = await fetchWebScripts({
        page_url: `${site.origin}/`,
        output_directory: output,
      });
      if (!fetched.ok) throw fetched.error;
      expect(fetched.value.authority).toBe("shipped-artifact");
      expect(fetched.value.confidence).toBe("observed");
      const result = parsed(fetched.value);
      expect(result.completeness).toBe("partial");
      expect(result.truncated_by).toEqual([]);
      expect(result.archive_snapshot).toBeNull();
      expect(result.allowed_origins).toEqual([site.origin]);
      expect(result.page.status).toBe(200);
      expect(result.page.sha256).toBe(sha(resource("/").body));
      expect(await readFile(join(output, "page.html"), "utf8")).toBe(
        resource("/").body,
      );
      const manifest = await readFile(result.manifest.path);
      expect(result.manifest.sha256).toBe(sha(manifest));
      const { manifest: descriptor, ...inline } = result;
      expect(descriptor.bytes).toBe(manifest.length);
      expect(JSON.parse(manifest.toString())).toEqual(inline);
      if (result.analysis_input === null)
        throw new Error("Missing analysis input");
      for (const path of FETCHED_PATHS) {
        const content = exportedContent(result, `${site.origin}${path}`);
        expect(content.layout).toBe("url-path");
        expect(content.representation).toBe("http-response-bytes");
        expect(content.sha256).toBe(sha(resource(path).body));
        expect(
          await readFile(
            join(result.analysis_input.input_path, content.relative_path),
            "utf8",
          ),
        ).toBe(resource(path).body);
      }
      expect(script(result, `${site.origin}/app/rel.js`).source).toMatchObject({
        discovered_by: "script-src",
        referrer_url: `${site.origin}/`,
      });
      expect(script(result, `${site.origin}/pre.js`).source).toMatchObject({
        discovered_by: "preload",
        is_module: false,
      });
      expect(
        site.requests.filter((path) => path === "/app/dep.js"),
      ).toHaveLength(1);
      expect(site.requests).not.toContain("/vendor.js");
      const analyzed = await analyzeJavaScriptApplication(
        result.analysis_input,
      );
      if (!analyzed.ok) throw analyzed.error;
      const analysis = javascriptApplicationAnalysisResultSchema.parse(
        analyzed.value.normalized_result,
      );
      expect(analysis.statistics.parsed_javascript_files).toBe(
        FETCHED_PATHS.length + 2,
      );
    } finally {
      await site.close();
    }
  });

  it("records redirects, failures, inline scripts, and unresolved specifiers inline", async () => {
    const site = await serve();
    try {
      const fetched = await fetchWebScripts({
        page_url: `${site.origin}/`,
        output_directory: await outputDirectory(),
      });
      if (!fetched.ok) throw fetched.error;
      const result = parsed(fetched.value);
      expect(script(result, `${site.origin}/app/redirected.js`)).toMatchObject({
        content: { state: "exported" },
        source: {
          discovered_by: "script-src",
          fetched_url: `${site.origin}/app/final.js`,
          status: 200,
        },
      });
      expect(
        script(result, `${site.origin}/app/missing.js`).content,
      ).toMatchObject({ state: "unavailable", reason: "http_status" });
      const inlineScript = result.scripts.find(
        ({ source }) => source.discovered_by === "inline-script",
      );
      expect(inlineScript?.content).toMatchObject({
        state: "exported",
        layout: "isolated",
        representation: "inline-markup-utf8",
      });
      expect(script(result, `${site.origin}/app/lazy.js`).source).toMatchObject(
        {
          discovered_by: "dynamic_import",
          referrer_url: `${site.origin}/`,
        },
      );
      expect(result.discovery).toMatchObject({
        script_tags: 6,
        modulepreload_links: 1,
        preload_links: 1,
        inline_scripts: 1,
        parse_failures: 0,
        partial_parses: 0,
        skipped_markup: [
          { reason: "non_javascript_type", detail: "application/json" },
        ],
        unresolved_specifiers: [
          {
            referrer_url: `${site.origin}/`,
            specifier: "https://cdn.other.test/vendor.js",
            reason: "outside_allowed_origins",
          },
          {
            referrer_url: `${site.origin}/app/main.js`,
            specifier: "lodash",
            reason: "bare_specifier",
          },
        ],
      });
    } finally {
      await site.close();
    }
  });
});

describe("browserless website script fetch: bounds", () => {
  it("lists scripts left behind by max_scripts as unavailable with reason limit", async () => {
    const site = await serve();
    try {
      const fetched = await fetchWebScripts({
        page_url: `${site.origin}/`,
        output_directory: await outputDirectory(),
        max_scripts: 1,
      });
      if (!fetched.ok) throw fetched.error;
      const result = parsed(fetched.value);
      expect(result.completeness).toBe("truncated");
      expect(result.truncated_by).toEqual(["max_scripts"]);
      const networkScripts = result.scripts.filter(
        ({ source }) => source.discovered_by !== "inline-script",
      );
      expect(
        networkScripts.filter(({ content }) => content.state === "exported"),
      ).toHaveLength(1);
      const leftovers = networkScripts.filter(
        ({ content }) =>
          content.state === "unavailable" && content.reason === "limit",
      );
      expect(leftovers.map(({ url }) => url)).toEqual(
        expect.arrayContaining([
          `${site.origin}/app/dep.js`,
          `${site.origin}/app/lazy.js`,
        ]),
      );
      expect(
        result.limitations.some((text) => text.includes("max_scripts (1)")),
      ).toBe(true);
    } finally {
      await site.close();
    }
  });

  it("stops retaining bytes at max_total_bytes and says which bound was hit", async () => {
    const site = await serve();
    try {
      const fetched = await fetchWebScripts({
        page_url: `${site.origin}/`,
        output_directory: await outputDirectory(),
        max_total_bytes: 1024,
      });
      if (!fetched.ok) throw fetched.error;
      const result = parsed(fetched.value);
      expect(result.truncated_by).toContain("max_total_bytes");
      expect(script(result, `${site.origin}/app/big.js`).content).toMatchObject(
        { state: "unavailable", reason: "limit" },
      );
      expect(
        result.limitations.some((text) =>
          text.includes("max_total_bytes (1024)"),
        ),
      ).toBe(true);
    } finally {
      await site.close();
    }
  });
});

describe("browserless website script fetch: input and target errors", () => {
  const page = "https://app.example.test/";

  it("rejects caller mistakes before any request and without echoing credentials", async () => {
    const requested: string[] = [];
    const host = { fetch: fakeFetch({}, requested) };
    const relative = await fetchWebScripts(
      { page_url: page, output_directory: "relative/output" },
      {},
      host,
    );
    if (relative.ok) throw new Error("Expected rejection");
    expect(relative.error).toBeInstanceOf(AnalysisInputError);
    if (relative.error instanceof AnalysisInputError)
      expect(relative.error.issues[0]?.path).toEqual(["output_directory"]);

    const credentials = await fetchWebScripts(
      {
        page_url: "https://user:secret@app.example.test/",
        output_directory: await outputDirectory(),
      },
      {},
      host,
    );
    if (credentials.ok) throw new Error("Expected rejection");
    expect(credentials.error).toBeInstanceOf(AnalysisInputError);
    if (credentials.error instanceof AnalysisInputError) {
      expect(credentials.error.issues[0]?.path).toEqual(["page_url"]);
      expect(JSON.stringify(credentials.error.issues)).not.toContain("secret");
    }

    const origins = await fetchWebScripts(
      {
        page_url: page,
        output_directory: await outputDirectory(),
        allowed_origins: ["https://cdn.example.test"],
      },
      {},
      host,
    );
    if (origins.ok) throw new Error("Expected rejection");
    expect(origins.error).toBeInstanceOf(AnalysisInputError);
    if (origins.error instanceof AnalysisInputError)
      expect(origins.error.issues[0]?.path).toEqual(["allowed_origins"]);
    expect(requested).toEqual([]);
  });

  it("claims the output directory before fetching and reports page failures with their reason", async () => {
    const requested: string[] = [];
    const existing = await outputDirectory();
    await mkdir(existing, { recursive: true });
    const occupied = await fetchWebScripts(
      { page_url: page, output_directory: existing },
      {},
      { fetch: fakeFetch({ [page]: html("<html></html>") }, requested) },
    );
    if (occupied.ok) throw new Error("Expected rejection");
    expect(occupied.error).toBeInstanceOf(WebScriptFetchError);
    expect(requested).toEqual([]);

    const missing = await fetchWebScripts(
      { page_url: page, output_directory: await outputDirectory() },
      {},
      { fetch: fakeFetch({}, requested) },
    );
    if (missing.ok) throw new Error("Expected rejection");
    expect(missing.error).toBeInstanceOf(WebScriptFetchError);
    if (missing.error instanceof WebScriptFetchError) {
      expect(missing.error.reason).toBe("unavailable");
      expect(missing.error.userMessage).toContain("HTTP 404");
    }

    const offOrigin = await fetchWebScripts(
      { page_url: page, output_directory: await outputDirectory() },
      {},
      {
        fetch: fakeFetch(
          {
            [page]: () =>
              new Response(null, {
                status: 302,
                headers: { location: "https://elsewhere.example.test/" },
              }),
          },
          requested,
        ),
      },
    );
    if (offOrigin.ok) throw new Error("Expected rejection");
    expect(offOrigin.error).toBeInstanceOf(WebScriptFetchError);
    if (offOrigin.error instanceof WebScriptFetchError)
      expect(offOrigin.error.userMessage).toContain("left the allowed origins");
    expect(requested).not.toContain("https://elsewhere.example.test/");
  });
});

describe("browserless website script fetch: resilience", () => {
  const page = "https://app.example.test/";

  it("keeps other scripts when one body fails, and refuses HTML served as a script", async () => {
    const requested: string[] = [];
    const broken = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("export const b = "));
            controller.error(new TypeError("terminated"));
          },
        }),
        { status: 200, headers: { "content-type": "text/javascript" } },
      );
    const fetched = await fetchWebScripts(
      { page_url: page, output_directory: await outputDirectory() },
      {},
      {
        fetch: fakeFetch(
          {
            [page]: html(
              '<script src="/a.js"></script><script src="/b.js"></script><script src="/spa-fallback.js"></script><script src="/broken-syntax.js"></script>',
            ),
            [`${page}a.js`]: js("export const a = 1;\n"),
            [`${page}b.js`]: broken,
            [`${page}spa-fallback.js`]: html("<!doctype html><html></html>"),
            [`${page}broken-syntax.js`]: js(
              "import './x.js'; export const = ;",
            ),
          },
          requested,
        ),
      },
    );
    if (!fetched.ok) throw fetched.error;
    const result = parsed(fetched.value);
    expect(result.completeness).toBe("partial");
    expect(script(result, `${page}a.js`).content.state).toBe("exported");
    expect(script(result, `${page}b.js`).content).toMatchObject({
      state: "unavailable",
      reason: "fetch_failed",
    });
    expect(script(result, `${page}spa-fallback.js`).content).toMatchObject({
      state: "unavailable",
      reason: "not_javascript",
    });
    expect(
      result.discovery.partial_parses + result.discovery.parse_failures,
    ).toBe(1);
    expect(result.limitations.some((text) => text.includes("syntax"))).toBe(
      true,
    );
  });

  it("honours follow_imports: false and dedupes a self-importing JavaScript entry page", async () => {
    const requested: string[] = [];
    const noFollow = await fetchWebScripts(
      {
        page_url: page,
        output_directory: await outputDirectory(),
        follow_imports: false,
      },
      {},
      {
        fetch: fakeFetch(
          { [page]: html('<script>import("./x.js");</script>') },
          requested,
        ),
      },
    );
    if (!noFollow.ok) throw noFollow.error;
    expect(parsed(noFollow.value).discovery.import_specifiers).toBe(0);
    expect(requested).toEqual([page]);

    const entry = `${page}entry.js`;
    const entryRequests: string[] = [];
    const selfImport = await fetchWebScripts(
      { page_url: entry, output_directory: await outputDirectory() },
      {},
      {
        fetch: fakeFetch(
          { [entry]: js("import './entry.js';\nexport const entry = 1;\n") },
          entryRequests,
        ),
      },
    );
    if (!selfImport.ok) throw selfImport.error;
    const result = parsed(selfImport.value);
    expect(result.scripts).toHaveLength(1);
    expect(result.scripts[0]?.source.discovered_by).toBe("entry-page");
    expect(entryRequests).toEqual([entry]);
  });

  it("cancels cleanly mid-walk, leaving no output behind", async () => {
    const controller = new AbortController();
    const output = await outputDirectory();
    const cancelled = await fetchWebScripts(
      { page_url: page, output_directory: output },
      { signal: controller.signal },
      {
        fetch: fakeFetch(
          {
            [page]: html(
              '<script src="/a.js"></script><script src="/b.js"></script>',
            ),
            [`${page}a.js`]: js("export const a = 1;\n"),
            [`${page}b.js`]: js("export const b = 1;\n"),
          },
          [],
          (url) => {
            if (url.endsWith("/b.js")) controller.abort();
          },
        ),
      },
    );
    if (cancelled.ok) throw new Error("Expected cancellation");
    expect(cancelled.error._tag).toBe("AnalysisCancelledError");
    await expect(access(output)).rejects.toThrow();
  });
});

describe("browserless website script fetch: archive snapshots", () => {
  const snapshot =
    "https://web.archive.org/web/20260219070517/https://studio.example.test/";
  const raw = "https://web.archive.org/web/20260219070517id_/";
  const original = "https://studio.example.test/";

  it("fetches archived bytes raw, keeps root-relative imports inside the archive, and follows archive-internal redirects", async () => {
    const requested: string[] = [];
    const fetched = await fetchWebScripts(
      { page_url: snapshot, output_directory: await outputDirectory() },
      {},
      {
        fetch: fakeFetch(
          {
            [`${raw}${original}`]: html(
              '<html><body><script>import("./_app/start.js");</script></body></html>',
            ),
            [`${raw}${original}_app/start.js`]: () =>
              new Response(null, {
                status: 302,
                headers: {
                  location: `https://web.archive.org/web/20260101000000id_/${original}_app/start.js`,
                },
              }),
            [`https://web.archive.org/web/20260101000000id_/${original}_app/start.js`]:
              js(
                "import '/_app/chunk.js';\nimport '/_app/live.js';\nexport {};\n",
              ),
            [`${raw}${original}_app/live.js`]: () =>
              new Response(null, {
                status: 302,
                headers: { location: `${original}_app/live.js` },
              }),
          },
          requested,
        ),
      },
    );
    if (!fetched.ok) throw fetched.error;
    expect(fetched.value.authority).toBe("historical-reference");
    const result = parsed(fetched.value);
    expect(result.archive_snapshot).toEqual({
      archive_origin: "https://web.archive.org",
      timestamp: "20260219070517",
      original_url: original,
    });
    expect(result.allowed_origins).toEqual(["https://studio.example.test"]);
    expect(requested).toEqual([
      `${raw}${original}`,
      `${raw}${original}_app/start.js`,
      `https://web.archive.org/web/20260101000000id_/${original}_app/start.js`,
      `${raw}${original}_app/chunk.js`,
      `${raw}${original}_app/live.js`,
    ]);
    expect(script(result, `${original}_app/start.js`)).toMatchObject({
      content: {
        state: "exported",
        relative_path: expect.stringMatching(
          /^origins\/[0-9a-f]{64}\/_app\/start\.js$/u,
        ),
      },
      source: {
        fetched_url: `https://web.archive.org/web/20260101000000id_/${original}_app/start.js`,
      },
    });
    expect(script(result, `${original}_app/chunk.js`)).toMatchObject({
      content: { state: "unavailable", reason: "http_status" },
      source: { discovered_by: "static_import", status: 404 },
    });
    expect(script(result, `${original}_app/live.js`).content).toMatchObject({
      state: "unavailable",
      reason: "policy_filtered",
    });
    expect(requested).not.toContain(`${original}_app/live.js`);
    expect(
      result.limitations.some((text) =>
        text.includes("Internet Archive snapshot"),
      ),
    ).toBe(true);
  });
});

describe("browserless website script fetch: transport edge cases", () => {
  const page = "https://app.example.test/";
  const erroredBody = (status: number) => () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new TypeError("terminated"));
        },
      }),
      { status, headers: { "content-type": "text/plain" } },
    );

  it("survives a non-OK response whose body already errored, and a request that times out", async () => {
    const requested: string[] = [];
    const hanging: typeof fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        const url = requestUrl(input);
        requested.push(url);
        if (url === page) {
          resolveWith(
            html(
              '<script src="/gone.js"></script><script src="/slow.js"></script><script src="/ok.js"></script>',
            )(),
          );
          return;
        }
        if (url === `${page}gone.js`) {
          resolveWith(erroredBody(404)());
          return;
        }
        if (url === `${page}ok.js`) {
          resolveWith(js("export const ok = 1;\n")());
          return;
        }
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
        function resolveWith(response: Response): void {
          _resolve(response);
        }
      })) as typeof fetch;
    const fetched = await fetchWebScripts(
      {
        page_url: page,
        output_directory: await outputDirectory(),
        request_timeout_ms: 100,
      },
      {},
      { fetch: hanging },
    );
    if (!fetched.ok) throw fetched.error;
    const result = parsed(fetched.value);
    expect(result.completeness).toBe("partial");
    expect(script(result, `${page}gone.js`).content).toMatchObject({
      state: "unavailable",
      reason: "http_status",
    });
    expect(script(result, `${page}slow.js`).content).toMatchObject({
      state: "unavailable",
      reason: "timeout",
    });
    expect(script(result, `${page}ok.js`).content.state).toBe("exported");
  });

  it("explains an entry page that is neither HTML nor JavaScript and leaves nothing behind after a page failure", async () => {
    const requested: string[] = [];
    const plain = await fetchWebScripts(
      { page_url: page, output_directory: await outputDirectory() },
      {},
      {
        fetch: fakeFetch(
          {
            [page]: () =>
              new Response("just text", {
                status: 200,
                headers: { "content-type": "text/plain" },
              }),
          },
          requested,
        ),
      },
    );
    if (!plain.ok) throw plain.error;
    const result = parsed(plain.value);
    expect(result.scripts).toEqual([]);
    expect(
      result.limitations.some((text) =>
        text.includes("neither HTML nor JavaScript"),
      ),
    ).toBe(true);

    const output = await outputDirectory();
    const failed = await fetchWebScripts(
      { page_url: page, output_directory: output },
      {},
      { fetch: fakeFetch({ [page]: erroredBody(500) }, requested) },
    );
    if (failed.ok) throw new Error("Expected rejection");
    expect(failed.error).toBeInstanceOf(WebScriptFetchError);
    await expect(access(output)).rejects.toThrow();
  });

  it("redacts credentials embedded in markup URLs and names the refused origin on redirects", async () => {
    const requested: string[] = [];
    const fetched = await fetchWebScripts(
      { page_url: page, output_directory: await outputDirectory() },
      {},
      {
        fetch: fakeFetch(
          {
            [page]: html(
              '<script src="https://user:pw@app.example.test/x.js"></script><script src="/moved.js"></script>',
            ),
            [`${page}moved.js`]: () =>
              new Response(null, {
                status: 302,
                headers: { location: "https://cdn.example.test/moved.js" },
              }),
          },
          requested,
        ),
      },
    );
    if (!fetched.ok) throw fetched.error;
    const result = parsed(fetched.value);
    expect(result.discovery.unresolved_specifiers).toEqual([
      {
        referrer_url: page,
        specifier: "https://[redacted]@app.example.test/x.js",
        reason: "embedded_credentials",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("user:pw");
    const moved = script(result, `${page}moved.js`).content;
    expect(moved).toMatchObject({
      state: "unavailable",
      reason: "policy_filtered",
    });
    if (moved.state === "unavailable")
      expect(moved.message).toContain("https://cdn.example.test");
    expect(requested).not.toContain("https://cdn.example.test/moved.js");
  });
});
