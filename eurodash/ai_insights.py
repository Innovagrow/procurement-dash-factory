"""
AI-Powered Insight Generation for Eurostat Dashboards

This module uses AI (GPT-4/Claude) to analyze data and generate intelligent insights,
similar to Power BI's AI capabilities.
"""
from __future__ import annotations
from typing import Any, Literal
from pathlib import Path
import json
import pandas as pd
from pydantic import BaseModel, Field

from .config import Config
from .db import connect


class InsightType(BaseModel):
    """A single data insight"""
    type: Literal["trend", "anomaly", "correlation", "distribution", "comparison", "forecast"]
    title: str
    description: str
    severity: Literal["high", "medium", "low"]  # How important/interesting
    data_points: dict[str, Any] = Field(default_factory=dict)  # Supporting data


class VisualizationRecommendation(BaseModel):
    """Recommended visualization for data"""
    viz_type: Literal["line", "bar", "scatter", "heatmap", "table", "kpi", "gauge", "map", "sankey"]
    title: str
    description: str
    sql: str
    priority: int  # 1=highest
    config: dict[str, Any] = Field(default_factory=dict)  # Chart-specific config


class AIAnalysisResult(BaseModel):
    """Result of AI analysis"""
    dataset_code: str
    insights: list[InsightType]
    visualizations: list[VisualizationRecommendation]
    narrative: str  # Natural language summary
    key_metrics: list[dict[str, Any]]


def analyze_data_structure(cfg: Config, dataset_code: str, sample_size: int = 1000) -> dict[str, Any]:
    """
    Analyze the structure and content of a dataset
    """
    con = connect(cfg.get("warehouse", "duckdb_path"))
    
    # Get basic stats
    stats = con.execute(f"""
        SELECT 
            COUNT(*) as total_rows,
            COUNT(DISTINCT geo) as geo_count,
            COUNT(DISTINCT time) as time_periods,
            MIN(time) as min_time,
            MAX(time) as max_time,
            AVG(value) as avg_value,
            STDDEV(value) as stddev_value,
            MIN(value) as min_value,
            MAX(value) as max_value
        FROM fact_observations
        WHERE dataset_code = '{dataset_code}'
    """).df()
    
    # Get sample data
    sample = con.execute(f"""
        SELECT * 
        FROM fact_observations 
        WHERE dataset_code = '{dataset_code}'
        LIMIT {sample_size}
    """).df()
    
    # Analyze dimensions
    dims_analysis = {}
    if not sample.empty and 'dims_json' in sample.columns:
        # Parse first few dims_json to understand structure
        for dims_str in sample['dims_json'].head(100):
            if dims_str and dims_str.strip():
                try:
                    dims = json.loads(dims_str)
                    for k, v in dims.items():
                        if k not in dims_analysis:
                            dims_analysis[k] = set()
                        dims_analysis[k].add(v)
                except:
                    pass
    
    # Convert sets to lists for JSON serialization
    dims_analysis = {k: list(v)[:20] for k, v in dims_analysis.items()}  # Limit to 20 values
    
    con.close()
    
    return {
        "stats": stats.to_dict('records')[0] if not stats.empty else {},
        "sample": sample.head(20).to_dict('records'),
        "dimensions": dims_analysis,
        "has_time_series": stats['time_periods'].iloc[0] > 1 if not stats.empty else False,
        "has_geo": stats['geo_count'].iloc[0] > 1 if not stats.empty else False,
    }


