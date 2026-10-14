import katex from "katex";
import type { OutputFormat } from "./types";

type MathStyle = "script" | "double-struck" | "roman" | "bold" | "italic" | "text";
type ColumnAlignment = "left" | "center" | "right";
type FormulaNode =
  | { kind: "run"; text: string }
  | { kind: "group"; children: FormulaNode[] }
  | { kind: "styled"; style: MathStyle; children: FormulaNode[] }
  | { kind: "fraction"; numerator: FormulaNode[]; denominator: FormulaNode[] }
  | { kind: "radical"; body: FormulaNode[]; degree?: FormulaNode[] }
  | { kind: "accent"; accent: "hat"; children: FormulaNode[] }
  | { kind: "script"; base: FormulaNode[]; sub?: FormulaNode[]; sup?: FormulaNode[] }
  | { kind: "environment"; environment: string; rows: FormulaNode[][][]; columns?: ColumnAlignment[] }
  | { kind: "delimited"; begin: string; end: string; children: FormulaNode[] }
  | { kind: "break" }
  | { kind: "unsupported-command"; command: string };

type Token =
  | { kind: "char"; value: string }
  | { kind: "space"; value: string }
  | { kind: "command"; value: string }
  | { kind: "row" }
  | { kind: "environment-start" | "environment-end"; value: string };

const symbols: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ϵ",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", varpi: "ϖ", rho: "ρ",
  sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ", phi: "φ", varphi: "ϕ",
  chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ",
  Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Upsilon: "Υ", Phi: "Φ",
  Psi: "Ψ", Omega: "Ω", infty: "∞", partial: "∂", nabla: "∇", pm: "±",
  mp: "∓", times: "×", cdot: "⋅", div: "÷", le: "≤", leq: "≤", ge: "≥",
  geq: "≥", neq: "≠", approx: "≈", equiv: "≡", to: "→", rightarrow: "→",
  leftarrow: "←", forall: "∀", exists: "∃", in: "∈", notin: "∉", subset: "⊂",
  cup: "∪", cap: "∩", ldots: "…", cdots: "⋯", ast: "∗", circ: "∘",
  sin: "sin", cos: "cos", tan: "tan", log: "log", ln: "ln", max: "max",
  min: "min", lim: "lim", prod: "∏", sum: "∑", int: "∫", oint: "∮",
  ltimes: "⋉", rtimes: "⋊", land: "∧", lor: "∨", neg: "¬", degree: "°",
  angle: "∠", ell: "ℓ", Re: "ℜ", Im: "ℑ", emptyset: "∅", therefore: "∴",
  because: "∵", mapsto: "↦", iff: "⟺", mid: "∣", parallel: "∥"
};

const plainMathcal: Record<string, string> = {};
Array.from("𝒜ℬ𝒞𝒟ℰℱ𝒢ℋℐ𝒥𝒦ℒℳ𝒩𝒪𝒫𝒬ℛ𝒮𝒯𝒰𝒱𝒲𝒳𝒴𝒵")
  .forEach((value, index) => { plainMathcal[String.fromCharCode(65 + index)] = value; });
