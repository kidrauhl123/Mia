# Cognitive Layers

This framework is derived from Bloom's Taxonomy (1956, revised 2001), adapted for flashcard-based learning.

## Contents
- Layer overview
- L1: Recall
- L2: Understanding
- L3: Boundaries
- Card type taxonomy
- Answer constraints
- Content-driven card count
- Topic extraction

---

## Layer Overview

| Layer | Cognitive Operation | Bloom's Equivalent | What It Tests |
|-------|---------------------|-------------------|---------------|
| **L1** | Remember / Retrieve | Remember | Facts, definitions, formulas |
| **L2** | Explain / Connect | Understand + Analyse | Why things work, intuitions |
| **L3** | Evaluate / Critique | Evaluate | Limitations, edge cases |

We exclude Apply and Create because flashcards are the wrong tool for those. Application requires practice problems; creation requires projects.

---

## L1: Recall

**Purpose**: Pure retrieval of facts, definitions, formulas, procedures.

**Cognitive operation**: Remember / retrieve from memory.

**Question patterns**:
- "What is the formula for X?"
- "Define X"
- "State the theorem for X"
- "What are the properties of X?" (list-only)
- "Who created X?" / "When was X introduced?"

**Answer format**: Formula, definition, or ≤3 bullet points.

---

## L2: Understanding

**Purpose**: Why things work, how concepts connect, intuitions, interpretations.

**Cognitive operation**: Explain / interpret / connect.

**Question patterns**:
- "Why does X work?"
- "What is the intuition behind X?"
- "How does X relate to Y?"
- "What is the geometric interpretation of X?"
- "Why is X defined this way?"

**Answer format**: 1-2 sentences explaining the "why" or "how".

---

## L3: Boundaries

**Purpose**: When methods break, limitations, edge cases, assumptions, failure conditions.

**Cognitive operation**: Evaluate / critique / identify limits.

**Question patterns**:
- "When does X fail?"
- "What are the limitations of X?"
- "What assumptions does X require?"
- "What happens if [condition] is violated?"

**Answer format**: Condition + consequence (1-2 sentences).

---

## Card Type Taxonomy

| Type | L1 Example | L2 Example | L3 Example |
|------|------------|------------|------------|
| **Definition** | "Define X" | "Why is X defined this way?" | "When does this definition break down?" |
| **Fact** | "Who invented X?" | "Why was X invented?" | — |
| **Formula** | "State the formula for X" | "Why does this formula work?" | "When does this formula fail?" |
| **Property** | "What are the properties of X?" | "Why does X have property P?" | "When does property P not hold?" |
| **Process** | "What are the steps of X?" (≤3) | "Why is step N necessary?" | "What can go wrong at step N?" |
| **Comparison** | "How does X differ from Y?" | "Why does X outperform Y in context C?" | "When should you prefer Y over X?" |

---

## Answer Constraints

| Layer | Max Length | Format |
|-------|------------|--------|
| L1 | Formula OR 1 sentence OR ≤3 bullets | Terse, no explanation |
| L2 | 1-2 sentences | Explains "why" or "how" |
| L3 | 1-2 sentences | Condition → consequence |

---

## Content-Driven Card Count

| Content Type | L1 | L2 | L3 |
|--------------|----|----|-----|
| Definition-heavy | High | Moderate | Low |
| Theorem/proof | Balanced | Balanced | Moderate |
| Algorithm | High | High | High |
| Intuition/motivation | Low | High | Moderate |

---

## Topic Extraction

**Boundaries**: Section headings, conceptual coherence, lecture structure.

**Naming**: Short (1-3 words), CamelCase for IDs (`MVN`, `GradDescent`).

**Granularity**:
- Too broad: "Linear Algebra"
- Too narrow: "Matrix Transpose"
- Right: "Covariance Estimation", "VC Dimension"
