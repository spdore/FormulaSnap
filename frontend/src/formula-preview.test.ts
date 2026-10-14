import { describe, expect, it } from "vitest";
import { renderFormulaPreview } from "./formula-preview";

describe("renderFormulaPreview", () => {
  it("renders integrals, matrices, and piecewise expressions with KaTeX", () => {
    for (const latex of [
      "\\int_0^\\infty e^{-x^2}\\,dx",
      "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}",
      "f(x)=\\begin{cases}x^2,&x>0\\\\0,&x\\le 0\\end{cases}"
    ]) {
      const result = renderFormulaPreview(latex);
      expect(result.error).toBeNull();
      expect(result.html).toContain("katex");
    }
  });

  it("keeps an invalid formula as source and reports a render error", () => {
    const result = renderFormulaPreview("\\notARealFormulaCommand{");
    expect(result.html).toBe("");
    expect(result.error).toBeTruthy();
  });
});