Array.from("𝒶𝒷𝒸𝒹ℯ𝒻ℊ𝒽𝒾𝒿𝓀𝓁𝓂𝓃ℴ𝓅𝓆𝓇𝓈𝓉𝓊𝓋𝓌𝓍𝓎𝓏")
  .forEach((value, index) => { plainMathcal[String.fromCharCode(97 + index)] = value; });

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    if (current === "\\") {
      if (index + 1 >= source.length) {
        tokens.push({ kind: "command", value: "\\" });
        index += 1;
        continue;
      }
      if (source[index + 1] === "\\") {
        tokens.push({ kind: "row" });
        index += 2;
        continue;
      }
      const word = source.slice(index + 1).match(/^[A-Za-z]+/)?.[0];
      if (word) {
        index += word.length + 1;
        if (word === "begin" || word === "end") {
          while (/\s/.test(source[index] ?? "")) index += 1;
          if (source[index] !== "{") {
            throw new Error("环境标记格式错误：\\" + word + " 后应为 {环境名}。");
          }
          const closing = source.indexOf("}", index + 1);
          if (closing < 0) throw new Error("环境标记格式错误：缺少环境名的结束花括号。");
          const name = source.slice(index + 1, closing).trim();
          if (!name) throw new Error("环境名称不能为空。");
          tokens.push({ kind: word === "begin" ? "environment-start" : "environment-end", value: name });
          index = closing + 1;
          continue;
        }
        tokens.push({ kind: "command", value: word });
        continue;
      }
      tokens.push({ kind: "command", value: source[index + 1] });
      index += 2;
      continue;
    }
    if (/\s/.test(current)) {
      let end = index + 1;
      while (end < source.length && /\s/.test(source[end])) end += 1;
      tokens.push({ kind: "space", value: source.slice(index, end) });
      index = end;
      continue;
    }
    const codePoint = source.codePointAt(index);
    const value = String.fromCodePoint(codePoint ?? current.charCodeAt(0));
    tokens.push({ kind: "char", value });
    index += value.length;
  }
  return tokens;
}

type SequenceOptions = {
  stopAtBrace?: boolean;
  stopAtCell?: boolean;
  preserveSpaces?: boolean;
  stopAtRight?: boolean;
  stopAtSquareBracket?: boolean;
};

class LatexParser {
  private readonly tokens: Token[];
  private position = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  parse(): FormulaNode[] {
    const nodes = this.sequence({});
    const token = this.peek();
    if (!token) return nodes;
    if (token.kind === "environment-end") {
      throw new Error("环境结束标记没有对应开始：" + token.value);
    }
    if (token.kind === "char" && token.value === "}") {
      throw new Error("多余的结束花括号。");
    }
    if (token.kind === "char" && token.value === "&") {
      throw new Error("对齐符号 & 只能用于受支持的对齐环境；正文中请写 \\&。");
    }
    throw new Error("公式中存在未处理的 LaTeX 语法。");
  }

  private peek(offset = 0): Token | undefined {
    return this.tokens[this.position + offset];
  }

  private skipSpaces(): void {
    while (this.peek()?.kind === "space") this.position += 1;
  }

  private sequence(options: SequenceOptions): FormulaNode[] {
    const nodes: FormulaNode[] = [];
    while (this.position < this.tokens.length) {
      const token = this.peek()!;
      if (options.stopAtBrace && token.kind === "char" && token.value === "}") {
        this.position += 1;
        return nodes;
      }
      if (options.stopAtCell && ((token.kind === "char" && token.value === "&") ||
          token.kind === "row" || token.kind === "environment-end")) return nodes;
      if (options.stopAtRight && token.kind === "command" && token.value === "right") return nodes;
      if (options.stopAtSquareBracket && token.kind === "char" && token.value === "]") {
        this.position += 1;
        return nodes;
      }
      if (token.kind === "char" && token.value === "}") {
        if (options.stopAtBrace) {
          this.position += 1;
          return nodes;
        }
        throw new Error("多余的结束花括号。");
      }
      if (token.kind === "environment-end") {
        if (options.stopAtBrace) throw new Error("花括号未闭合：环境在花括号结束前已关闭。");
        throw new Error("环境结束标记没有对应开始：" + token.value);
      }
      if (token.kind === "space") {
        this.position += 1;
        if (options.preserveSpaces) nodes.push({ kind: "run", text: " " });
        continue;
      }
      if (token.kind === "environment-start") {
        this.position += 1;
        nodes.push(this.environment(token.value));
        continue;
      }
      if (token.kind === "row") {
        this.position += 1;
        nodes.push({ kind: "break" });
        continue;
      }
      if (token.kind === "char" && token.value === "{") {
        this.position += 1;
        nodes.push({ kind: "group", children: this.sequence({
          stopAtBrace: true,
          preserveSpaces: options.preserveSpaces
        }) });
        continue;
      }
      if (token.kind === "char" && (token.value === "^" || token.value === "_")) {
        this.position += 1;
        const argument = this.argument(options.preserveSpaces);
        const previous = nodes.pop();
        if (!previous) throw new Error("上标或下标缺少基符号。");
        const previousScript = previous.kind === "script" ? previous : undefined;
        const script: Extract<FormulaNode, { kind: "script" }> = previousScript
          ? { ...previousScript }
          : { kind: "script", base: [previous] };
        if (token.value === "^") {
          if (script.sup) throw new Error("重复上标无法可靠转换。");
          script.sup = argument;
        } else {
          if (script.sub) throw new Error("重复下标无法可靠转换。");
          script.sub = argument;
        }
        nodes.push(script);
        continue;
      }
      if (token.kind === "command") {
        nodes.push(...this.command(token.value));
        continue;
      }
      if (token.kind === "char" && token.value === "[") {
        this.position += 1;
        nodes.push({ kind: "run", text: "[" });
        continue;
      }
      if (token.kind === "char" && token.value === "]") {
        this.position += 1;
        nodes.push({ kind: "run", text: "]" });
        continue;
      }
      if (token.kind === "char" && token.value === "&" && options.stopAtCell) return nodes;
      this.position += 1;
      nodes.push({ kind: "run", text: token.value });
    }
    if (options.stopAtBrace) throw new Error("花括号未闭合。");
    if (options.stopAtRight) throw new Error("缺少 \\right 分隔符。");
    return nodes;
  }

