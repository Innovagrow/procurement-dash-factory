"""
Parallel processing for data fetch + AI analysis
"""
import concurrent.futures
from typing import Tuple
import pandas as pd
from .config import Config
from .smart_ingest import smart_ingest_dataset

def fetch_and_analyze_parallel(cfg: Config, dataset_code: str) -> Tuple[pd.DataFrame, dict]:
    """
    Run data fetching and AI prep in parallel
    Returns: (dataframe, ai_analysis)
    """
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        # Start data fetch
        data_future = executor.submit(smart_ingest_dataset, cfg, dataset_code)
        
        # Wait for data
        df = data_future.result()
        
        if df.empty:
            return df, {}
        
        # Return df with empty AI result (AI happens in build_ai_enhanced_plan)
        return df, {}

def generate_visualizations_parallel(df: pd.DataFrame, viz_configs: list) -> list:
    """Pre-generate visualization data in parallel"""
    
    def create_viz(config):
        import plotly.express as px
        chart_type = config.get('type', 'line')
        
        if chart_type == 'line':
            fig = px.line(df, x='time', y='value', color='geo', 
                         title=config.get('title', 'Chart'))
        elif chart_type == 'bar':
            fig = px.bar(df, x='time', y='value', color='geo',
                        title=config.get('title', 'Chart'))
        else:
            fig = px.line(df, x='time', y='value', color='geo')
        
        fig.update_layout(template='plotly_white', height=400)
        return fig.to_json()
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(create_viz, cfg) for cfg in viz_configs]
        results = [f.result() for f in concurrent.futures.as_completed(futures)]
    
    return results
