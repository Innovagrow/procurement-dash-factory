from __future__ import annotations
from pathlib import Path
import json
from jinja2 import Environment, FileSystemLoader

from .config import Config
from .utils import ensure_dir

def render_site(cfg: Config, dataset_codes: list[str]) -> None:
    templates_dir = Path(cfg.get("render", "templates_dir"))
    site_dir = Path(cfg.get("render", "site_dir"))
    dashboards_dir = Path(cfg.get("render", "dashboards_dir"))

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
