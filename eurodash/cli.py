from __future__ import annotations
import datetime as dt
from pathlib import Path
import typer

from .config import Config
from .catalog import ingest_catalog, upsert_catalog
from .selector import select_datasets
from .discovery import discover_structure
from .planner import build_plan
from .ingest import ingest_dataset, upsert_fact
from .render import render_site
from .utils import write_json, ensure_dir, read_json

app = typer.Typer(help="Eurostat Dashboards Factory (MVP)")

@app.command("ingest-catalog")
def ingest_catalog_cmd(config: str = "config.yml"):
    cfg = Config.load(config)
    df = ingest_catalog(cfg)
    upsert_catalog(cfg, df)
    typer.echo(f"Ingested catalog: {len(df)} datasets")

@app.command("select")
def select_cmd(
    mode: str = typer.Option("explicit", help="explicit | keyword | updates"),
    n: int = typer.Option(2),
    keyword: str = typer.Option(None),
    days_back: int = typer.Option(7),
    datasets: list[str] = typer.Argument(None),
    config: str = typer.Option("config.yml"),
):
    cfg = Config.load(config)
    codes = select_datasets(cfg, mode=mode, n=n, keyword=keyword, days_back=days_back,
                           explicit=datasets or cfg.get("selection","explicit_datasets", default=[]))
    typer.echo("\n".join(codes))

@app.command("plan")
def plan_cmd(
    mode: str = typer.Option("explicit"),
    n: int = typer.Option(2),
    keyword: str = typer.Option(None),
    days_back: int = typer.Option(7),
    datasets: list[str] = typer.Argument(None),
    config: str = typer.Option("config.yml"),
):
    cfg = Config.load(config)
    codes = select_datasets(cfg, mode=mode, n=n, keyword=keyword, days_back=days_back,
                           explicit=datasets or cfg.get("selection","explicit_datasets", default=[]))

    ensure_dir("plans")
    for code in codes:
        struct = discover_structure(cfg, code, time_hint=None)
        plan = build_plan(cfg, code, title=None, struct=struct).model_dump()
        write_json(Path("plans") / f"{code}.json", plan)
    typer.echo(f"Generated plans: {len(codes)}")

@app.command("ingest")
def ingest_cmd(
    mode: str = typer.Option("explicit"),
    n: int = typer.Option(2),
    keyword: str = typer.Option(None),
    days_back: int = typer.Option(7),
    datasets: list[str] = typer.Argument(None),
    config: str = typer.Option("config.yml"),
):
    cfg = Config.load(config)
    codes = select_datasets(cfg, mode=mode, n=n, keyword=keyword, days_back=days_back,
                           explicit=datasets or cfg.get("selection","explicit_datasets", default=[]))

    for code in codes:
        plan_path = Path("plans") / f"{code}.json"
        filters = {}
        if plan_path.exists():
            filters = read_json(plan_path).get("defaults", {}).get("filters", {}) or {}
        df = ingest_dataset(cfg, dataset_code=code, filters=filters)
        upsert_fact(cfg, df, dataset_code=code)
        typer.echo(f"Ingested {code}: {len(df)} rows")

@app.command("render")
def render_cmd(
    mode: str = typer.Option("explicit"),
    n: int = typer.Option(2),
    keyword: str = typer.Option(None),
    days_back: int = typer.Option(7),
    datasets: list[str] = typer.Argument(None),
    config: str = typer.Option("config.yml"),
):
    cfg = Config.load(config)
    codes = select_datasets(cfg, mode=mode, n=n, keyword=keyword, days_back=days_back,
                           explicit=datasets or cfg.get("selection","explicit_datasets", default=[]))
    render_site(cfg, dataset_codes=codes)
    typer.echo(f"Rendered site pages for: {len(codes)} datasets")

@app.command("run")
def run_cmd(
    mode: str = typer.Option("explicit"),
    n: int = typer.Option(2),
    keyword: str = typer.Option(None),
    days_back: int = typer.Option(7),
    datasets: list[str] = typer.Argument(None),
    config: str = typer.Option("config.yml"),
):
    cfg = Config.load(config)

    # 1) catalog
    df = ingest_catalog(cfg)
    upsert_catalog(cfg, df)

    # 2) select
    codes = select_datasets(cfg, mode=mode, n=n, keyword=keyword, days_back=days_back,
                           explicit=datasets or cfg.get("selection","explicit_datasets", default=[]))

    # 3) plan
    ensure_dir("plans")
    for code in codes:
        struct = discover_structure(cfg, code, time_hint=None)
        plan = build_plan(cfg, code, title=None, struct=struct).model_dump()
        write_json(Path("plans") / f"{code}.json", plan)

    # 4) ingest
    for code in codes:
        plan = read_json(Path("plans") / f"{code}.json")
        filters = plan.get("defaults", {}).get("filters", {}) or {}
        df = ingest_dataset(cfg, dataset_code=code, filters=filters)
        upsert_fact(cfg, df, dataset_code=code)

    # 5) render
    render_site(cfg, dataset_codes=codes)

    # 6) evidence
    ts = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    run_dir = Path("runs") / ts
    ensure_dir(run_dir)
    write_json(run_dir / "selected_datasets.json", {"selected": codes})
    typer.echo(f"Run complete. Evidence: {run_dir}")

if __name__ == "__main__":
    app()