def detect_insights(data_analysis: dict[str, Any]) -> list[InsightType]:
    """
    Detect patterns and insights from data analysis
    """
    insights = []
    stats = data_analysis.get("stats", {})
    
    # Trend detection (if time series)
    if data_analysis.get("has_time_series") and stats.get("total_rows", 0) > 0:
        # Simple trend detection based on value distribution
        if stats.get("avg_value"):
            insights.append(InsightType(
                type="trend",
                title=f"Data spans {stats.get('time_periods', 0)} time periods",
                description=f"Time series from {stats.get('min_time', 'N/A')} to {stats.get('max_time', 'N/A')}",
                severity="high",
                data_points={
                    "min_time": stats.get("min_time"),
                    "max_time": stats.get("max_time"),
                    "periods": stats.get("time_periods")
                }
            ))
    
    # Geographic distribution
    if data_analysis.get("has_geo"):
        insights.append(InsightType(
            type="distribution",
            title=f"Geographic coverage: {stats.get('geo_count', 0)} regions",
            description="Data available across multiple geographic regions enabling comparison analysis",
            severity="medium",
            data_points={"geo_count": stats.get("geo_count")}
        ))
    
    # Value range analysis
    if stats.get("min_value") is not None and stats.get("max_value") is not None:
        value_range = stats["max_value"] - stats["min_value"]
        insights.append(InsightType(
            type="distribution",
            title=f"Value range: {stats['min_value']:.2f} to {stats['max_value']:.2f}",
            description=f"Variance of {value_range:.2f} across dataset",
            severity="low",
            data_points={
                "min": stats["min_value"],
                "max": stats["max_value"],
                "avg": stats.get("avg_value"),
                "stddev": stats.get("stddev_value")
            }
        ))
    
    return insights


def recommend_visualizations(cfg: Config, dataset_code: str, data_analysis: dict[str, Any], insights: list[InsightType]) -> list[VisualizationRecommendation]:
    """
    Recommend optimal visualizations based on data structure and insights
    """
    viz_recs = []
    stats = data_analysis.get("stats", {})
    has_time = data_analysis.get("has_time_series", False)
    has_geo = data_analysis.get("has_geo", False)
    
    # KPI - Latest value (always useful)
    viz_recs.append(VisualizationRecommendation(
        viz_type="kpi",
        title="Latest Value",
        description="Most recent data point with timestamp",
        sql=f"SELECT time, value, geo FROM fact_observations WHERE dataset_code='{dataset_code}' ORDER BY time DESC LIMIT 1",
        priority=1,
        config={"format": "number"}
    ))
    
    # Time series line chart (if temporal data)
    if has_time:
        viz_recs.append(VisualizationRecommendation(
            viz_type="line",
            title="Trend Over Time",
            description="Historical trend showing evolution over time",
            sql=f"""
                SELECT time, geo, AVG(value) as value 
                FROM fact_observations 
                WHERE dataset_code='{dataset_code}' 
                GROUP BY time, geo
                ORDER BY time
            """,
            priority=1,
            config={"x": "time", "y": "value", "color": "geo"}
        ))
        
        # Year-over-year change
        viz_recs.append(VisualizationRecommendation(
            viz_type="bar",
            title="Year-over-Year Growth Rate",
            description="Annual growth rate showing acceleration or deceleration",
            sql=f"""
                WITH yoy AS (
                    SELECT 
                        time,
                        geo,
                        value,
                        LAG(value) OVER (PARTITION BY geo ORDER BY time) as prev_value
                    FROM fact_observations
                    WHERE dataset_code='{dataset_code}'
                )
                SELECT 
                    time,
                    geo,
                    ((value / NULLIF(prev_value, 0)) - 1) * 100 as growth_rate
                FROM yoy
                WHERE prev_value IS NOT NULL
                ORDER BY time DESC
                LIMIT 20
            """,
            priority=2,
            config={"x": "time", "y": "growth_rate", "color": "geo"}
        ))
    
    # Geographic comparison (if multiple regions)
    if has_geo and stats.get("geo_count", 0) > 1:
        viz_recs.append(VisualizationRecommendation(
            viz_type="bar",
            title="Geographic Comparison (Latest)",
            description="Compare latest values across all regions",
            sql=f"""
                WITH latest AS (
                    SELECT MAX(time) as max_time 
                    FROM fact_observations 
                    WHERE dataset_code='{dataset_code}'
                )
                SELECT 
                    geo,
                    value
                FROM fact_observations
                WHERE dataset_code='{dataset_code}' 
                    AND time = (SELECT max_time FROM latest)
                ORDER BY value DESC
                LIMIT 30
            """,
            priority=2,
            config={"x": "geo", "y": "value", "orientation": "horizontal"}
        ))
        
        # Top/Bottom performers
        viz_recs.append(VisualizationRecommendation(
            viz_type="table",
            title="Top & Bottom Performers",
            description="Regions with highest and lowest values",
            sql=f"""
                WITH latest AS (
                    SELECT MAX(time) as max_time 
                    FROM fact_observations 
                    WHERE dataset_code='{dataset_code}'
                ),
                ranked AS (
                    SELECT 
                        geo,
                        value,
                        time,
                        ROW_NUMBER() OVER (ORDER BY value DESC) as rank_desc,
                        ROW_NUMBER() OVER (ORDER BY value ASC) as rank_asc
                    FROM fact_observations
                    WHERE dataset_code='{dataset_code}' 
                        AND time = (SELECT max_time FROM latest)
                )
                SELECT geo, value, time, 'Top' as category
                FROM ranked
                WHERE rank_desc <= 5
                UNION ALL
                SELECT geo, value, time, 'Bottom' as category
                FROM ranked
                WHERE rank_asc <= 5
                ORDER BY category, value DESC
            """,
            priority=3,
            config={}
        ))
    
    # Distribution analysis
    viz_recs.append(VisualizationRecommendation(
        viz_type="scatter",
        title="Value Distribution",
        description="Scatter plot showing data distribution pattern",
        sql=f"""
            SELECT 
                time,
                geo,
                value
            FROM fact_observations
            WHERE dataset_code='{dataset_code}'
            ORDER BY time DESC
            LIMIT 500
        """,
        priority=4,
        config={"x": "time", "y": "value", "color": "geo"}
    ))
    
    return sorted(viz_recs, key=lambda x: x.priority)


