# Formula Format Conversion

FormulaSnap parses LaTeX into a recursive expression tree, then serializes each output format independently. KaTeX generates previews and MathML. Dedicated serializers generate plain text and OMML for editable DOCX output. A limitation in one output format does not block other formats.

## Supported structures

| LaTeX structure | Plain text | Editable Word (OMML) |
| --- | --- | --- |
| Groups and scripts | Preserves grouping with _(…) and ^(…) notation | Office Math group, subscript, and superscript nodes |
| \frac, \dfrac, \tfrac | Parenthesized numerator and denominator | m:f fraction node |
| \sqrt and \sqrt[n] | √(…) and root_(n)(…) notation | m:rad, including an optional degree |
| aligned | One equation per line; alignment cells remain separated | m:eqArr with one m:e per row and Office Math alignment markers |
| matrix, pmatrix, bmatrix, Bmatrix, vmatrix, Vmatrix | Preserves row and column boundaries and delimiters | m:m matrix and matching m:d delimiters |
| array | Preserves row and column boundaries | m:m with simple column alignment mapped to m:mcJc |
| cases | Multiline text block with row and cell boundaries | Matrix structure enclosed by a left brace |
| \hat{x} | Combining accent for one character; hat(…) for compound content | Editable m:acc accent node |
| \left and \right | Emits the corresponding delimiters | m:d delimiter node |
| \mathcal, \mathbb, \mathrm, \mathbf, \mathit, \text, \operatorname | Maps mathcal letters to Unicode script characters; retains text and roman characters and their spaces | Keeps the supported font semantics in Office Math run properties |
| Common Greek letters, relations, operators, sums, and integrals | Maps to corresponding Unicode characters | Emits editable mathematical characters |

The array parser accepts simple declarations composed of l, c, and r, such as {llcr}. Every row must contain the declared number of cells.

Environment parsing is nested. Unescaped ampersands inside supported environments separate cells; write \& for a literal ampersand. Empty leading, trailing, and adjacent cells are preserved. Fractions, matrices, and cases may be nested inside aligned cells.

## Known limits

- Complex array declarations such as vertical bars, paragraph widths, inserted spacing, repeated columns, and multicolumn are unsupported.
- Optional row spacing after a line break, for example \\[2pt], is unsupported.
- Unsupported commands and environments produce a format-specific error. The source remains editable and other supported outputs remain available.
- Plain text preserves mathematical structure and boundaries but is not a typesetting engine. It maps mathcal letters to Unicode script characters; it does not preserve all mathbb, bold, or italic typography.
- OMML supports an explicit subset of LaTeX. It does not claim lossless conversion of arbitrary LaTeX. DOCX contains editable Office Math structures, not formula screenshots.

Conversion errors are displayed in the corresponding output area and are not copied as result content. Editing LaTeX recalculates outputs. History and batch result views use the same conversion workflow as the main view.

## Office Math reference

Microsoft documents the row structure of m:eqArr and the meaning of alignment markers in equation arrays: [Equation-Array Function](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/d8d37e2b-532d-49db-9cba-2ef4bd8d9baa). Matrix column alignment uses m:mcs, m:mc, and m:mcJc.
