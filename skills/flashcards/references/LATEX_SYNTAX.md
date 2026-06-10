# LaTeX Syntax Reference

## Contents
- Greek letters
- Accents & estimators
- Operators (sums, products, calculus)
- Limits & optimization
- Probability & statistics
- Special functions
- Fractions & roots
- Subscripts & superscripts
- Relations
- Set theory
- Arrows
- Linear algebra
- Brackets
- Matrices
- Cases (piecewise)
- Complexity notation

---

## Mode-Agnostic Syntax

This reference covers LaTeX syntax that works in both KaTeX and MathJax.

**For rendering instructions specific to each output mode:**
- Artifact mode → see `artifact/RENDERING.md`
- Anki mode → see `anki/RENDERING.md`

---

## Greek Letters

**Lowercase**: `\alpha \beta \gamma \delta \epsilon \zeta \eta \theta \iota \kappa \lambda \mu \nu \xi \pi \rho \sigma \tau \upsilon \phi \chi \psi \omega`

**Uppercase**: `\Gamma \Delta \Theta \Lambda \Xi \Pi \Sigma \Phi \Psi \Omega`

**Variants**: `\varepsilon`, `\varphi`, `\vartheta`

---

## Accents & Estimators

| Accent | Syntax | Example |
|--------|--------|---------|
| Hat | `\hat{x}` | μ̂ |
| Bar | `\bar{x}` | x̄ |
| Tilde | `\tilde{x}` | θ̃ |
| Dot | `\dot{x}` | ẋ |
| Vector | `\vec{x}` | x⃗ |

---

## Operators

**Sums/Products**:
- `\sum_{i=1}^{n}` — Summation with limits
- `\prod_{i=1}^{n}` — Product with limits

**Calculus**:
- `\int_a^b` — Integral
- `\partial` — Partial derivative symbol
- `\frac{\partial f}{\partial x}` — Partial derivative
- `\nabla` — Gradient

**Limits & Optimization**:
- `\lim_{n \to \infty}` — Limit
- `\arg\max_{\theta}` — Argmax
- `\arg\min_{k}` — Argmin
- `\sup_{x}` — Supremum
- `\inf_{x}` — Infimum
- `\max_{i}` — Maximum
- `\min_{i}` — Minimum

---

## Probability & Statistics

**Blackboard bold**: `\mathbb{E}`, `\mathbb{P}`, `\mathbb{R}`, `\mathbb{N}`

**Calligraphic**: `\mathcal{N}`, `\mathcal{H}`, `\mathcal{X}`

**Text operators**: `\text{Var}(X)`, `\text{Cov}(X,Y)`, `\text{Tr}(A)`

**Distributed as**: `X \sim \mathcal{N}(0,1)`

---

## Special Functions

**Indicator**: `\mathbf{1}[x > 0]` or `\mathbb{1}_A`

**Sign**: `\text{sgn}(x)`

**Log/Exp**: `\log`, `\exp`

---

## Fractions & Roots

- `\frac{a}{b}` — Fraction
- `\sqrt{x}` — Square root
- `\sqrt[n]{x}` — nth root

---

## Subscripts & Superscripts

- `x^2` — Superscript
- `x_i` — Subscript
- `x_{ij}` — Multi-character subscript (braces required)
- `x^{-1}` — Multi-character superscript
- `A^T` or `A^\top` — Transpose
- `A^\dagger` — Pseudoinverse

---

## Relations

| Symbol | Syntax |
|--------|--------|
| ≤ ≥ | `\leq \geq` |
| ≠ | `\neq` |
| ≈ | `\approx` |
| ≡ | `\equiv` |
| ∝ | `\propto` |
| ∼ | `\sim` |
| ≪ ≫ | `\ll \gg` |
| ⊥ | `\perp` |

---

## Set Theory

| Symbol | Syntax |
|--------|--------|
| ∈ ∉ | `\in \notin` |
| ⊂ ⊆ | `\subset \subseteq` |
| ∪ ∩ | `\cup \cap` |
| ∅ | `\emptyset` |
| ∀ ∃ | `\forall \exists` |

---

## Arrows

| Symbol | Syntax |
|--------|--------|
| → | `\to` or `\rightarrow` |
| ← | `\leftarrow` |
| ⇒ | `\Rightarrow` |
| ⇐ | `\Leftarrow` |
| ↔ | `\leftrightarrow` |
| ↦ | `\mapsto` |

---

## Linear Algebra

**Norms**: `\|x\|` or `\lVert x \rVert`, `\|x\|_2`, `\|x\|_\infty`

**Inner product**: `\langle x, y \rangle`

**Products**: `x \otimes y` (outer), `x \odot y` (Hadamard)

---

## Brackets

| Type | Syntax |
|------|--------|
| Parentheses | `\left( x \right)` |
| Brackets | `\left[ x \right]` |
| Braces | `\left\{ x \right\}` |
| Absolute | `\left\| x \right\|` or `\lvert x \rvert` |
| Norm | `\left\| x \right\|` |
| Floor | `\lfloor x \rfloor` |
| Ceiling | `\lceil x \rceil` |

---

## Matrices

```latex
% Parentheses
\begin{pmatrix} a & b \\ c & d \end{pmatrix}

% Brackets
\begin{bmatrix} a & b \\ c & d \end{bmatrix}

% Determinant
\begin{vmatrix} a & b \\ c & d \end{vmatrix}
```

---

## Cases (Piecewise)

```latex
f(x) = \begin{cases} 1 & x > 0 \\ 0 & x \leq 0 \end{cases}
```

---

## Complexity

- `O(n)` — Big O
- `\Omega(n)` — Big Omega
- `\Theta(n)` — Big Theta
- `o(n)` — Little o