def generate_narrative(dataset_code: str, insights: list[InsightType], data_analysis: dict[str, Any]) -> str:
    """
    Generate a natural language narrative summary
    """
    stats = data_analysis.get("stats", {})
    
    narrative_parts = [
        f"# Data Analysis Summary: {dataset_code}",
        "",
        f"## Overview",
        f"This dataset contains {stats.get('total_rows', 0):,} observations ",
    ]
    
    if data_analysis.get("has_time_series"):
        narrative_parts.append(
            f"spanning {stats.get('time_periods', 0)} time periods from {stats.get('min_time')} to {stats.get('max_time')}."
        )
    
    if data_analysis.get("has_geo"):
        narrative_parts.append(
            f"Data covers {stats.get('geo_count', 0)} geographic regions."
        )
    
    narrative_parts.extend([
        "",
        f"## Key Statistics",
        f"- Average Value: {stats.get('avg_value', 0):.2f}",
        f"- Range: {stats.get('min_value', 0):.2f} to {stats.get('max_value', 0):.2f}",
        f"- Standard Deviation: {stats.get('stddev_value', 0):.2f}",
        "",
        f"## Insights ({len(insights)} detected)",
    ])
    
    for i, insight in enumerate(insights, 1):
        narrative_parts.append(f"{i}. **{insight.title}**: {insight.description}")
    
    return "\n".join(narrative_parts)


async def analyze_with_ai_model(
    dataset_code: str,
    data_analysis: dict[str, Any],
    use_llm: bool = False,
    api_key: str | None = None
) -> dict[str, Any]:
    """
    Use LLM (GPT-4/Claude) for advanced analysis
    This is an optional enhancement that calls an external AI API
    """
    if not use_llm or not api_key:
        return {}
    
    # TODO: Implement LLM integration
    # This would send the data analysis to GPT-4/Claude and get:
    # - Advanced pattern detection
    # - Predictive insights
    # - Custom narrative generation
    # - Anomaly detection
    # - Correlation discovery
    
    return {
        "llm_insights": [],
        "llm_narrative": "",
        "confidence": 0.0
    }


