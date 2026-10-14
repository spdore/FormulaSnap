import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import {
  renderFormulaMathml,
  renderFormulaOmml,
  renderPlainFormula,
  createEditableWordDocument,
} from './formats';

function assertWellFormedXml(xml: string): void {
  const tokens = xml.match(/<\?[^>]*\?>|<!--[^]*?-->|<[^>]+>|[^<]+/g) ?? [];
  const stack: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      const name = token.match(/^<\/([\w:.-]+)>$/)?.[1];
      expect(name, `Malformed closing tag: ${token}`).toBeTruthy();
      expect(stack.pop(), `Mismatched closing tag: ${token}`).toBe(name);
    } else if (token.startsWith('<')) {
      const name = token.match(/^<([\w:.-]+)(?:\s|\/?>)/)?.[1];
      expect(name, `Malformed opening tag: ${token}`).toBeTruthy();
      if (!token.endsWith('/>')) stack.push(name!);
    }
  }
  expect(stack).toEqual([]);
}

async function readDocumentXml(latex: string): Promise<string> {
  const blob = await createEditableWordDocument(latex);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const parts = await Promise.all([
    zip.file('[Content_Types].xml')?.async('string'),
    zip.file('_rels/.rels')?.async('string'),
    zip.file('word/document.xml')?.async('string')
  ]);
  expect(parts.every(Boolean)).toBe(true);
  for (const part of parts) {
    assertWellFormedXml(part!);
    expect(part!.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, '')).not.toContain('&');
  }
  const xml = parts[2]!;
  expect(xml).toContain('<w:document');
  expect(xml).toContain('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"');
  expect(xml).toContain('<m:oMathPara>');
  return xml;
}

function count(xml: string, tag: string): number {
  return (xml.match(new RegExp(`<${tag}(?:\\s|>)`, 'g')) ?? []).length;
}


