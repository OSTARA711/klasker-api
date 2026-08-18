# Klasker API

The public API layer for [Klasker](https://www.klasker.com/).

Klasker analyses websites and scores their technical and structural
readiness for Agentic AI-driven eCommerce.

Klasker does **not** use Artificial Intelligence to analyse websites.
The analysis is performed by deterministic software.

## Architecture

```text
www.klasker.com
        │
        │ POST /api/analysis
        ▼
Cloudflare Worker
        │
        ▼
Klasker Scanner
        │
        ▼
TiDB Cloud
        │
        ▼
Analysis result
