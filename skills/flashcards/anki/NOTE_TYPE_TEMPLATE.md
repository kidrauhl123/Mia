# Anki Note Type Template

## Fields

1. **Front** — the question
2. **Back** — the answer (with MathJax LaTeX)
3. **Layer** — full label: `L1 · Recall`, `L2 · Understanding`, or `L3 · Boundaries`
4. **Topic** — topic name

---

## Front Template

```html
<div class="layer-badge">{{Layer}}</div>

<div class="question">{{Front}}</div>
```

## Back Template

```html
{{FrontSide}}

<hr id="answer">

<div class="answer">{{Back}}</div>

<div class="metadata">
  Topic: {{Topic}}
</div>
```

## Styling

```css
.card {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 20px;
  text-align: center;
  color: #1a1a1b;
  background-color: #ffffff;
  padding: 20px;
}

.layer-badge {
  display: inline-block;
  padding: 6px 14px;
  border-radius: 4px;
  font-size: 0.8em;
  font-weight: 600;
  margin-bottom: 20px;
  background: #f0f0f0;
  color: #555;
}

.question {
  font-size: 1.1em;
  margin: 30px 0;
  line-height: 1.5;
}

.answer {
  margin: 30px 0;
  line-height: 1.6;
  text-align: left;
}

.metadata {
  margin-top: 25px;
  padding-top: 15px;
  border-top: 1px solid #e0e0e0;
  font-size: 0.8em;
  color: #888;
}

hr#answer {
  border: none;
  border-top: 2px solid #e0e0e0;
  margin: 20px 0;
}
```


