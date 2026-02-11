"""
LLM Integration for Advanced Analytics

Supports OpenAI GPT-4 and Anthropic Claude for advanced pattern detection
"""
from __future__ import annotations
import os
from typing import Any, Literal
import json
from pathlib import Path
import pandas as pd
from pydantic import BaseModel, Field


class LLMConfig(BaseModel):
    """LLM Configuration"""
    provider: Literal["openai", "anthropic", "azure", "local"] = "openai"
    api_key: str | None = None
    model: str = "gpt-4"
    temperature: float = 0.3
    max_tokens: int = 2000


class LLMInsight(BaseModel):
    """Advanced insight from LLM"""
    title: str
    description: str
    insight_type: str
    confidence: float = Field(ge=0.0, le=1.0)
    evidence: list[str] = Field(default_factory=list)
    recommendation: str | None = None


class LLMAnalysis(BaseModel):
    """Complete LLM analysis result"""
    insights: list[LLMInsight]
    narrative: str
    key_findings: list[str]
    recommendations: list[str]
    patterns_detected: dict[str, Any]


def get_llm_config() -> LLMConfig | None:
    """Load LLM configuration from environment or config file"""
    # Check for environment variables
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("ANTHROPIC_API_KEY")
    provider = "openai" if os.getenv("OPENAI_API_KEY") else "anthropic"
    
    # Check for config file
    config_file = Path("llm_config.json")
    if config_file.exists():
        config_data = json.loads(config_file.read_text())
        return LLMConfig(**config_data)
    
    if api_key:
        return LLMConfig(api_key=api_key, provider=provider)
    
    return None


async def analyze_with_openai(
    data_summary: dict[str, Any],
    config: LLMConfig
) -> LLMAnalysis:
    """Use OpenAI GPT-4 for analysis"""
    try:
        import openai
    except ImportError:
        raise ImportError("Install openai: pip install openai")
    
    client = openai.OpenAI(api_key=config.api_key)
    
    prompt = f"""Analyze this dataset and provide intelligent insights like Power BI would:

Dataset Summary:
{json.dumps(data_summary, indent=2)}

Provide:
1. Key patterns and trends you detect
2. Anomalies or unusual data points
3. Correlations between variables
4. Predictive insights
5. Actionable recommendations

Format your response as JSON with this structure:
{{
  "insights": [
    {{
      "title": "Insight title",
      "description": "Detailed description",
      "insight_type": "trend|anomaly|correlation|forecast|recommendation",
      "confidence": 0.0-1.0,
      "evidence": ["data point 1", "data point 2"],
      "recommendation": "What to do about this"
    }}
  ],
  "narrative": "Natural language summary of the entire analysis",
  "key_findings": ["Finding 1", "Finding 2"],
  "recommendations": ["Action 1", "Action 2"],
  "patterns_detected": {{"pattern_name": "description"}}
}}
"""
    
    response = client.chat.completions.create(
        model=config.model,
        messages=[
            {"role": "system", "content": "You are an expert data analyst specializing in business intelligence and pattern recognition."},
            {"role": "user", "content": prompt}
        ],
        temperature=config.temperature,
        max_tokens=config.max_tokens,
        response_format={"type": "json_object"}
    )
    
    result = json.loads(response.choices[0].message.content)
    return LLMAnalysis(**result)


async def analyze_with_anthropic(
    data_summary: dict[str, Any],
    config: LLMConfig
) -> LLMAnalysis:
    """Use Anthropic Claude for analysis"""
    try:
        import anthropic
    except ImportError:
        raise ImportError("Install anthropic: pip install anthropic")
    
    client = anthropic.Anthropic(api_key=config.api_key)
    
    prompt = f"""Analyze this dataset and provide intelligent insights:

{json.dumps(data_summary, indent=2)}

Provide advanced pattern detection, anomalies, correlations, and recommendations in JSON format."""
    
    message = client.messages.create(
        model=config.model or "claude-3-5-sonnet-20241022",
        max_tokens=config.max_tokens,
        temperature=config.temperature,
        messages=[
            {"role": "user", "content": prompt}
        ]
    )
    
    result = json.loads(message.content[0].text)
    return LLMAnalysis(**result)


async def get_llm_insights(
    data_summary: dict[str, Any],
    config: LLMConfig | None = None
) -> LLMAnalysis | None:
    """
    Get advanced insights from LLM
    
    Args:
        data_summary: Statistical summary and sample data
        config: LLM configuration (optional, will auto-detect)
    
    Returns:
        Advanced analysis or None if LLM not configured
    """
    if config is None:
        config = get_llm_config()
    
    if config is None:
        return None
    
    try:
        if config.provider == "openai":
            return await analyze_with_openai(data_summary, config)
        elif config.provider == "anthropic":
            return await analyze_with_anthropic(data_summary, config)
        else:
            return None
    except Exception as e:
        print(f"LLM analysis failed: {e}")
        return None


def create_data_summary_for_llm(
    df: pd.DataFrame,
    stats: dict[str, Any],
    dataset_code: str
) -> dict[str, Any]:
    """Create a comprehensive data summary for LLM analysis"""
    summary = {
        "dataset_code": dataset_code,
        "statistics": stats,
        "sample_data": df.head(20).to_dict('records') if not df.empty else [],
        "column_types": {col: str(dtype) for col, dtype in df.dtypes.items()} if not df.empty else {},
        "missing_values": df.isnull().sum().to_dict() if not df.empty else {},
    }
    
    # Add time series info if available
    if 'time' in df.columns and not df.empty:
        time_analysis = {
            "is_time_series": True,
            "time_range": [str(df['time'].min()), str(df['time'].max())],
            "frequency": "detect_from_data",
            "trend": "increasing" if df['value'].iloc[-1] > df['value'].iloc[0] else "decreasing"
        }
        summary["time_series"] = time_analysis
    
    return summary
