from __future__ import annotations
from pathlib import Path
import json
from jinja2 import Environment, FileSystemLoader

from .config import Config
from .utils import ensure_dir

# region agent log
def _agent_log(run_id: str, hypothesis_id: str, location: str, message: str, data: dict) -> None:
    """
    Lightweight debug logger for Cursor debug mode.
    Writes NDJSON lines to .cursor/debug.log without raising on failure.
    """
    try:
        import time

        ts_ms = int(time.time() * 1000)
        payload = {
            "id": f"log_{ts_ms}",
            "timestamp": ts_ms,
            "runId": run_id,
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
        }
        log_path = Path(".cursor") / "debug.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload) + "\n")
    except Exception:
        # Never let debug logging break the pipeline
        pass
# endregion


def render_site(cfg: Config, dataset_codes: list[str]) -> None:
    templates_dir = Path(cfg.get("render", "templates_dir"))
    site_dir = Path(cfg.get("render", "site_dir"))
    dashboards_dir = Path(cfg.get("render", "dashboards_dir"))

    _agent_log(
        run_id="pre-fix",
        hypothesis_id="H_quarto_paths",
        location="eurodash/render.py:render_site:start",
        message="render_site called",
        data={
            "templates_dir": str(templates_dir),
            "site_dir": str(site_dir),
            "dashboards_dir": str(dashboards_dir),
            "dataset_codes": list(dataset_codes),
        },
    )

    ensure_dir(dashboards_dir)

    env = Environment(loader=FileSystemLoader(str(templates_dir)), autoescape=False)
    dash_tpl = env.get_template("dashboard.qmd.j2")
    index_tpl = env.get_template("index.qmd.j2")

    items = []
    for code in dataset_codes:
        plan_path = Path("plans") / f"{code}.json"
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        out_path = dashboards_dir / f"{code}.qmd"
        out_path.write_text(dash_tpl.render(plan=plan, cfg=cfg.raw), encoding="utf-8")
        items.append({
            "code": code,
            "title": (plan.get("dataset") or {}).get("title") or code,
            "path": f"dashboards/{code}.html"
        })

    (site_dir / "index.qmd").write_text(index_tpl.render(items=items), encoding="utf-8")

    _agent_log(
        run_id="pre-fix",
        hypothesis_id="H_quarto_paths",
        location="eurodash/render.py:render_site:end",
        message="render_site completed",
        data={
            "rendered_items": len(items),
            "codes": [item["code"] for item in items],
        },
    )
