# Browserless website script fetch and static JavaScript analysis

`fetch_web_scripts` retrieves one page and its JavaScript over plain HTTP, with no
browser, cookies, or credentials, and writes the result into the same verified
layout that [`export_web_scripts`](website-script-export.md) produces. Both CLI
and MCP use the same workflow. The output feeds the existing local JavaScript
analyzer unchanged.

Use it when the question is "what code does this site ship?" and you have a URL
but no logged-in session to observe. Use `inspect_web_page` or
`capture_browser_scenario` instead when the page needs authentication or runs
JavaScript before its real code loads.

## Fetch and analyze

```sh
rea fetch-web-scripts https://app.example.test/ /analysis/fetched-scripts --json
rea analyze-javascript-application /analysis/fetched-scripts/files --json
```

MCP uses `fetch_web_scripts` with `page_url` and an absolute, absent
`output_directory`. The inline result includes `analysis_input`, which can be
passed directly to `analyze_javascript_application`. When no script bytes were
fetchable, `analysis_input` is null and every script keeps its unavailable
reason.

Options:

- `allowed_origins`: exact HTTP(S) origins whose scripts may be fetched. The
  default is the page's own origin, and the list must include it. Scripts on
  other origins are listed as unresolved with reason `outside_allowed_origins`,
  never fetched, and a redirect that leaves the allowed origins is recorded as
  `policy_filtered` without requesting the target. A `page_url` with embedded
  credentials is rejected before any request.
- `follow_imports` (default true): parse inline and fetched scripts for literal
  `import`, `import()`, and unbound `require` specifiers and fetch the
  resolvable ones. Bare specifiers such as `lodash` are reported as unresolved;
  nothing guesses a package registry or import map. Scripts that fail to parse,
  or parse only with recovered syntax errors, are counted in `discovery` and
  noted as a limitation because their imports may be missing.
- `max_scripts` (default 200) and `max_total_bytes` (default 64 MiB) bound the
  walk. Hitting a bound sets `completeness: "truncated"`, names the bound in
  `truncated_by` and in a limitation, and lists every discovered but unfetched
  script as `unavailable` with reason `limit`.
- `request_timeout_ms` (default 15 s) covers one request's redirects and body,
  for the page and for each script. A script that times out, or whose body
  read fails, is recorded as `unavailable` with reason `timeout` or
  `fetch_failed`; the other scripts are kept. Only a failing page request fails
  the whole operation. A redirect that leaves the allowed origins is recorded
  as `policy_filtered` with the refused origin named, so you can add it to
  `allowed_origins` deliberately.

`completeness` is `complete` only when every discovered script was fetched and
parsed in full. It is `partial` when any script is unavailable for any reason or
could not be fully parsed, and `truncated` when a bound stopped the walk;
`truncated` takes precedence and `truncated_by` names the bound.

The output directory is claimed before the first request, so an existing path
is rejected without any network traffic, and partial output is rolled back on
every failure.

## Archive snapshots

`page_url` may be a Wayback Machine snapshot such as
`https://web.archive.org/web/20260219070517/https://app.example.test/`. REA
fetches the archived bytes with the archive's `id_` modifier, so they are not
rewritten, resolves every relative and root-relative import against the archived
original URL, and re-addresses it inside the same snapshot. `allowed_origins`
applies to the archived original origins, not to the archive host. Captures the
archive never stored come back as `unavailable` with reason `http_status`, and
the Evidence authority is `historical-reference` rather than `shipped-artifact`.

## Output layout

The destination must not exist. REA creates private output, verifies every file
by digest and durable readback, and removes its own partial output on failure or
cancellation. A failed rollback reports residual paths.

- `page.html`: the fetched document bytes, with their digest, status, and
  content type in the manifest.
- `files/origins/<sha256(origin)>/<path>.js`: scripts whose URL path is an
  ordinary, unambiguous module path, preserving relative module layout.
- `files/isolated/source-<n>-<sha256>.js`: inline scripts, query variants,
  collisions, and unrepresentable paths, each with a stated reason.
- `manifest.json`: the same fields as the inline result, excluding its own
  descriptor.

Every script records how it was discovered (`script-src`, `modulepreload`,
`preload`, `inline-script`, `static_import`, `dynamic_import`, `require`, or
`entry-page` when the URL itself served JavaScript), its referrer, the final URL
after any redirect inside the allowed origins, the HTTP status, and the content
type. Markup URLs resolve as plain URLs against the document base, so a
path-relative `src="app.js"` is fetched; import specifiers follow module rules,
so a bare `app.js` import is reported, not guessed. A script URL that returns an
HTML document, as single-page servers do for missing assets, is recorded as
`not_javascript` instead of being exported as code. Discovery counts and every
skipped markup reference (import maps, non-JavaScript script types) are returned
so missing code is explained rather than silent.

## Interpretation and limits

Fetched bytes show what the server sent to this client at fetch time. They do
not prove execution, and an authenticated or script-rendered page may load code
that a plain GET never sees. Markup discovery is a conservative scan of
`<script src>`, inline `<script>`, and `<link rel="modulepreload">`; scripts
injected at runtime and non-literal dynamic specifiers are not followed. Import
maps are reported as skipped. This operation fetches no source maps;
`analyze_web_bundle` fetches declared source maps from a live page when asked,
and the local analyzer still records `sourceMappingURL` directives it finds in
the fetched files.

The fetch Evidence describes the retrieved artifact. Subsequent
application-analysis Evidence describes the local exported directory. Their
identities and authorities remain separate.

## Verification

`tests/boundary/filesystem/webScriptFetch.test.ts` serves a fixture site on a
loopback port and checks page and script digests, path-relative and preloaded
markup URLs, redirect handling inside the allowed origin, refusal of other
origins and of off-origin redirects, inline script isolation, literal import
following, both truncation bounds, per-script body failures, HTML served as a
script, cancellation with rollback, input rejection before any request, and
archive snapshot addressing with archive-internal redirects through an injected
fetch host. The real-browser lanes are unaffected because this workflow uses no
browser.
