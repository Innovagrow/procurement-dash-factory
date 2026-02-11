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
    if df.empty:
        raise ValueError("Cannot create chart from empty dataframe")
    
    chart_type = chart_config.get('type', 'line')
    title = chart_config.get('title', 'Chart')
    
    # Ensure we have required columns
    if 'time' not in df.columns or 'value' not in df.columns:
        raise ValueError(f"Missing required columns. Available: {df.columns.tolist()}")
    
    # Handle geo column - might not exist in all datasets
    color_col = 'geo' if 'geo' in df.columns else None
    
    try:
        if chart_type == 'line':
            fig = px.line(df, x='time', y='value', color=color_col, title=title)
        elif chart_type == 'bar':
            fig = px.bar(df, x='time', y='value', color=color_col, title=title)
        elif chart_type == 'area':
            fig = px.area(df, x='time', y='value', color=color_col, title=title)
        else:
            fig = px.line(df, x='time', y='value', color=color_col, title=title)
        
        fig.update_layout(
            template='plotly_white',
            height=450,
            showlegend=True,
            hovermode='x unified'
        )
        
        return fig.to_json()
    except Exception as e:
        print(f"[PLOTLY ERROR] {e}")
        raise

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
    
    print(f"[FAST RENDER] Loaded {len(df)} rows for {dataset_code}")
    
    # Generate charts - create default charts if plan has none
    charts = []
    
    # Try to use plan visualizations first
    for page in plan.get('pages', []):
        for viz in page.get('visualizations', []):
            try:
                chart_json = generate_plotly_json(df, viz)
                charts.append({
                    'title': viz.get('title', 'Chart'),
                    'json': chart_json,
                    'page': page.get('title', 'Overview')
                })
                print(f"[FAST RENDER] Created chart: {viz.get('title')}")
            except Exception as e:
                print(f"[FAST RENDER] Chart generation failed: {e}")
    
    # If no charts from plan, create default ones
    if len(charts) == 0 and len(df) > 0:
        print("[FAST RENDER] No charts in plan, creating defaults")
        try:
            # Default line chart
            default_chart = generate_plotly_json(df, {'type': 'line', 'title': 'Data Over Time'})
            charts.append({
                'title': 'Data Over Time',
                'json': default_chart,
                'page': 'Overview'
            })
            print("[FAST RENDER] Created default chart")
        except Exception as e:
            print(f"[FAST RENDER] Default chart failed: {e}")
    
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
