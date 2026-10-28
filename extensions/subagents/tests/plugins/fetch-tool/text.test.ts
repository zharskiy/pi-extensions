import { describe, expect, it } from "vitest";
import { pageText, readableText } from "../../../core/fetch-tool/text.ts";

describe("readableText", () => {
  it("extracts the title and drops the head", () => {
    const page = readableText(
      "<html><head><title> Hello &amp; welcome </title><meta charset=utf-8></head><body><p>Body</p></body></html>",
    );

    expect(page.title).toBe("Hello & welcome");
    expect(page.text).toBe("Body");
  });

  it("has no title when none is present", () => {
    expect(readableText("<p>x</p>").title).toBeUndefined();
  });

  it("removes script, style, noscript, svg, template and comments", () => {
    const page = readableText(
      "<p>a</p><script>var x = 1;</script><style>p{color:red}</style><noscript>no</noscript><svg><path d='x'/></svg><template><b>t</b></template><!-- hidden --><p>b</p>",
    );

    expect(page.text).toBe("a\nb");
  });

  it("turns block tags into line breaks", () => {
    expect(readableText("<h1>T</h1><div>one</div>two<br>three<p>four</p>").text).toBe(
      "T\none\ntwo\nthree\nfour",
    );
  });

  it("renders list items as lines", () => {
    expect(readableText("<ul><li>a</li><li>b <b>bold</b></li></ul>").text).toBe("- a\n- b bold");
  });

  it("decodes named and numeric entities", () => {
    expect(readableText("<p>&lt;a&gt; &amp; &quot;q&quot; &#65;&#x42; &unknown; &#0;</p>").text).toBe(
      '<a> & "q" AB &unknown; &#0;',
    );
  });

  it("collapses whitespace and blank lines", () => {
    expect(readableText("<p>a    \t b</p>\n\n\n\n<p>   c   </p>").text).toBe("a b\nc");
  });
});

describe("readableText tables and cut bodies", () => {
  it("separates table cells", () => {
    const text = readableText(
      "<table><tr><td>a</td><td>b</td></tr><tr><th>c</th><th>d</th></tr></table>",
    ).text;

    expect(text).not.toContain("ab");
    expect(text).toContain("a");
    expect(text).toMatch(/a\s*\|\s*b/);
    expect(text).toMatch(/c\s*\|\s*d/);
  });

  it("strips an unterminated trailing script or style", () => {
    expect(readableText("<p>kept</p><script>var x = 1; if (a <").text).toBe("kept");
    expect(readableText("<p>kept</p><style>p { color: red").text).toBe("kept");
  });
});

describe("pageText", () => {
  it("reads html and a missing content type as html", () => {
    expect(pageText("<p>x</p>", "text/html; charset=utf-8").text).toBe("x");
    expect(pageText("<p>x</p>", "").text).toBe("x");
  });

  it("passes plain text, markdown and json through", () => {
    expect(pageText("# <b>T</b>\n", "text/markdown").text).toBe("# <b>T</b>");
    expect(pageText('{"a":1}', "application/json").text).toBe('{"a":1}');
    expect(pageText("plain", "text/plain").text).toBe("plain");
  });
});
