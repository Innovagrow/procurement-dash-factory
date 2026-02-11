"""
Anomaly Detection

Statistical methods to identify unusual data points
"""
from __future__ import annotations
import pandas as pd
import numpy as np
from typing import Any
from pydantic import BaseModel


class Anomaly(BaseModel):
    """Detected anomaly"""
    time: str
    geo: str | None
    value: float
    expected_value: float
    deviation: float
    severity: str  # 'low', 'medium', 'high'
    method: str
    description: str


class AnomalyReport(BaseModel):
    """Complete anomaly detection report"""
    anomalies: list[Anomaly]
    total_detected: int
    detection_method: str
    threshold: float
    summary: str


def zscore_anomaly_detection(
    df: pd.DataFrame,
    threshold: float = 3.0
) -> list[Anomaly]:
    """
    Detect anomalies using Z-score method
    
    Points with |z-score| > threshold are anomalies
    """
    if df.empty or 'value' not in df.columns:
        return []
    
    anomalies = []
    
    # Calculate z-scores
    mean_val = df['value'].mean()
    std_val = df['value'].std()
    
    if std_val == 0:
        return []
    
    df['z_score'] = (df['value'] - mean_val) / std_val
    
    # Identify anomalies
    anomaly_mask = abs(df['z_score']) > threshold
    anomaly_df = df[anomaly_mask].copy()
    
    for _, row in anomaly_df.iterrows():
        z_score = abs(row['z_score'])
        severity = 'high' if z_score > 4 else 'medium' if z_score > 3 else 'low'
        
        anomalies.append(Anomaly(
            time=str(row.get('time', 'unknown')),
            geo=str(row.get('geo')) if 'geo' in row and pd.notna(row.get('geo')) else None,
            value=float(row['value']),
            expected_value=float(mean_val),
            deviation=float((row['value'] - mean_val) / std_val),
            severity=severity,
            method='Z-Score',
            description=f"Value {row['value']:.2f} is {abs(row['value'] - mean_val):.2f} away from mean ({z_score:.2f} std deviations)"
        ))
    
    return anomalies


def iqr_anomaly_detection(
    df: pd.DataFrame,
    multiplier: float = 1.5
) -> list[Anomaly]:
    """
    Detect anomalies using Interquartile Range (IQR) method
    
    Points outside [Q1 - multiplier*IQR, Q3 + multiplier*IQR] are anomalies
    """
    if df.empty or 'value' not in df.columns:
        return []
    
    anomalies = []
    
    q1 = df['value'].quantile(0.25)
    q3 = df['value'].quantile(0.75)
    iqr = q3 - q1
    
    lower_bound = q1 - multiplier * iqr
    upper_bound = q3 + multiplier * iqr
    
    # Identify anomalies
    anomaly_mask = (df['value'] < lower_bound) | (df['value'] > upper_bound)
    anomaly_df = df[anomaly_mask].copy()
    
    median_val = df['value'].median()
    
    for _, row in anomaly_df.iterrows():
        value = row['value']
        
        if value < lower_bound:
            deviation_type = 'below'
            expected = lower_bound
        else:
            deviation_type = 'above'
            expected = upper_bound
        
        severity = 'high' if abs(value - median_val) > 2 * iqr else 'medium'
        
        anomalies.append(Anomaly(
            time=str(row.get('time', 'unknown')),
            geo=str(row.get('geo')) if 'geo' in row and pd.notna(row.get('geo')) else None,
            value=float(value),
            expected_value=float(expected),
            deviation=float(abs(value - expected)),
            severity=severity,
            method='IQR',
            description=f"Value {value:.2f} is {deviation_type} the expected range [{lower_bound:.2f}, {upper_bound:.2f}]"
        ))
    
    return anomalies


def time_series_anomaly_detection(
    df: pd.DataFrame,
    window: int = 5,
    threshold: float = 2.0
) -> list[Anomaly]:
    """
    Detect anomalies in time series using moving statistics
    
    Points that deviate significantly from rolling mean are anomalies
    """
    if df.empty or 'time' not in df.columns or 'value' not in df.columns:
        return []
    
    anomalies = []
    
    # Sort by time
    df_sorted = df.sort_values('time').copy()
    
    # Calculate rolling statistics
    df_sorted['rolling_mean'] = df_sorted['value'].rolling(window=window, center=True).mean()
    df_sorted['rolling_std'] = df_sorted['value'].rolling(window=window, center=True).std()
    
    # Detect anomalies
    df_sorted['deviation'] = abs(df_sorted['value'] - df_sorted['rolling_mean']) / df_sorted['rolling_std'].replace(0, 1)
    
    anomaly_mask = df_sorted['deviation'] > threshold
    anomaly_df = df_sorted[anomaly_mask].copy()
    
    for _, row in anomaly_df.iterrows():
        if pd.isna(row['rolling_mean']):
            continue
        
        deviation = row['deviation']
        severity = 'high' if deviation > 3 else 'medium' if deviation > 2 else 'low'
        
        anomalies.append(Anomaly(
            time=str(row['time']),
            geo=str(row.get('geo')) if 'geo' in row and pd.notna(row.get('geo')) else None,
            value=float(row['value']),
            expected_value=float(row['rolling_mean']),
            deviation=float(deviation),
            severity=severity,
            method='Time Series',
            description=f"Value {row['value']:.2f} deviates from local trend (expected ~{row['rolling_mean']:.2f})"
        ))
    
    return anomalies


def detect_anomalies(
    df: pd.DataFrame,
    method: str = "auto"
) -> AnomalyReport:
    """
    Detect anomalies in dataset
    
    Args:
        df: DataFrame with data
        method: 'auto', 'zscore', 'iqr', or 'timeseries'
    
    Returns:
        AnomalyReport with detected anomalies
    """
    if df.empty:
        return AnomalyReport(
            anomalies=[],
            total_detected=0,
            detection_method="none",
            threshold=0.0,
            summary="No data available for anomaly detection"
        )
    
    # Auto-select method based on data characteristics
    if method == "auto":
        has_time = 'time' in df.columns and len(df) > 10
        method = "timeseries" if has_time else "zscore"
    
    # Detect anomalies
    if method == "zscore":
        anomalies = zscore_anomaly_detection(df, threshold=3.0)
        detection_method = "Z-Score (threshold=3.0)"
        threshold = 3.0
    elif method == "iqr":
        anomalies = iqr_anomaly_detection(df, multiplier=1.5)
        detection_method = "Interquartile Range (IQR)"
        threshold = 1.5
    else:  # timeseries
        anomalies = time_series_anomaly_detection(df, window=5, threshold=2.0)
        detection_method = "Time Series Analysis"
        threshold = 2.0
    
    # Generate summary
    if len(anomalies) == 0:
        summary = "No significant anomalies detected in the dataset."
    else:
        high_severity = sum(1 for a in anomalies if a.severity == 'high')
        summary = f"Detected {len(anomalies)} anomalies: {high_severity} high severity"
    
    return AnomalyReport(
        anomalies=sorted(anomalies, key=lambda x: x.deviation, reverse=True),
        total_detected=len(anomalies),
        detection_method=detection_method,
        threshold=threshold,
        summary=summary
    )
