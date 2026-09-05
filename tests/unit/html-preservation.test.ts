import { expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { htmlAdapter } from "@/adapters/document-parsers/adapters/html-adapter";

vi.mock("dompurify", async () => {
  const actual = await vi.importActual<typeof import("dompurify")>("dompurify");
  return { default: actual.default(new JSDOM("").window) };
});

it.each([
  [
    "<div>Obligación principal</div><p>Información secundaria</p>",
    "Obligación principal Información secundaria",
  ],
  [
    "<ul><li><p>Debe presentar la declaración.</p></li></ul><p>Fin.</p>",
    "Debe presentar la declaración. Fin.",
  ],
  [
    "<div>Texto antes<p>Párrafo central</p>Texto después</div>",
    "Texto antes Párrafo central Texto después",
  ],
  [
    "<blockquote>Intro<p>Contenido citado</p>Cierre</blockquote>",
    "Intro Contenido citado Cierre",
  ],
  [
    "<ul><li>Uno<a href='/'> enlace</a><ul><li><p>Dos</p></li></ul>Tres</li></ul>",
    "Uno enlace Dos Tres",
  ],
  ["Antes<table><tr><td>Celda</td></tr></table>Después", "Antes Celda Después"],
  [
    "Fuera<article><section><div>Dentro <b>en línea</b><p>Centro</p>Final</div></section></article>Cierre",
    "Fuera Dentro en línea Centro Final Cierre",
  ],
])("preserves every text owner in order: %s", async (html, expected) => {
  const doc = await htmlAdapter.load(new File([html], "test.html"), {
    id: "preservation",
    name: "test.html",
  });
  expect(
    doc.blocks
      .map((b) => b.text)
      .join(" ")
      .replace(/\s+/g, " "),
  ).toBe(expected);
  expect(doc.blocks.every((b) => b.sourceRef?.startsWith("html:"))).toBe(true);
  expect(doc.blocks.map((b) => b.order)).toEqual(doc.blocks.map((_, i) => i));
});

it("preserves semantic owners, inline adjacency and sanitized inert content", async () => {
  const doc = await htmlAdapter.load(
    new File(
      [
        '<ul><li><p>Debe <a href="javascript:alert(1)">presentar</a> la declaración.</p></li></ul><blockquote><p>Cita</p></blockquote><p>pre<b>fi</b>jo</p><style>BAD_STYLE</style><script>BAD_SCRIPT</script>',
      ],
      "owners.html",
    ),
    { id: "owners", name: "owners.html" },
  );
  expect(doc.blocks.map((b) => [b.type, b.text])).toEqual([
    ["list-item", "Debe presentar la declaración."],
    ["quote", "Cita"],
    ["paragraph", "prefijo"],
  ]);
});

it("preserves text through 200 nested structural containers", async () => {
  const html =
    "Antes " +
    "<div><section><article>".repeat(200) +
    "Centro" +
    "</article></section></div>".repeat(200) +
    " Después";
  const doc = await htmlAdapter.load(new File([html], "deep.html"), {
    id: "deep",
    name: "deep.html",
  });
  expect(doc.blocks.map((b) => b.text).join(" ")).toBe("Antes Centro Después");
});