  private argument(preserveSpaces = false): FormulaNode[] {
    this.skipSpaces();
    const next = this.peek();
    if (!next) throw new Error("命令或上下标缺少参数。");
    if (next.kind === "char" && next.value === "{") {
      this.position += 1;
      return [{ kind: "group", children: this.sequence({ stopAtBrace: true, preserveSpaces }) }];
    }
    if (next.kind === "environment-end" || next.kind === "row" ||
        next.kind === "char" && (next.value === "&" || next.value === "}")) {
      throw new Error("命令或上下标缺少参数。");
    }
    if (next.kind === "command") {
      return this.command(next.value);
    }
    if (next.kind === "environment-start") {
      this.position += 1;
      return [this.environment(next.value)];
    }
    if (next.kind === "space") {
      this.position += 1;
      return [{ kind: "run", text: " " }];
    }
this.position += 1;
    return [{ kind: "run", text: next.value }];
  }

  private command(command: string): FormulaNode[] {
    this.position += 1;
    if (command === "frac" || command === "dfrac" || command === "tfrac") {
      return [{ kind: "fraction", numerator: this.argument(), denominator: this.argument() }];
    }
    if (command === "sqrt") {
      let degree: FormulaNode[] | undefined;
      const possibleDegree = this.peek();
      if (possibleDegree?.kind === "char" && possibleDegree.value === "[") {
        this.position += 1;
        degree = this.sequence({ stopAtSquareBracket: true });
        const closing = this.tokens[this.position - 1];
        if (closing?.kind !== "char" || closing.value !== "]") {
          throw new Error("根号次数缺少结束方括号。");
        }
      }      return [{ kind: "radical", body: this.argument(), degree }];
    }
    if (command === "hat") return [{ kind: "accent", accent: "hat", children: this.argument() }];
    const styles: Record<string, MathStyle> = {
      mathcal: "script", mathbb: "double-struck", mathrm: "roman",
      mathbf: "bold", mathit: "italic", text: "text", operatorname: "roman"
    };
    if (styles[command]) {
      const preserveSpaces = command === "text" || command === "mathrm" || command === "operatorname";
      return [{ kind: "styled", style: styles[command], children: this.argument(preserveSpaces) }];
    }
    if (command === "left") return [this.delimited()];
    if (command === "right") throw new Error("出现没有对应 \\left 的 \\right 分隔符。");
    if (command === "displaystyle" || command === "textstyle" ||
        command === "scriptstyle" || command === "scriptscriptstyle" ||
        command === "limits" || command === "nolimits") return [];
    if (command === " " || command === "," || command === ";" ||
        command === ":" || command === "quad" || command === "qquad" ||
        command === "!" || command === "enspace") {
      return [{ kind: "run", text: command === "!" ? "" : " " }];
    }
    const escaped: Record<string, string> = {
      "{": "{", "}": "}", "%": "%", "&": "&", "_": "_",
      "#": "#", "$": "$", "|": "|", ",": ",", ";": ";"
    };
    if (escaped[command] !== undefined) return [{ kind: "run", text: escaped[command] }];
    const delimiterSymbols: Record<string, string> = {
      langle: "⟨", rangle: "⟩", lbrace: "{", rbrace: "}",
      vert: "|", Vert: "‖", lVert: "‖", rVert: "‖"
    };
    if (delimiterSymbols[command]) return [{ kind: "run", text: delimiterSymbols[command] }];
    if (symbols[command] !== undefined) return [{ kind: "run", text: symbols[command] }];
    return [{ kind: "unsupported-command", command }];
  }

