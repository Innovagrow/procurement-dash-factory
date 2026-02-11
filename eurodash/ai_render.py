"""
AI Dashboard Rendering

Renders AI-enhanced dashboards with intelligent insights
"""
from __future__ import annotations
from pathlib import Path
import json
from jinja2 import Environment, FileSystemLoader

from .config import Config
from .utils import ensure_dir


def _render_index_page(site_dir: Path, items: list[dict]) -> None:
    """Render the landing page with dashboard cards"""
    index_content = f"""---
title: "Eurostat AI Dashboards"
subtitle: "Intelligent Analytics Platform"
format:
  html:
    theme: cosmo
    css:
      - https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css
      - https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css
    toc: false
    page-layout: full
---

<style>
.dashboard-card {{
    border: none;
    border-radius: 10px;
    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
    transition: all 0.3s ease;
    height: 100%;
}}
.dashboard-card:hover {{
    transform: translateY(-5px);
    box-shadow: 0 8px 12px rgba(0,0,0,0.15);
}}
.dashboard-card .card-header {{
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    font-weight: bold;
    border-radius: 10px 10px 0 0 !important;
}}
.stat-badge {{
    display: inline-block;
    padding: 4px 12px;
    background: #f8f9fa;
    border-radius: 20px;
    font-size: 0.85em;
    margin: 2px;
}}
.hero-section {{
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    padding: 60px 20px;
    border-radius: 15px;
    margin-bottom: 40px;
    text-align: center;
}}
</style>

<div class="hero-section">
    <h1><i class="fas fa-chart-line"></i> Eurostat AI Dashboards</h1>
    <p class="lead">Power BI-Level Analytics with AI-Powered Insights</p>
    <p>Automated insights • Predictive forecasting • Anomaly detection • Natural language queries</p>
</div>

<h2><i class="fas fa-folder-open"></i> Available Dashboards</h2>

{f'<p class="text-muted">Found {len(items)} AI-enhanced dashboard(s)</p>' if items else '<p class="text-warning">No dashboards available. Run the AI pipeline first.</p>'}

<div class="row">
"""
    
    for item in items:
        index_content += f"""
    <div class="col-md-6 col-lg-4 mb-4">
        <div class="card dashboard-card">
            <div class="card-header">
                <i class="fas fa-brain"></i> {item['title']}
            </div>
            <div class="card-body">
                <p class="text-muted"><small>Dataset: <code>{item['code']}</code></small></p>
                
                <div class="mb-3">
                    <span class="stat-badge"><i class="fas fa-database"></i> {item['observations']:,} observations</span>
                    <span class="stat-badge"><i class="fas fa-globe"></i> {item['regions']} regions</span>
                </div>
                
                <div class="mb-3">
                    <small class="text-muted">
                        <i class="fas fa-calendar"></i> {item['time_range']}<br>
                        <i class="fas fa-lightbulb"></i> {item['insights_count']} AI insights
                    </small>
                </div>
                
                <a href="{item['path']}" class="btn btn-primary w-100">
                    <i class="fas fa-chart-area"></i> Open Dashboard
                </a>
            </div>
        </div>
    </div>
"""
    
    index_content += """
</div>

<div class="mt-5 p-4" style="background: #f8f9fa; border-radius: 10px;">
    <h3><i class="fas fa-info-circle"></i> Features</h3>
    <div class="row mt-3">
        <div class="col-md-3">
            <h5><i class="fas fa-brain text-primary"></i> AI Insights</h5>
            <p class="small text-muted">Automated pattern detection and recommendations</p>
        </div>
        <div class="col-md-3">
            <h5><i class="fas fa-chart-line text-success"></i> Forecasting</h5>
            <p class="small text-muted">Predictive analytics for future trends</p>
        </div>
        <div class="col-md-3">
            <h5><i class="fas fa-exclamation-triangle text-warning"></i> Anomalies</h5>
            <p class="small text-muted">Detect unusual patterns and outliers</p>
        </div>
        <div class="col-md-3">
            <h5><i class="fas fa-question-circle text-info"></i> NL Queries</h5>
            <p class="small text-muted">Ask questions in plain English</p>
        </div>
    </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
"""
    
    (site_dir / "index.qmd").write_text(index_content, encoding="utf-8")


def render_ai_dashboards(cfg: Config, dataset_codes: list[str]) -> None:
    """
    Render AI-enhanced dashboards for datasets using tabbed template
    """
    templates_dir = Path(cfg.get("render", "templates_dir"))
    site_dir = Path(cfg.get("render", "site_dir"))
    dashboards_dir = Path(cfg.get("render", "dashboards_dir"))
    
    ensure_dir(dashboards_dir)
    
    env = Environment(loader=FileSystemLoader(str(templates_dir)), autoescape=False)
    
    # Use tabbed template
    # ai_dash_tpl = env.get_template("ai_dashboard_tabbed.qmd.j2")
    ai_dash_tpl = env.get_template("ai_dashboard_simple.qmd.j2")
    
    items = []
    for code in dataset_codes:
        plan_path = Path("plans") / f"{code}_ai.json"
        
        # Skip if AI plan doesn't exist
        if not plan_path.exists():
            print(f"Warning: AI plan not found for {code}, skipping...")
            continue
        
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        out_path = dashboards_dir / f"{code}_ai.qmd"
        out_path.write_text(ai_dash_tpl.render(plan=plan, cfg=cfg.raw), encoding="utf-8")
        
        # Get stats for the dashboard
        from .config import Config
        from .db import connect
        import duckdb

        db_path = cfg.get("warehouse", "duckdb_path")
        con = duckdb.connect(db_path, read_only=True)
        stats = con.execute(f"""
            SELECT 
                COUNT(*) as obs,
                COUNT(DISTINCT geo) as regions,
                MIN(time) as start_time,
                MAX(time) as end_time
            FROM fact_observations
            WHERE dataset_code = '{code}'
        """).df()
        con.close()
        
        items.append({
            "code": code,
            "title": (plan.get("dataset") or {}).get("title") or code.replace("_", " ").title(),
            "path": f"dashboards/{code}_ai.html",
            "type": "AI Enhanced",
            "observations": int(stats.iloc[0]['obs']) if not stats.empty else 0,
            "regions": int(stats.iloc[0]['regions']) if not stats.empty else 0,
            "time_range": f"{stats.iloc[0]['start_time']} - {stats.iloc[0]['end_time']}" if not stats.empty else "N/A",
            "insights_count": len(plan.get('ai_insights', {}).get('insights', []))
        })
    
    # Render index page
    _render_index_page(site_dir, items)
