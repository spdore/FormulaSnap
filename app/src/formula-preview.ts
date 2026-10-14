import katex from "katex";

export type FormulaRenderResult = { html: string; error: string | null };

export function renderFormulaPreview(latex: string): FormulaRenderResult {
  if (!latex.trim()) return { html: "", error: null };
  try {
    return {
      html: katex.renderToString(latex, {
        displayMode: true,
        output: "htmlAndMathml",
        throwOnError: true,
        strict: "ignore"
      }),
      error: null
    };
  } catch (reason) {
    return { html: "", error: reason instanceof Error ? reason.message : "公式语法无法预览。" };
  }
}