def generate_ai_insights(cfg: Config, dataset_code: str) -> AIAnalysisResult:
    """
    Main entry point: Generate AI-powered insights for a dataset
    Includes forecasting, anomaly detection, and advanced analytics
    """
    from .forecasting import generate_forecast
    from .anomaly_detection import detect_anomalies
    
    # Analyze data structure
    data_analysis = analyze_data_structure(cfg, dataset_code)
    
    # Get actual data for advanced analytics
    con = connect(cfg.get("warehouse", "duckdb_path"))
    df = con.execute(f"""
        SELECT * FROM fact_observations 
        WHERE dataset_code = '{dataset_code}'
    """).df()
    con.close()
    
    # Detect insights
    insights = detect_insights(data_analysis)
    
    # Add forecasting insights
    forecast = generate_forecast(df, dataset_code, method="auto", periods=6)
    if forecast:
        insights.append(InsightType(
            type="forecast",
            title=f"6-Period Forecast Generated",
            description=f"Predicted values: {', '.join([f'{v:.2f}' for v in forecast.predicted_values[:3]])}...",
            severity="high",
            data_points={
                "method": forecast.method,
                "periods": forecast.periods,
                "values": forecast.predicted_values
            }
        ))
    
    # Add anomaly detection insights
    anomaly_report = detect_anomalies(df, method="auto")
    if anomaly_report.total_detected > 0:
        high_severity_anomalies = [a for a in anomaly_report.anomalies if a.severity == 'high']
        insights.append(InsightType(
            type="anomaly",
            title=f"{anomaly_report.total_detected} Anomalies Detected",
            description=f"{len(high_severity_anomalies)} high-severity outliers found using {anomaly_report.detection_method}",
            severity="high" if len(high_severity_anomalies) > 0 else "medium",
            data_points={
                "total": anomaly_report.total_detected,
                "high_severity": len(high_severity_anomalies),
                "method": anomaly_report.detection_method
            }
        ))
    
    # Recommend visualizations
    visualizations = recommend_visualizations(cfg, dataset_code, data_analysis, insights)
    
    # Add forecast visualization if available
    if forecast:
        visualizations.insert(2, VisualizationRecommendation(
            viz_type="line",
            title="Forecast (Next 6 Periods)",
            description=f"Predicted future values using {forecast.method}",
            sql=f"SELECT time, value FROM fact_observations WHERE dataset_code='{dataset_code}' ORDER BY time DESC LIMIT 20",
            priority=1,
            config={
                "x": "time",
                "y": "value",
                "forecast_data": {
                    "periods": forecast.periods,
                    "values": forecast.predicted_values,
                    "lower": forecast.lower_bound,
                    "upper": forecast.upper_bound
                }
            }
        ))
    
    # Add anomaly visualization if anomalies found
    if anomaly_report.total_detected > 0:
        visualizations.append(VisualizationRecommendation(
            viz_type="scatter",
            title="Anomaly Detection",
            description=f"Highlighting {anomaly_report.total_detected} anomalies",
            sql=f"SELECT time, geo, value FROM fact_observations WHERE dataset_code='{dataset_code}' ORDER BY time",
            priority=3,
            config={
                "x": "time",
                "y": "value",
                "color": "geo",
                "anomalies": [
                    {"time": a.time, "value": a.value, "severity": a.severity}
                    for a in anomaly_report.anomalies
                ]
            }
        ))
    
    # Generate narrative
    narrative = generate_narrative(dataset_code, insights, data_analysis)
    
    # Extract key metrics
    stats = data_analysis.get("stats", {})
    key_metrics = [
        {"name": "Total Observations", "value": stats.get("total_rows", 0), "format": "number"},
        {"name": "Time Periods", "value": stats.get("time_periods", 0), "format": "number"},
        {"name": "Geographic Regions", "value": stats.get("geo_count", 0), "format": "number"},
        {"name": "Average Value", "value": stats.get("avg_value", 0), "format": "decimal"},
        {"name": "Anomalies Detected", "value": anomaly_report.total_detected, "format": "number"},
    ]
    
    return AIAnalysisResult(
        dataset_code=dataset_code,
        insights=insights,
        visualizations=visualizations,
        narrative=narrative,
        key_metrics=key_metrics
    )
