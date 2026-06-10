# Theoretical Foundations

This document explains the learning science behind the atomic flashcard generation skill. For installation and usage, see [README.md](README.md).

---

## Why This Exists

Most AI-generated flashcards fail because they treat flashcard creation as a text summarisation problem. They compress content into card-shaped boxes without considering how human memory actually works.

This skill takes a different approach: it encodes learning science directly into the generation process.

---

## The Three-Layer Framework

Every flashcard targets exactly one of three cognitive operations:

| Layer | Cognitive Operation | What It Tests |
|-------|---------------------|---------------|
| **L1: Recall** | Remember / Retrieve | Facts, definitions, formulas, procedures |
| **L2: Understanding** | Explain / Connect | Why things work, intuitions, relationships |
| **L3: Boundaries** | Evaluate / Critique | Limitations, edge cases, failure conditions |

This isn't arbitrary. It maps directly onto established learning science.

---

## Scientific Foundations

### Bloom's Taxonomy (1956, revised 2001)

Bloom's taxonomy classifies cognitive processes into hierarchical levels: Remember → Understand → Apply → Analyse → Evaluate → Create.

Our three layers compress this into what's actually useful for flashcard-based learning:

- **L1 (Recall)** = Remember
- **L2 (Understanding)** = Understand + Analyse
- **L3 (Boundaries)** = Evaluate

We deliberately exclude Apply and Create because flashcards are the wrong tool for those. Application requires practice problems; creation requires projects.

> Bloom, B. S. (1956). *Taxonomy of Educational Objectives*. Longmans, Green.
>
> Anderson, L. W., & Krathwohl, D. R. (2001). *A Taxonomy for Learning, Teaching, and Assessing*. Longman.

---

### Cognitive Load Theory (Sweller, 1988)

Cognitive load theory distinguishes between:

- **Intrinsic load**: Complexity inherent to the material
- **Extraneous load**: Complexity added by poor presentation
- **Germane load**: Effort spent building mental schemas

Compound flashcards ("What is X and why is it important?") create extraneous load by forcing the learner to context-switch mid-retrieval. Our atomicity rules eliminate this.

The "≤3 bullets" constraint directly addresses working memory limits. Miller's (1956) "magical number seven" has been revised downward by subsequent research; Cowan (2001) suggests 4±1 chunks for most people.

> Sweller, J. (1988). Cognitive load during problem solving. *Cognitive Science*, 12(2), 257-285.
>
> Cowan, N. (2001). The magical number 4 in short-term memory. *Behavioral and Brain Sciences*, 24(1), 87-114.

---

### The Testing Effect (Roediger & Karpicke, 2006)

Retrieval practice strengthens memory more than re-reading or re-studying. But the effect depends on the retrieval cue being specific enough to trigger exactly one memory trace.

This is why atomicity matters: a card asking two things provides two retrieval cues, diluting the strengthening effect on each.

> Roediger, H. L., & Karpicke, J. D. (2006). Test-enhanced learning. *Psychological Science*, 17(3), 249-255.

---

### The Minimum Information Principle (Wozniak, 1999)

Piotr Wozniak, creator of SuperMemo, articulated the minimum information principle:

> "Simple items are easier to remember... If you decompose complex knowledge into simple items, you will have less to remember."

Our refusal policy operationalises this. Some content (multi-step proofs, worked examples, lists with >3 items) cannot be atomised without losing coherence. The correct response is to not create a flashcard, not to create a bad one.

> Wozniak, P. (1999). Effective learning: Twenty rules of formulating knowledge. *SuperMemo*.
> https://www.supermemo.com/en/blog/twenty-rules-of-formulating-knowledge

---

### Desirable Difficulties (Bjork, 1994)

Learning is enhanced when retrieval is effortful but successful. Cards that are too easy (pure recognition) or too hard (requiring inference chains) are suboptimal.

The three-layer system creates natural difficulty progression:
- L1 cards test recognition/recall (lower difficulty)
- L2 cards test explanation (medium difficulty)
- L3 cards test evaluation (higher difficulty)

