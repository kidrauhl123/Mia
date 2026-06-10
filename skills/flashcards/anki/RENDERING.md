# MathJax Notation for Anki

## Critical Difference from Artifact Mode

- **Artifact mode:** Render LaTeX to HTML using KaTeX CLI
- **Anki mode:** Keep LaTeX as raw text, wrap in MathJax delimiters

**There is no rendering command.** The LaTeX stays as text in the TSV file. Anki renders it when displaying cards using its built-in MathJax support.

---

## MathJax Delimiters

Anki expects these specific delimiters:

| Type | Delimiter | Example |
|------|-----------|---------|
| Inline | `\(...\)` | `\(\frac{a}{b}\)` |
| Display | `\[...\]` | `\[\sum_{i=1}^n x_i\]` |

**Do NOT use:**
- `$...$` — not supported in Anki
- `$$...$$` — not supported in Anki
- `[latex]...[/latex]` — legacy Anki syntax, deprecated

---

## Choosing Inline vs Display

**Inline** `\(...\)` — math within a sentence or short formulas:
```
The variance is \(\sigma^2 = E[(X - \mu)^2]\)
```

**Display** `\[...\]` — standalone equations or complex formulas:
```
\[\sum_{i=1}^{n} (x_i - \bar{x})^2\]
```

---

## Example Transformations

### Simple formula
```
Source:  \frac{a}{b}
Output: \(\frac{a}{b}\)
```

### Matrix
```
Source:  \begin{bmatrix} a & b \\ c & d \end{bmatrix}
Output: \[\begin{bmatrix} a & b \\ c & d \end{bmatrix}\]
```

### Text with embedded math
```
Source:  The gradient is \nabla f = \frac{\partial f}{\partial x}
Output: The gradient is \(\nabla f = \frac{\partial f}{\partial x}\)
```

---

## Compatibility

All LaTeX syntax in `references/LATEX_SYNTAX.md` works in both KaTeX and MathJax. The syntax is identical — only the wrapping delimiters differ.