  private delimited(): FormulaNode {
    const begin = this.readDelimiter();
    const children = this.sequence({ stopAtRight: true, preserveSpaces: false });
    const closing = this.peek();
    if (!(closing?.kind === "command" && closing.value === "right")) {
      throw new Error("\\left 分隔符缺少对应的 \\right。");
    }
    this.position += 1;
    const end = this.readDelimiter();
    return { kind: "delimited", begin, end, children };
  }

  private readDelimiter(): string {
    this.skipSpaces();
    const token = this.peek();
    if (!token) throw new Error("\\left 或 \\right 后缺少分隔符。");
    this.position += 1;
    if (token.kind === "char" && ".()[]|".includes(token.value)) return token.value;
    if (token.kind === "command") {
      const values: Record<string, string> = {
        "{": "{", "}": "}", "|": "|", vert: "|", Vert: "‖",
        lVert: "‖", rVert: "‖", langle: "⟨", rangle: "⟩",
        lbrace: "{", rbrace: "}", lfloor: "⌊", rfloor: "⌋",
        lceil: "⌈", rceil: "⌉", slash: "/", backslash: "\\"
      };
      if (values[token.value] !== undefined) return values[token.value];
    }
    const printable = token.kind === "row" ? "\\\\\\\\" : token.kind === "command" ? "\\" + token.value : token.value;
    throw new Error("暂不支持分隔符：" + printable);
  }

  private environment(name: string): FormulaNode {
    const columns = name === "array" ? this.readArrayColumns() : undefined;
    const rows: FormulaNode[][][] = [];
    let cells: FormulaNode[][] = [];

    while (true) {
      if (this.position >= this.tokens.length) throw new Error("环境结束标记缺失：" + name);
      const cell = this.sequence({ stopAtCell: true });
      cells.push(cell);
      const token = this.peek();
      if (!token) throw new Error("环境结束标记缺失：" + name);
      if (token.kind === "char" && token.value === "&") {
        this.position += 1;
        continue;
      }
      if (token.kind === "row") {
        this.position += 1;
        rows.push(cells);
        cells = [];
        const possibleSpacing = this.peek();
        if (possibleSpacing?.kind === "char" && possibleSpacing.value === "[") {
          throw new Error("行距参数暂不支持；请移除 \\[...\\] 行距标记后再转换。");
        }
        const closing = this.peek();
        if (closing?.kind === "environment-end") {
          if (closing.value !== name) this.throwEnvironmentMismatch(name, closing.value);
          this.position += 1;
          this.validateEnvironmentRows(name, rows, columns);
          return { kind: "environment", environment: name, rows, columns };
        }
        continue;
      }
      if (token.kind === "environment-end") {
        if (token.value !== name) this.throwEnvironmentMismatch(name, token.value);
        this.position += 1;
        rows.push(cells);
        this.validateEnvironmentRows(name, rows, columns);
        return { kind: "environment", environment: name, rows, columns };
      }
      throw new Error("环境 " + name + " 中存在无法解析的行或列分隔符。");
    }
  }