Learners can filter by layer to match their current mastery level.

> Bjork, R. A. (1994). Memory and metamemory considerations in the training of human beings. In J. Metcalfe & A. Shimamura (Eds.), *Metacognition: Knowing about knowing* (pp. 185-205). MIT Press.

---

### Spaced Repetition (Ebbinghaus, 1885; Pimsleur, 1967)

Flashcards are most effective when reviewed at expanding intervals. While this skill doesn't implement scheduling (that's the job of Anki, SuperMemo, etc.), it produces cards optimised for spaced repetition systems.

Key compatibility features:
- Atomic cards work with any SRS algorithm
- Layer tags enable filtered decks (e.g., "only L3 cards this week")
- Starred cards support user-defined priority

> Ebbinghaus, H. (1885). *Über das Gedächtnis*. Duncker & Humblot.
>
> Pimsleur, P. (1967). A memory schedule. *The Modern Language Journal*, 51(2), 73-75.

---

## Design Decisions

### Why "Boundaries" Instead of "Failure Modes"?

Originally, I had used "Failure Modes" as the L3 label, but this was too narrow. It implied the layer was only for things that break, missing:
- Assumptions that must hold
- Edge cases that require special handling
- Scope limitations
- Contexts where alternatives are preferred

"Boundaries" captures all of these: the edges of where a concept applies.

### Why Reject Compound Questions?

Consider: "What is gradient descent and when does it fail?"

This asks for:
1. A definition (L1)
2. Failure conditions (L3)

These are different cognitive operations. Combining them:
- Confuses which layer the card belongs to
- Makes partial credit impossible
- Dilutes the testing effect for both concepts
- Increases extraneous cognitive load

The atomicity rule forces the generator to create two cards, each doing its job well.

### Why Limit Lists to 3 Items?

Working memory research suggests 4±1 chunks as the practical limit. But "chunk" depends on expertise; novices have smaller chunks than experts.

Three items is conservative enough to work for novices while still allowing meaningful enumeration. Lists longer than three should either:
- Be split into multiple cards ("What are the first three properties? What are the remaining properties?")
- Remain as reference material, not flashcards

### Why Include a Refusal Policy?

Most flashcard generators try to card everything. This produces:
- 15-step algorithm cards that are impossible to recall
- Proof cards that require sequential reasoning, not retrieval
- Worked example cards that test absolutely nothing

The refusal policy explicitly names content types that shouldn't become flashcards. This is a feature, not a limitation.

---

## References

### Primary Sources

- Anderson, L. W., & Krathwohl, D. R. (2001). *A Taxonomy for Learning, Teaching, and Assessing*. Longman.
- Bjork, R. A. (1994). Memory and metamemory considerations in the training of human beings. In *Metacognition: Knowing about knowing* (pp. 185-205). MIT Press.
- Bloom, B. S. (1956). *Taxonomy of Educational Objectives*. Longmans, Green.
- Cowan, N. (2001). The magical number 4 in short-term memory. *Behavioral and Brain Sciences*, 24(1), 87-114.
- Ebbinghaus, H. (1885). *Über das Gedächtnis*. Duncker & Humblot.
- Roediger, H. L., & Karpicke, J. D. (2006). Test-enhanced learning. *Psychological Science*, 17(3), 249-255.
- Sweller, J. (1988). Cognitive load during problem solving. *Cognitive Science*, 12(2), 257-285.
- Wozniak, P. (1999). Effective learning: Twenty rules of formulating knowledge. *SuperMemo*.

### Further Reading

- Dunlosky, J., et al. (2013). Improving students' learning with effective learning techniques. *Psychological Science in the Public Interest*, 14(1), 4-58.
- Matuschak, A., & Nielsen, M. (2019). How can we develop transformative tools for thought? https://numinous.productions/ttft/
- Matuschak, A. (2020). Evergreen notes. https://notes.andymatuschak.org/Evergreen_notes