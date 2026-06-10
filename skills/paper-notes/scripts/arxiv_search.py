#!/usr/bin/env python3
"""
Research paper search helper for arXiv and bioRxiv.

Usage:
    python arxiv_search.py --query "test-time adaptation" --source both --max-results 30
    python arxiv_search.py --keywords multimodal representation learning --source arxiv
    python arxiv_search.py --query "protein language model" --source biorxiv --months 6
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from urllib.parse import quote_plus
from urllib.request import urlopen

import feedparser


def _safe_parse_date(value: str) -> Optional[datetime]:
    if not value:
        return None
    for fmt in ("%Y-%m-%d", "%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(value[:19], fmt)
        except ValueError:
            continue
    return None


def _in_time_window(date_text: str, months: int) -> bool:
    parsed = _safe_parse_date(date_text)
    if parsed is None:
        return True
    cutoff = datetime.now() - timedelta(days=months * 30)
    return parsed >= cutoff


def _token_match(text: str, query: str) -> bool:
    query_tokens = [t.lower() for t in re.split(r"\s+", query.strip()) if t.strip()]
    if not query_tokens:
        return True
    hay = text.lower()
    return all(tok in hay for tok in query_tokens)


def search_arxiv(
    query: str,
    max_results: int = 50,
    categories: Optional[List[str]] = None,
    months: int = 3,
) -> List[Dict]:
    base_url = "https://export.arxiv.org/api/query?"

    if categories:
        cat_query = " OR ".join([f"cat:{cat}" for cat in categories])
        search_query = f"search_query=({quote_plus(cat_query)})+AND+all:{quote_plus(query)}"
    else:
        search_query = f"search_query=all:{quote_plus(query)}"

    params = f"&start=0&max_results={max_results}&sortBy=submittedDate&sortOrder=descending"
    url = base_url + search_query + params

    print(f"[arXiv] searching: {url}")
    feed = feedparser.parse(url)
    papers: List[Dict] = []

    for entry in feed.entries:
        published = datetime(*entry.published_parsed[:6])
        if not _in_time_window(published.strftime("%Y-%m-%d"), months):
            continue

        authors = [author.name for author in entry.authors] if getattr(entry, "authors", None) else []
        first_author = authors[0] if authors else "Unknown"
        arxiv_id = entry.id.split("/abs/")[-1]
        arxiv_link = f"https://arxiv.org/abs/{arxiv_id}"
        summary = re.sub(r"\s+", " ", entry.summary).strip()

        papers.append(
            {
                "source": "arxiv",
                "title": entry.title.strip(),
                "authors": authors,
                "first_author": first_author,
                "summary": summary,
                "published": published.strftime("%Y-%m-%d"),
                "id": arxiv_id,
                "arxiv_id": arxiv_id,
                "link": arxiv_link,
                "arxiv_link": arxiv_link,
                "pdf_link": f"https://arxiv.org/pdf/{arxiv_id}.pdf",
                "categories": [tag.term for tag in getattr(entry, "tags", [])],
            }
        )

    print(f"[arXiv] found {len(papers)} papers in last {months} month(s)")
    return papers


def search_biorxiv(query: str, max_results: int = 50, months: int = 3) -> List[Dict]:
    end_date = datetime.now().date()
    start_date = (datetime.now() - timedelta(days=months * 30)).date()

    cursor = 0
    page_size = 100
    papers: List[Dict] = []

    # bioRxiv API may reject future date ranges in environments with shifted system dates.
    # Probe and step back by year until the API accepts the interval.
    shift_days = 0
    while True:
        probe_start = start_date - timedelta(days=shift_days)
        probe_end = end_date - timedelta(days=shift_days)
        probe_url = (
            "https://api.biorxiv.org/details/biorxiv/"
            f"{probe_start.isoformat()}/{probe_end.isoformat()}/0"
        )
        with urlopen(probe_url, timeout=30) as response:
            probe_payload = json.loads(response.read().decode("utf-8"))
        status = (
            probe_payload.get("messages", [{}])[0].get("status", "").strip().lower()
        )
        if status != "not available at this time":
            break
        shift_days += 365
        if shift_days > 365 * 8:
            print("[bioRxiv] API unavailable for probed date ranges.")
            return []

    if shift_days:
        print(
            "[bioRxiv] adjusted date window for API availability: "
            f"{probe_start.isoformat()} to {probe_end.isoformat()}"
        )

    while len(papers) < max_results:
        window_start = start_date - timedelta(days=shift_days)
        window_end = end_date - timedelta(days=shift_days)
        url = (
            "https://api.biorxiv.org/details/biorxiv/"
            f"{window_start.isoformat()}/{window_end.isoformat()}/{cursor}"
        )
        print(f"[bioRxiv] fetching: {url}")
        with urlopen(url, timeout=30) as response:
            payload = json.loads(response.read().decode("utf-8"))

        collection = payload.get("collection", [])
        if not collection:
            break

        for item in collection:
            title = item.get("title", "").strip()
            abstract = re.sub(r"\s+", " ", item.get("abstract", "")).strip()
            merged_text = f"{title} {abstract}"
            if not _token_match(merged_text, query):
                continue

            published = item.get("date", "")
            if not _in_time_window(published, months):
                continue

            author_text = item.get("authors", "")
            authors = [a.strip() for a in re.split(r";|,", author_text) if a.strip()]
            first_author = authors[0] if authors else "Unknown"

            doi = item.get("doi", "").strip()
            version = str(item.get("version", "1")).strip() or "1"
            if doi:
                link = f"https://www.biorxiv.org/content/{doi}v{version}"
            else:
                link = item.get("url", "")

            papers.append(
                {
                    "source": "biorxiv",
                    "title": title,
                    "authors": authors,
                    "first_author": first_author,
                    "summary": abstract,
                    "published": published,
                    "id": doi or item.get("title", "")[:80],
                    "doi": doi,
                    "link": link,
                    "pdf_link": f"{link}.full.pdf" if link else "",
                    "categories": [item.get("category", "")],
                }
            )

            if len(papers) >= max_results:
                break

        if len(collection) < page_size:
            break
        cursor += page_size

    print(f"[bioRxiv] found {len(papers)} papers in last {months} month(s)")
    return papers


def search_papers(
    query: str,
    source: str,
    max_results: int,
    months: int,
    categories: Optional[List[str]],
) -> List[Dict]:
    if source == "arxiv":
        return search_arxiv(query=query, max_results=max_results, categories=categories, months=months)
    if source == "biorxiv":
        return search_biorxiv(query=query, max_results=max_results, months=months)

    # both
    per_source = max(10, max_results)
    arxiv = search_arxiv(query=query, max_results=per_source, categories=categories, months=months)
    biorxiv = search_biorxiv(query=query, max_results=per_source, months=months)

    merged = arxiv + biorxiv
    merged.sort(key=lambda x: x.get("published", ""), reverse=True)
    return merged[:max_results]


def print_papers(papers: List[Dict], limit: int = 10) -> None:
    print(f"\n=== Top {min(limit, len(papers))} paper(s) ===\n")
    for i, paper in enumerate(papers[:limit], start=1):
        print(f"[{i}] ({paper.get('source', 'unknown')}) {paper.get('title', 'Untitled')}")
        print(f"    Authors: {paper.get('first_author', 'Unknown')} et al.")
        print(f"    Date: {paper.get('published', 'Unknown')}")
        print(f"    Link: {paper.get('link', '')}")
        summary = paper.get("summary", "")
        print(f"    Abstract: {summary[:150]}...")
        print()


def main() -> None:
    parser = argparse.ArgumentParser(description="Search papers from arXiv and bioRxiv")
    parser.add_argument("--query", "-q", type=str, help="search query")
    parser.add_argument("--keywords", "-k", nargs="+", help="keyword list")
    parser.add_argument("--source", "-s", choices=["arxiv", "biorxiv", "both"], default="both")
    parser.add_argument("--max-results", "-n", type=int, default=50, help="max number of returned papers")
    parser.add_argument(
        "--categories",
        "-c",
        nargs="+",
        default=["cs.CV", "cs.LG", "cs.AI", "q-bio.NC"],
        help="arXiv categories (used only when source includes arxiv)",
    )
    parser.add_argument("--months", "-m", type=int, default=3, help="only keep papers from last N months")
    parser.add_argument("--output", "-o", type=str, help="output JSON path")

    args = parser.parse_args()

    if args.query:
        query = args.query.strip()
    elif args.keywords:
        query = " ".join(args.keywords).strip()
    else:
        query = "machine learning"

    papers = search_papers(
        query=query,
        source=args.source,
        max_results=args.max_results,
        months=args.months,
        categories=args.categories,
    )

    print_papers(papers, limit=10)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            json.dump(papers, f, ensure_ascii=False, indent=2)
        print(f"\nSaved results to: {args.output}")


if __name__ == "__main__":
    main()
