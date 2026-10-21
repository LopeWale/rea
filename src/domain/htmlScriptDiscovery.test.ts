import { describe, expect, it } from "vitest";

import { discoverHtmlScripts } from "./htmlScriptDiscovery.js";

const page = "https://app.example.test/dashboard/index.html";

describe("HTML script discovery", () => {
  it("reads external, inline, and preloaded scripts without rendering", () => {
    const html = `<!doctype html><html><head>
      <link rel="modulepreload" href="/_app/chunk.js">
      <link rel="preload" as="script" href="./vendor.js">
      <link rel="stylesheet" href="/styles.css">
      <script type="module" src="/_app/start.js"></script>
      <script src='legacy.js?v=2&amp;x=1' nomodule></script>
      <script type="application/json" id="data">{"a":1}</script>
      <script type="importmap">{"imports":{"lib":"/lib.js"}}</script>
      <script>window.__boot = 1; import("./_app/lazy.js");</script>
      <script type="module">   </script>
    </head><body></body></html>`;
    const result = discoverHtmlScripts(html, page);
    expect(result.base_url).toBe(page);
    expect(result.external).toEqual([
      {
        specifier: "/_app/start.js",
        discovered_by: "script-src",
        is_module: true,
      },
      {
        specifier: "legacy.js?v=2&x=1",
        discovered_by: "script-src",
        is_module: false,
      },
      {
        specifier: "/_app/chunk.js",
        discovered_by: "modulepreload",
        is_module: true,
      },
      { specifier: "./vendor.js", discovered_by: "preload", is_module: false },
    ]);
    expect(result.inline).toEqual([
      {
        index: 0,
        text: 'window.__boot = 1; import("./_app/lazy.js");',
        is_module: false,
      },
    ]);
    expect(result.skipped.map(({ reason }) => reason)).toEqual([
      "non_javascript_type",
      "importmap",
    ]);
  });

  it("honours the first <base> that has an href and ignores commented-out markup", () => {
    const html = `<html><head><base target="_blank"><base href="/nested/app/">
      <!-- <script src="/commented.js"></script> -->
      <script src="main.js"></script></head></html>`;
    const result = discoverHtmlScripts(html, page);
    expect(result.base_url).toBe("https://app.example.test/nested/app/");
    expect(result.external).toEqual([
      { specifier: "main.js", discovered_by: "script-src", is_module: false },
    ]);
  });

  it("treats script bodies as raw text where comment delimiters are content", () => {
    const html = `<script><!-- import("/legacy.js") //--></script>
      <script>var a = "<!--";</script>
      <script src="/a.js"></script>
      <script>var b = "-->";</script>
      <script>var s = '<link rel="modulepreload" href="/fake.js">';</script>`;
    const result = discoverHtmlScripts(html, page);
    expect(result.inline.map(({ text }) => text)).toEqual([
      '<!-- import("/legacy.js") //-->',
      'var a = "<!--";',
      'var b = "-->";',
      `var s = '<link rel="modulepreload" href="/fake.js">';`,
    ]);
    expect(result.external).toEqual([
      { specifier: "/a.js", discovered_by: "script-src", is_module: false },
    ]);
  });

  it("keeps indices on the original text, so non-ASCII prose cannot hide later scripts", () => {
    const result = discoverHtmlScripts(
      '<p>İstanbul</p><script src="/a.js"></script><script>var x = 1;</script>',
      page,
    );
    expect(result.external.map(({ specifier }) => specifier)).toEqual([
      "/a.js",
    ]);
    expect(result.inline.map(({ text }) => text)).toEqual(["var x = 1;"]);
  });

  it("tokenizes tags with quote-aware attributes and tolerates odd comments and end tags", () => {
    const html = `<img alt="<script>" title='<!--'>
      <link rel=modulepreload href=/a.js>
      <script data-x="a>b" src="/main.js"></script>
      <script>var first = 1;</script foo>
      <!--><script>var second = 2;</script>
      <!---><script src="/c.js"></script>`;
    const result = discoverHtmlScripts(html, page);
    expect(result.external).toEqual([
      { specifier: "/main.js", discovered_by: "script-src", is_module: false },
      { specifier: "/c.js", discovered_by: "script-src", is_module: false },
      { specifier: "/a.js", discovered_by: "modulepreload", is_module: true },
    ]);
    expect(result.inline.map(({ text }) => text)).toEqual([
      "var first = 1;",
      "var second = 2;",
    ]);
  });

  it("reports empty script sources instead of guessing a URL", () => {
    const result = discoverHtmlScripts('<script src=""></script>', page);
    expect(result.external).toEqual([]);
    expect(result.skipped).toEqual([
      { reason: "empty_source", detail: '<script src="">' },
    ]);
  });
});
