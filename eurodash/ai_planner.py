"""
AI-Enhanced Report Planning

Generates intelligent dashboard plans using AI insights
"""
from __future__ import annotations
from pathlib import Path
import json

from .config import Config
from .ai_insights import generate_ai_insights, AIAnalysisResult
from .utils import write_json


def build_ai_enhanced_plan(cfg: Config, dataset_code: str) -> dict:
    """
    Build an AI-enhanced dashboard plan with intelligent insights and visualizations
    """
    # Generate AI insights
    ai_analysis = generate_ai_insights(cfg, dataset_code)
    
    # Convert to dashboard plan format
    plan = {
        "version": "2.0",  # AI-enhanced version
        "dataset": {
            "code": dataset_code,
            "title": dataset_code.replace("_", " ").title()
        },
        "template": "ai_enhanced_dashboard",
        "ai_insights": {
            "narrative": ai_analysis.narrative,
            "insights": [insight.model_dump() for insight in ai_analysis.insights],
            "key_metrics": ai_analysis.key_metrics
        },
        "pages": []
    }
    
    # Group visualizations by theme
    overview_visuals = []
    trend_visuals = []
    comparison_visuals = []
    detailed_visuals = []
    
    for viz in ai_analysis.visualizations:
        viz_dict = {
            "id": f"{viz.viz_type}_{len(overview_visuals) + len(trend_visuals) + len(comparison_visuals) + len(detailed_visuals)}",
            "kind": viz.viz_type,
            "title": viz.title,
            "description": viz.description,
            "sql": viz.sql,
            "config": viz.config
        }
        
        # Route to appropriate page based on priority and type
        if viz.priority == 1:
            if viz.viz_type == "kpi":
                overview_visuals.append(viz_dict)
            elif viz.viz_type == "line":
                trend_visuals.append(viz_dict)
            else:
                comparison_visuals.append(viz_dict)
        elif viz.priority <= 2:
            if "trend" in viz.title.lower() or "growth" in viz.title.lower():
                trend_visuals.append(viz_dict)
            elif "compare" in viz.title.lower() or "geographic" in viz.title.lower():
                comparison_visuals.append(viz_dict)
            else:
                overview_visuals.append(viz_dict)
        else:
            detailed_visuals.append(viz_dict)
    
    # Build pages
    if overview_visuals:
        plan["pages"].append({
            "id": "overview",
            "title": "Overview",
            "description": "Key metrics and summary insights",
            "visuals": overview_visuals
        })
    
    if trend_visuals:
        plan["pages"].append({
            "id": "trends",
            "title": "Trends & Patterns",
            "description": "Temporal analysis and growth patterns",
            "visuals": trend_visuals
        })
    
    if comparison_visuals:
        plan["pages"].append({
            "id": "comparison",
            "title": "Geographic Comparison",
            "description": "Cross-regional analysis and rankings",
            "visuals": comparison_visuals
        })
    
    if detailed_visuals:
        plan["pages"].append({
            "id": "details",
            "title": "Detailed Analysis",
            "description": "In-depth exploration and distributions",
            "visuals": detailed_visuals
        })
    
    # Add insights page
    plan["pages"].insert(0, {
        "id": "insights",
        "title": "AI Insights",
        "description": "Automated insights and recommendations",
        "visuals": [{
            "id": "ai_insights_summary",
            "kind": "insights",
            "title": "Automated Analysis",
            "description": "AI-generated insights from your data",
            "insights": [insight.model_dump() for insight in ai_analysis.insights]
        }]
    })
    
    return plan


def generate_ai_plans(cfg: Config, dataset_codes: list[str], output_dir: str | Path = "plans") -> None:
    """
    Generate AI-enhanced plans for multiple datasets
    """
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    
    for code in dataset_codes:
        print(f"Generating AI-enhanced plan for {code}...")
        try:
            plan = build_ai_enhanced_plan(cfg, code)
            write_json(output_path / f"{code}_ai.json", plan)
            print(f"  OK: Generated {len(plan['pages'])} pages with {len(plan['ai_insights']['insights'])} insights")
        except Exception as e:
            print(f"  ERROR: {e}")
