# General Topic Query Templates

## Query construction

Use this template:

`<task/problem> + <domain> + <method/constraint>`

Examples:
- `test-time adaptation + medical imaging + robustness`
- `multimodal retrieval + biomedicine + contrastive learning`
- `speech representation + low-resource + self-supervised learning`

## Topic starters

### Machine learning
- `test-time adaptation`
- `domain generalization`
- `uncertainty estimation`
- `causal representation learning`

### Multimodal and language
- `multimodal foundation model`
- `retrieval augmented generation`
- `vision-language model evaluation`
- `long-context reasoning`

### Bio/health
- `protein language model`
- `single-cell foundation model`
- `computational pathology`
- `clinical prediction model calibration`

### Neuroscience / BCI
- `EEG decoding`
- `speech decoding from EEG`
- `brain-computer interface`
- `neural signal representation learning`

## Source-specific tips

### arXiv
Search page pattern:

`https://arxiv.org/search/?searchtype=all&query=<QUERY>&abstracts=show&order=-announced_date_first`

API pattern:

`https://export.arxiv.org/api/query?search_query=all:<QUERY>&start=0&max_results=50&sortBy=submittedDate&sortOrder=descending`

### bioRxiv
Use API by date range and then filter by query text:

`https://api.biorxiv.org/details/biorxiv/<FROM_DATE>/<TO_DATE>/<CURSOR>`

Example:

`https://api.biorxiv.org/details/biorxiv/2026-01-01/2026-04-23/0`

## Practical defaults

- Query length: 3 to 8 words
- Time range: last 3 months (`--months 3`)
- Sources: `--source both`
- Result cap: `--max-results 50`

## Anti-patterns

- Too broad: `AI`, `biology`, `vision`
- Too narrow with hard constraints before retrieval
- Mixing too many unrelated concepts in one query