  private validateEnvironmentRows(name: string, rows: FormulaNode[][][], columns?: ColumnAlignment[]): void {
    if (columns) {
      const invalid = rows.find((row) => row.length !== columns.length);
      if (invalid) {
        throw new Error("array 列数不匹配：列声明为 " + columns.length + " 列，当前行有 " + invalid.length + " 列。");
      }
    } else if (name !== "aligned" && rows.length > 1) {
      const width = rows[0]?.length ?? 0;
      if (rows.some((row) => row.length !== width)) throw new Error(name + " 环境的各行列数不一致。");
    }
  }

  private readArrayColumns(): ColumnAlignment[] {
    this.skipSpaces();
    const opening = this.peek();
    if (!(opening?.kind === "char" && opening.value === "{")) {
      throw new Error("array 环境需要简单的 {lcr} 列声明。");
    }
    this.position += 1;
    let declaration = "";
    while (this.position < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === "char" && token.value === "}") {
        this.position += 1;
        break;
      }
      if (token.kind !== "char" && token.kind !== "space") {
        throw new Error("array 列声明暂不支持命令、竖线、段落宽度或重复列语法。");
      }
      if (token.kind === "char") declaration += token.value;
      this.position += 1;
    }
    const closing = this.peek(-1);
    if (closing?.kind !== "char" || closing.value !== "}") {
      throw new Error("array 列声明花括号未闭合。");
    }
    if (!declaration || !/^[lcr]+$/.test(declaration)) {
      throw new Error("array 列声明暂不支持；当前仅支持由 l、c、r 组成的简单声明，例如 {lcr}。");
    }
    return Array.from(declaration, (alignment) => alignment === "l" ? "left" : alignment === "r" ? "right" : "center");
  }

  private throwEnvironmentMismatch(expected: string, actual: string): never {
    throw new Error("环境结束标记不匹配：开始为 " + expected + "，结束为 " + actual);
  }
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function commandError(format: "plain" | "word", command: string): Error {
  return format === "plain"
    ? new Error("纯文本转换暂不支持命令 \\" + command)
    : new Error("Word 转换暂不支持命令 \\" + command + "；LaTeX 源码仍然保留。");
}

function environmentError(format: "plain" | "word", environment: string): Error {
  return format === "plain"
    ? new Error("纯文本转换暂不支持环境 " + environment)
    : new Error("Word 转换暂不支持环境 " + environment + "；LaTeX 源码仍然保留。");
}

function ommlRun(text: string, style?: MathStyle): string {
  let properties = "";
  if (style === "script") properties = "<m:scr m:val=\"script\"/>";
  else if (style === "double-struck") properties = "<m:scr m:val=\"double-struck\"/>";
  else if (style === "roman" || style === "text") properties = "<m:nor/>";
  else if (style === "bold") properties = "<m:sty m:val=\"b\"/>";
  else if (style === "italic") properties = "<m:sty m:val=\"i\"/>";
  const runProperties = properties ? "<m:rPr>" + properties + "</m:rPr>" : "";
  return "<m:r>" + runProperties + "<m:t xml:space=\"preserve\">" + escapeXml(text) + "</m:t></m:r>";
}

