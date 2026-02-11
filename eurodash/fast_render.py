"""
Fast HTML rendering - replaces Quarto (30s -> 2s)
Direct HTML generation using Jinja2
"""
from pathlib import Path
from jinja2 import Environment, FileSystemLoader
import json
import plotly.express as px
import plotly.graph_objects as go
from typing import Dict, Any
import duckdb

def generate_plotly_json(df, chart_config: Dict[str, Any]) -> str:
    """Generate Plotly chart as JSON"""
    chart_type = chart_config.get('type', 'line')
    
    if chart_type == 'line':
        fig = px.line(df, x='time', y='value', color='geo', 
                     title=chart_config.get('title', 'Chart'))
    elif chart_type == 'bar':
        fig = px.bar(df, x='time', y='value', color='geo',
                    title=chart_config.get('title', 'Chart'))
    elif chart_type == 'area':
        fig = px.area(df, x='time', y='value', color='geo',
                     title=chart_config.get('title', 'Chart'))
    else:
        fig = px.line(df, x='time', y='value', color='geo')
    
    fig.update_layout(template='plotly_white', height=400)
    return fig.to_json()

def render_fast_dashboard(dataset_code: str, db_path: str, plan_path: Path, output_path: Path):
    """Render dashboard to HTML directly (no Quarto)"""
    
    # Load plan
    plan = json.loads(plan_path.read_text(encoding='utf-8'))
    
    # Load data
    con = duckdb.connect(db_path, read_only=True)
    df = con.execute(f"""
        SELECT * FROM fact_observations 
        WHERE dataset_code = '{dataset_code}'
        ORDER BY time DESC
    """).df()
    con.close()
    
    # Generate charts
    charts = []
    for page in plan.get('pages', []):
        for viz in page.get('visualizations', []):
            try:
                chart_json = generate_plotly_json(df, viz)
                charts.append({
                    'title': viz.get('title', 'Chart'),
                    'json': chart_json,
                    'page': page.get('title', 'Overview')
                })
            except:
                pass
    
    # Calculate KPIs
    kpis = []
    if not df.empty:
        kpis = [
            {'label': 'Total Records', 'value': f"{len(df):,}"},
            {'label': 'Countries', 'value': str(df['geo'].nunique())},
            {'label': 'Time Periods', 'value': str(df['time'].nunique())},
            {'label': 'Latest Value', 'value': f"{df.iloc[0]['value']:.2f}" if 'value' in df.columns else 'N/A'}
        ]
    
    # Load template
    template_dir = Path(__file__).parent / 'templates'
    env = Environment(loader=FileSystemLoader(template_dir))
    template = env.get_template('fast_dashboard.html.j2')
    
    # Render
    html = template.render(
        plan=plan,
        dataset_code=dataset_code,
        title=plan.get('dataset', {}).get('title', dataset_code),
        kpis=kpis,
        charts=charts,
        insights=plan.get('ai_insights', {}).get('insights', []),
        ai_summary=plan.get('ai_insights', {}).get('summary', '')
    )
    
    # Write output
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html, encoding='utf-8')
    
    return output_path
