# Eurostat Dashboards Factory (MVP)

A code-first “dashboards factory” that:
- Ingests the Eurostat catalogue (TOC)
- Selects N datasets
- Generates a strict `ReportPlan` JSON per dataset (rules-based MVP)
- Ingests bounded dataset slices into DuckDB/Parquet (robust, template-friendly)
- Renders deterministic Quarto dashboard pages (no fragile report formats)
- Publishes publicly via GitHub Pages

## Quick start (local)

### 1) Create a virtualenv and install deps
```bash
python -m venv .venv
# Windows: .venv\Scripts\activate
source .venv/bin/activate
pip install -r requirements.txt
```

### 2) Install Quarto (once)
- https://quarto.org/docs/get-started/

### 3) Run the factory for an explicit list of datasets
```bash
python -m eurodash run --mode explicit --datasets nama_10_gdp prc_hicp_midx --n 2
```

### 4) Preview the site
```bash
cd site
quarto preview
```

## CLI overview
```bash
python -m eurodash --help
python -m eurodash ingest-catalog
python -m eurodash select --mode keyword --keyword gdp --n 3
python -m eurodash plan --datasets nama_10_gdp --n 1
python -m eurodash ingest --datasets nama_10_gdp --n 1
python -m eurodash render --datasets nama_10_gdp --n 1
```

## Deploy to GitHub Pages
1) Push this repo to GitHub.
2) Enable Pages for the repository (Settings → Pages) with **GitHub Actions**.
3) The workflow in `.github/workflows/publish.yml` can:
   - run the pipeline
   - render the Quarto site
   - deploy to GitHub Pages

> This starter repo creates a **local** repo scaffold.
> Creating a GitHub repository automatically requires your GitHub credentials/tools on your machine
> (e.g., GitHub CLI `gh repo create`), which you can run locally.

## Data model (MVP)
Warehouse: DuckDB file + Parquet
- `catalog_registry` (dataset registry from TOC)
- `fact_observations` universal long fact table
  - `dataset_code, time, geo, value, unit, freq, status, dims_json, series_key`

## Next upgrades
- Swap rules planner with LLM planner that outputs validated JSON schema.
- Add template types (maps, distributions).
- Add dbt + dbt Semantic Layer for standardized metrics.
- Add caching + incremental refresh + async API handling.