function omml(nodes: FormulaNode[], style?: MathStyle): string {
  return nodes.map((node) => {
    if (node.kind === "run") return ommlRun(node.text, style);
    if (node.kind === "unsupported-command") throw commandError("word", node.command);
    if (node.kind === "group") return omml(node.children, style);
    if (node.kind === "styled") return omml(node.children, node.style);
    if (node.kind === "accent") return "<m:acc><m:accPr><m:chr m:val=\"&#x0302;\"/></m:accPr><m:e>" +
      omml(node.children, style) + "</m:e></m:acc>";
    if (node.kind === "break") return "<m:r><m:br/><m:t xml:space=\"preserve\"> </m:t></m:r>";
    if (node.kind === "fraction") {
      return "<m:f><m:fPr><m:type m:val=\"bar\"/></m:fPr><m:num>" + omml(node.numerator, style) +
        "</m:num><m:den>" + omml(node.denominator, style) + "</m:den></m:f>";
    }
    if (node.kind === "radical") {
      const degree = node.degree
        ? "<m:degHide m:val=\"0\"/>"
        : "<m:degHide m:val=\"1\"/>";
      return "<m:rad><m:radPr>" + degree + "</m:radPr><m:deg>" +
        (node.degree ? omml(node.degree, style) : "") + "</m:deg><m:e>" + omml(node.body, style) + "</m:e></m:rad>";
    }
    if (node.kind === "script") {
      if (node.sub && node.sup) {
        return "<m:sSubSup><m:e>" + omml(node.base, style) + "</m:e><m:sub>" + omml(node.sub, style) +
          "</m:sub><m:sup>" + omml(node.sup, style) + "</m:sup></m:sSubSup>";
      }
      if (node.sup) return "<m:sSup><m:e>" + omml(node.base, style) + "</m:e><m:sup>" + omml(node.sup, style) + "</m:sup></m:sSup>";
      return "<m:sSub><m:e>" + omml(node.base, style) + "</m:e><m:sub>" + omml(node.sub ?? [], style) + "</m:sub></m:sSub>";
    }
    if (node.kind === "delimited") {
      const begin = node.begin === "." ? "" : node.begin;
      const end = node.end === "." ? "" : node.end;
      return "<m:d><m:dPr><m:begChr m:val=\"" + escapeXml(begin) + "\"/><m:endChr m:val=\"" +
        escapeXml(end) + "\"/></m:dPr><m:e>" + omml(node.children, style) + "</m:e></m:d>";
    }
    return ommlEnvironment(node, style);
  }).join("");
}

