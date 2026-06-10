# KaTeX Rendering for Artifacts

## Overview

The artifact template handles KaTeX rendering **client-side** in the browser. Claude outputs raw LaTeX strings; the React component compiles them on render.

This approach is ~95% more token-efficient than pre-compiling HTML.

## Token Comparison

| Method | Tokens per formula |
|--------|-------------------|
| Pre-compiled HTML | ~800–1000 |
| Raw LaTeX | ~20–25 |

## Output Format

The `a` field in each card should contain either:

1. **Raw LaTeX** for mathematical content:
   ```javascript
   a: '\\frac{\\partial L}{\\partial \\theta}'
   ```

2. **Plain text** for non-mathematical answers:
   ```javascript
   a: 'The bias-variance tradeoff describes the tension between model complexity and generalisation.'
   ```

3. **Mixed content** (text with inline math):
   ```javascript
   a: 'The gradient is $\\nabla f(x)$ which points toward steepest ascent.'
   ```

## LaTeX String Rules

1. **Escape backslashes**: In JavaScript strings, use `\\` for each `\`
   - LaTeX: `\frac{a}{b}` → JS string: `'\\frac{a}{b}'`

2. **No delimiters needed**: The template handles display/inline detection
   - For inline math within text, wrap in single `$`: `'The formula $x^2$ is simple'`
   - For standalone formulas, just write the LaTeX: `'\\frac{a}{b}'`

3. **Braces must match**: Count `{` and `}` — they must be equal

## How the Template Works

The `MathRenderer` component in `template.jsx`:

1. Loads KaTeX JS library from CDN on first render
2. Detects LaTeX patterns in the answer string
3. Renders math segments via `katex.render()`
4. Passes through plain text unchanged

```javascript
// Simplified flow
const MathRenderer = ({ content }) => {
  // Splits content into math/text segments
  // Renders math with KaTeX, text as-is
  // Returns combined HTML
};
```

## Common LaTeX Errors

If cards render incorrectly, check:

| Symptom | Cause | Fix |
|---------|-------|-----|
| Raw LaTeX visible | Missing escape | Use `\\` not `\` |
| Broken formula | Unmatched braces | Count `{` and `}` |
| Undefined command | Unsupported by KaTeX | Check `references/LATEX_SYNTAX.md` |

## KaTeX Limitations

KaTeX supports most LaTeX math, but not:
- `\newcommand` definitions
- Some esoteric symbols
- Full document environments

For supported functions, see: https://katex.org/docs/supported.html
