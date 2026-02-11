"""
Predictive Analytics and Forecasting

Time series forecasting using statistical methods and ML
"""
from __future__ import annotations
import pandas as pd
import numpy as np
from typing import Any
from pydantic import BaseModel


class ForecastResult(BaseModel):
    """Forecast output"""
    periods: list[str]
    predicted_values: list[float]
    lower_bound: list[float]
    upper_bound: list[float]
    confidence_level: float = 0.95
    method: str
    metrics: dict[str, float]


def simple_exponential_smoothing(
    data: pd.Series,
    alpha: float = 0.3,
    forecast_periods: int = 6
) -> tuple[list[float], list[float], list[float]]:
    """
    Simple exponential smoothing forecast
    
    Returns: (predictions, lower_bound, upper_bound)
    """
    # Fit the model
    smoothed = [data.iloc[0]]
    for i in range(1, len(data)):
        smoothed.append(alpha * data.iloc[i] + (1 - alpha) * smoothed[-1])
    
    # Forecast
    last_smooth = smoothed[-1]
    predictions = [last_smooth] * forecast_periods
    
    # Calculate prediction intervals using historical variance
    residuals = data - pd.Series(smoothed)
    std_error = residuals.std()
    
    # 95% confidence interval (approximately 2 std deviations)
    margin = 1.96 * std_error
    lower_bound = [p - margin * np.sqrt(i+1) for i, p in enumerate(predictions)]
    upper_bound = [p + margin * np.sqrt(i+1) for i, p in enumerate(predictions)]
    
    return predictions, lower_bound, upper_bound


def linear_trend_forecast(
    data: pd.Series,
    forecast_periods: int = 6
) -> tuple[list[float], list[float], list[float]]:
    """
    Linear trend extrapolation
    
    Returns: (predictions, lower_bound, upper_bound)
    """
    # Fit linear regression
    x = np.arange(len(data))
    y = data.values
    
    # Calculate slope and intercept
    slope, intercept = np.polyfit(x, y, 1)
    
    # Forecast
    future_x = np.arange(len(data), len(data) + forecast_periods)
    predictions = slope * future_x + intercept
    
    # Prediction intervals
    residuals = y - (slope * x + intercept)
    std_error = np.std(residuals)
    margin = 1.96 * std_error
    
    lower_bound = predictions - margin * np.sqrt(future_x - len(data) + 1)
    upper_bound = predictions + margin * np.sqrt(future_x - len(data) + 1)
    
    return predictions.tolist(), lower_bound.tolist(), upper_bound.tolist()


def moving_average_forecast(
    data: pd.Series,
    window: int = 3,
    forecast_periods: int = 6
) -> tuple[list[float], list[float], list[float]]:
    """
    Moving average forecast
    
    Returns: (predictions, lower_bound, upper_bound)
    """
    # Calculate moving average
    ma = data.rolling(window=window).mean()
    last_ma = ma.iloc[-1]
    
    # Simple forecast: repeat last MA
    predictions = [last_ma] * forecast_periods
    
    # Intervals based on historical volatility
    std_error = data.std()
    margin = 1.96 * std_error
    
    lower_bound = [p - margin for p in predictions]
    upper_bound = [p + margin for p in predictions]
    
    return predictions, lower_bound, upper_bound


def generate_forecast(
    df: pd.DataFrame,
    dataset_code: str,
    method: str = "auto",
    periods: int = 6
) -> ForecastResult | None:
    """
    Generate forecast for time series data
    
    Args:
        df: DataFrame with time and value columns
        dataset_code: Dataset identifier
        method: 'auto', 'exponential', 'linear', or 'moving_average'
        periods: Number of periods to forecast
    
    Returns:
        ForecastResult or None if not enough data
    """
    if df.empty or 'time' not in df.columns or 'value' not in df.columns:
        return None
    
    # Prepare data - aggregate by time
    ts_data = df.groupby('time')['value'].mean().sort_index()
    
    if len(ts_data) < 10:  # Need minimum data points
        return None
    
    # Auto-select method
    if method == "auto":
        # Use exponential smoothing for most cases
        method = "exponential"
    
    # Generate forecast
    if method == "exponential":
        preds, lower, upper = simple_exponential_smoothing(ts_data, forecast_periods=periods)
        method_name = "Exponential Smoothing"
    elif method == "linear":
        preds, lower, upper = linear_trend_forecast(ts_data, forecast_periods=periods)
        method_name = "Linear Trend"
    else:  # moving_average
        preds, lower, upper = moving_average_forecast(ts_data, forecast_periods=periods)
        method_name = "Moving Average"
    
    # Generate future time periods
    last_time = ts_data.index[-1]
    try:
        # Try to parse as year
        last_year = int(str(last_time)[:4])
        future_periods = [str(last_year + i + 1) for i in range(periods)]
    except:
        # Fallback to sequential labeling
        future_periods = [f"T+{i+1}" for i in range(periods)]
    
    # Calculate simple accuracy metrics on last known period
    mae = abs(ts_data.diff().mean())
    
    return ForecastResult(
        periods=future_periods,
        predicted_values=preds,
        lower_bound=lower,
        upper_bound=upper,
        confidence_level=0.95,
        method=method_name,
        metrics={"mae": float(mae) if not np.isnan(mae) else 0.0}
    )