function ommlEnvironment(node: Extract<FormulaNode, { kind: "environment" }>, style?: MathStyle): string {
  const environment = node.environment;
  if (environment === "aligned") {
    const rows = node.rows.map((row) => {
      const aligned: FormulaNode[] = [];
      row.forEach((cell, index) => {
        if (index > 0) aligned.push({ kind: "run", text: "&" });
        aligned.push(...cell);
      });
      return "<m:e>" + omml(aligned, style) + "</m:e>";
    }).join("");
    return "<m:eqArr><m:eqArrPr><m:baseJc m:val=\"center\"/></m:eqArrPr>" + rows + "</m:eqArr>";
  }

  const matrixEnvironments = new Set(["matrix", "array", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "cases"]);
  if (!matrixEnvironments.has(environment)) throw environmentError("word", environment);
  const columns = node.columns ?? Array.from(
    { length: node.rows.reduce((width, row) => Math.max(width, row.length), 0) },
    () => "center" as ColumnAlignment
  );
  const columnProperties = "<m:mcs>" + columns.map((alignment) =>
    "<m:mc><m:mcPr><m:mcJc m:val=\"" + alignment + "\"/></m:mcPr></m:mc>"
  ).join("") + "</m:mcs>";
  const rows = node.rows.map((row) =>
    "<m:mr>" + row.map((cell) => "<m:e>" + omml(cell, style) + "</m:e>").join("") + "</m:mr>"
  ).join("");
  const matrix = "<m:m><m:mPr>" + columnProperties + "</m:mPr>" + rows + "</m:m>";

  const delimiters: Record<string, [string, string]> = {
    pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"],
    vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"], cases: ["{", ""]
  };
  if (environment === "matrix" || environment === "array") return matrix;
  const [begin, end] = delimiters[environment];
  return "<m:d><m:dPr><m:begChr m:val=\"" + escapeXml(begin) + "\"/><m:endChr m:val=\"" +
    escapeXml(end) + "\"/></m:dPr><m:e>" + matrix + "</m:e></m:d>";
}

function plain(nodes: FormulaNode[], format: "plain" = "plain"): string {
  return nodes.map((node) => {
    if (node.kind === "run") return node.text;
    if (node.kind === "unsupported-command") throw commandError(format, node.command);
    if (node.kind === "group") return plain(node.children, format);
    if (node.kind === "styled") {
      const content = plain(node.children, format);
      if (node.style === "script") return Array.from(content, (character) => plainMathcal[character] ?? character).join("");
      return content;
    }
    if (node.kind === "accent") {
      const content = plain(node.children, format);
      return Array.from(content).length === 1 ? content + "̂" : "hat(" + content + ")";
    }
    if (node.kind === "break") return "\n";
    if (node.kind === "fraction") return "(" + plain(node.numerator, format) + ")/(" + plain(node.denominator, format) + ")";
    if (node.kind === "radical") {
      return node.degree
        ? "root_(" + plain(node.degree, format) + ")(" + plain(node.body, format) + ")"
        : "√(" + plain(node.body, format) + ")";
    }
    if (node.kind === "script") {
      return plain(node.base, format) + (node.sub ? "_(" + plain(node.sub, format) + ")" : "") +
        (node.sup ? "^(" + plain(node.sup, format) + ")" : "");
    }
    if (node.kind === "delimited") {
      return (node.begin === "." ? "" : node.begin) + plain(node.children, format) + (node.end === "." ? "" : node.end);
    }
    return plainEnvironment(node, format);
  }).join("");
}

function plainEnvironment(node: Extract<FormulaNode, { kind: "environment" }>, format: "plain"): string {
  const environment = node.environment;
  const renderCells = (row: FormulaNode[][], separator: string) => row.map((cell) => plain(cell, format)).join(separator);
  if (environment === "aligned") {
    return node.rows.map((row) => {
      const cells = row.map((cell) => plain(cell, format).trim());
      for (let index = 1; index < cells.length; index += 1) {
        cells[index] = cells[index].replace(/^([=+−<>≤≥])/, "$1 ");
      }
      return cells.join(" ").trim();
    }).join("\n");
  }
  const matrixEnvironments = new Set(["matrix", "array", "pmatrix", "bmatrix", "Bmatrix", "vmatrix", "Vmatrix", "cases"]);
  if (!matrixEnvironments.has(environment)) throw environmentError(format, environment);
  const rows = node.rows.map((row) => renderCells(row, " | "));
  if (environment === "array" || environment === "matrix") return rows.join("\n");
  if (environment === "cases") return "{\n" + rows.map((row) => "  " + row).join("\n") + "\n}";
  const delimiters: Record<string, [string, string]> = {
    pmatrix: ["(", ")"], bmatrix: ["[", "]"], Bmatrix: ["{", "}"],
    vmatrix: ["|", "|"], Vmatrix: ["‖", "‖"]
  };
  const [begin, end] = delimiters[environment];
  return begin + "\n" + rows.map((row) => "  " + row).join("\n") + "\n" + end;
}

export function renderFormulaMathml(source: string): string {
  return katex.renderToString(source, {
    displayMode: true,
    output: "mathml",
    throwOnError: true,
    strict: "ignore"
  });
}

export function renderPlainFormula(source: string): string {
  return plain(new LatexParser(source).parse()).trim();
}

export async function createEditableWordDocument(source: string): Promise<Blob> {
  const { createEditableWordDocument: createDocument } = await import("./word-export");
  return createDocument(source);
}

export function renderFormulaOmml(source: string): string {
  return omml(new LatexParser(source).parse());
}

export function formatLabel(format: OutputFormat): string {
  const labels: Record<OutputFormat, string> = {
    latex: "LaTeX",
    mathml: "MathML",
    word: "Word 公式",
    plain: "纯文本"
  };
  return labels[format];
}