function directChildCount(xml: string, parentName: string, childName: string): number {
  const tokens = xml.match(/<\?[^>]*\?>|<!--[^]*?-->|<[^>]+>/g) ?? [];
  const stack: string[] = [];
  let total = 0;
  for (const token of tokens) {
    if (token.startsWith('<?') || token.startsWith('<!--') || token.startsWith('<!')) continue;
    if (token.startsWith('</')) {
      stack.pop();
      continue;
    }
    const name = token.match(/^<([\w:.-]+)(?:\s|\/?>)/)?.[1];
    if (!name) continue;
    if (stack.at(-1) === parentName && name === childName) total += 1;
    if (!token.endsWith('/>')) stack.push(name);
  }
  return total;
}
describe('formula format conversion', () => {
  it('renders fractions, radicals, scripts, and Greek symbols in MathML', () => {
    const mathml = renderFormulaMathml('\\frac{x_1^2}{\\sqrt{\\pi}}+\\alpha');
    expect(mathml).toContain('<mfrac>');
    expect(mathml).toContain('<msubsup>');
    expect(mathml).toContain('<msqrt>');
    expect(mathml).toContain('α');
  });

  it('renders matrices and cases in MathML', () => {
    expect(renderFormulaMathml('\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}')).toContain('<mtable');
    expect(renderFormulaMathml('\\begin{cases}x&x>0\\\\0&x\\le 0\\end{cases}')).toContain('<mtable');
  });

  it('converts common formulas to readable plain text', () => {
    const text = renderPlainFormula('\\frac{x_1^2}{y}+\\sum_{i=1}^{n} i');
    expect(text).toContain('(x_(1)^(2))/(y)');
    expect(text).toContain('∑_(i=1)^(n)');
  });

  it('converts a minimal aligned environment as two readable equation rows', () => {
    const text = renderPlainFormula('\\begin{aligned}a&=b\\\\&=c\\end{aligned}');
    const rows = text.split('\n');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('a = b');
    expect(rows[1]).toContain('= c');

    const xml = renderFormulaOmml('\\begin{aligned}a&=b\\\\&=c\\end{aligned}');
    expect(xml).toContain('<m:eqArr>');
    expect(directChildCount(xml, 'm:eqArr', 'm:e')).toBe(2);
    expect(xml).not.toContain('<m:m>');
  });

  it('preserves the combined IG-MSA aligned formula in plain text and editable OMML', async () => {
    const latex = String.raw`\begin{aligned}
\mathcal{O}(\mathrm{IG-MSA}) &= k\cdot[d_k\cdot(d_k\cdot HW)+HW\cdot(d_k\cdot d_k)],\\
&=2HWkd_k^2=2HWk\left(\frac{C}{k}\right)^2=\frac{2HWC^2}{k}.
\end{aligned}`;
    const text = renderPlainFormula(latex);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('𝒪');
    expect(text).toContain('IG-MSA');
    expect(text).toContain('=');
    expect(text).toContain('C');
    expect(text).toContain('k');

    const xml = await readDocumentXml(latex);
    expect(xml).toContain('<m:eqArr>');
    expect(directChildCount(xml, 'm:eqArr', 'm:e')).toBe(2);
    expect(xml).toContain('<m:f>');
    expect(xml).toContain('<m:sSubSup>');
    expect(xml).toContain('m:val="script"');
    expect(xml).toContain('&amp;');
  });

  it('supports array with a simple column declaration without emitting the declaration', async () => {
    const latex = String.raw`\begin{array}{lcr}a&b&c\\d&e&f\end{array}`;
    const text = renderPlainFormula(latex);
    expect(text).toContain('a');
    expect(text).toContain('c');
    expect(text.split('\n')).toHaveLength(2);
    expect(text).not.toContain('lcr');

    const xml = await readDocumentXml(latex);
    expect(count(xml, 'm:mr')).toBe(2);
    expect(count(xml, 'm:mc')).toBe(3);
    expect(xml).toContain('m:mcJc m:val="left"');
    expect(xml).toContain('m:mcJc m:val="center"');
    expect(xml).toContain('m:mcJc m:val="right"');
  });

  it('supports nested fractions, matrices, and cases inside aligned rows', async () => {
    const latex = String.raw`\begin{aligned}x&=\frac{1}{\begin{cases}a&b\\c&d\end{cases}}\\y&=\begin{pmatrix}1&0\\0&1\end{pmatrix}\end{aligned}`;
    const text = renderPlainFormula(latex);
    expect(text).toContain('x =');
    expect(text).toContain('y =');
    expect(text).toContain('a');
    expect(text).toContain('d');
    expect(text).toContain('1');
    expect(text).toContain('a | b');
    expect(text).toContain('c | d');
    expect(text).toContain('1 | 0');

    const xml = await readDocumentXml(latex);
    expect(xml).toContain('<m:eqArr>');
    expect(xml).toContain('<m:f>');
    expect(xml).toContain('<m:d>');
    expect(xml).toContain('<m:m>');
  });

  it('preserves math fonts, text spacing, escaped separators, scripts, and delimiters', () => {
    const text = renderPlainFormula(String.raw`\mathcal{O}_{i}^{2}+\left(\mathrm{A B}\&\text{hello world}\right)`);
    expect(text).toContain('𝒪_(i)^(2)');
    expect(text).toContain('A B');
    expect(text).toContain('&');
    expect(text).toContain('hello world');
    expect(text).toContain('(');
    expect(text).toContain(')');
  });

  it('converts hat accents to readable plain text without losing their scope', () => {
    expect(renderPlainFormula(String.raw`\hat{x}+\hat{xy}_{i}`)).toBe('x̂+hat(xy)_(i)');
    expect(renderPlainFormula(String.raw`\hat{\frac{x_1}{y}}`)).toBe('hat((x_(1))/(y))');
  });

  it('serializes hat accents as editable Office Math accent nodes', async () => {
    const xml = await readDocumentXml(String.raw`\hat{x_i^2}+\begin{aligned}\hat{a}&=\hat{b}\\&=c\end{aligned}`);
    expect(count(xml, 'm:acc')).toBe(3);
    expect(xml).toContain('<m:chr m:val="&#x0302;"/>');
    expect(xml).toContain('<m:accPr>');
    expect(xml).toContain('<m:sSubSup>');
    expect(xml).toContain('<m:eqArr>');
  });
  it('serializes matrices as editable OMML structures', async () => {
    const blob = await createEditableWordDocument('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}+\\frac{1}{2}');
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    const xml = await zip.file('word/document.xml')!.async('string');
    assertWellFormedXml(xml);
    expect(xml).toContain('<m:m>');
    expect(xml).toContain('<m:d>');
    expect(xml).toContain('<m:f>');
    expect(count(xml, 'm:mr')).toBe(2);
  });

  it('keeps alignment, delimiters, and matrix boundaries through both serializers', async () => {
    const aligned = '\\begin{aligned}x_i&=\\left\\{\\frac{a}{b}\\right.\\\\&=\\sqrt[3]{c}\\end{aligned}';
    const plain = renderPlainFormula(aligned);
    expect(plain.split('\n')).toHaveLength(2);
    expect(plain).toContain('x_(i) =');
    expect(plain).toContain('{');
    expect(plain).toContain('root_(3)(c)');

    const xml = await readDocumentXml(aligned);
    expect(xml).toContain('<m:eqArr>');
    expect(xml).toContain('<m:sSub>');
    expect(xml).toContain('<m:d>');
    expect(xml).toContain('<m:rad>');
    expect(xml).toContain('<m:degHide m:val="0"/>');

    const matrixText = renderPlainFormula('\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}');
    expect(matrixText).toContain('a | b');
    expect(matrixText).toContain('c | d');
    expect(matrixText).toMatch(/^\[/);
    expect(matrixText).toMatch(/\]$/);
  });

  it('converts aligned source to MathML through the preview renderer', () => {
    const mathml = renderFormulaMathml('\\begin{aligned}a&=b\\\\&=c\\end{aligned}');
    expect(mathml).toContain('<mtable');
    expect(mathml).toContain('<mtr');
    expect(mathml).toContain('a');
    expect(mathml).toContain('c');
  });
  it('reports unknown environments separately from malformed environment nesting', () => {
    expect(() => renderPlainFormula(String.raw`\begin{gathered}x\end{gathered}`)).toThrow('纯文本转换暂不支持环境 gathered');
    expect(() => renderFormulaOmml(String.raw`\begin{gathered}x\end{gathered}`)).toThrow('Word 转换暂不支持环境 gathered');
    expect(() => renderPlainFormula(String.raw`\begin{aligned}x&=y\end{matrix}`)).toThrow('环境结束标记不匹配：开始为 aligned，结束为 matrix');
    expect(() => renderPlainFormula(String.raw`\begin{aligned}x&=y`)).toThrow('环境结束标记缺失：aligned');
  });

  it('reports malformed braces, unsupported commands, and unsupported array syntax precisely', () => {
    expect(() => renderPlainFormula(String.raw`{x`)).toThrow('花括号未闭合');
    expect(() => renderPlainFormula(String.raw`x}`)).toThrow('多余的结束花括号');
    expect(() => renderPlainFormula(String.raw`\unknowncommand{x}`)).toThrow('纯文本转换暂不支持命令 \\unknowncommand');
    expect(() => renderPlainFormula(String.raw`\begin{array}{|c|c|}a&b\end{array}`)).toThrow('array 列声明暂不支持');
    expect(() => renderPlainFormula(String.raw`\begin{aligned}a&=b\\[2pt]c&=d\end{aligned}`)).toThrow('行距参数暂不支持');
  });
  it('preserves empty array cells and reports Word-specific unsupported syntax', async () => {
    const source = '\\begin{array}{cc}&x\\\\y&\\end{array}';
    const plain = renderPlainFormula(source);
    expect(plain).toContain('| x');
    expect(plain).toContain('y |');

    const xml = await readDocumentXml(source);
    expect(xml).toContain('<m:e></m:e>');
    expect(xml).toContain('<m:mcJc');

    expect(() => renderFormulaOmml('\\unknowncommand{x}')).toThrow('Word 转换暂不支持命令 \\unknowncommand');
    expect(() => renderFormulaOmml('\\begin{gathered}x\\end{gathered}')).toThrow('Word 转换暂不支持环境 gathered');
  });
});





