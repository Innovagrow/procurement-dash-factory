"""
Smart ingestion that auto-detects required filters per dataset
"""
import requests
from typing import Dict, Any
from .utils import http_get

def get_dataset_structure(dataset_code: str) -> Dict[str, Any]:
    """Get dataset structure/metadata from Eurostat"""
    url = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset_code}?format=JSON&compressed=false"
    
    try:
        response = http_get(url, timeout=15)
        return response.json()
    except Exception as e:
        print(f"[SMART] Failed to get structure for {dataset_code}: {e}")
        return {}

def detect_dimensions(structure: Dict[str, Any]) -> Dict[str, str]:
    """Auto-detect dimension filters from structure"""
    if not structure or 'dimension' not in structure:
        return {}
    
    dimensions = structure.get('dimension', {})
    filters = {}
    
    for dim_name, dim_data in dimensions.items():
        # Skip time and freq - let API return all
        if dim_name.lower() in ['time', 'freq']:
            continue
        
        # Get categories for this dimension
        category = dim_data.get('category', {})
        index = category.get('index', {})
        
        if not index:
            continue
        
        # Try to find TOTAL, T, or aggregates
        if isinstance(index, dict):
            keys = list(index.keys())
            
            # Priority order for common values
            priority = ['TOTAL', '_T', 'T', 'TOT', 'EU27_2020', 'EU28', 'EU27', 'EA19', 'EA']
            
            for preferred in priority:
                if preferred in keys:
                    filters[dim_name] = preferred
                    break
            else:
                # Use first available value as fallback
                if keys:
                    filters[dim_name] = keys[0]
    
    return filters

def smart_ingest_dataset(cfg, dataset_code: str) -> 'pd.DataFrame':
    """
    Smart ingestion with automatic filter detection
    Tries multiple strategies to get data from Eurostat
    """
    import pandas as pd
    from .ingest import ingest_dataset
    
    print(f"[SMART INGEST] Starting for {dataset_code}")
    
    # Try 1: No filters first (works for most datasets)
    try:
        print(f"[SMART INGEST] Try 1: No filters")
        df = ingest_dataset(cfg, dataset_code, filters={})
        if len(df) > 0:
            print(f"[SMART INGEST] ✓ Success with no filters: {len(df)} rows")
            return df
    except Exception as e:
        print(f"[SMART INGEST] ✗ No filters failed: {str(e)[:100]}")
    
    # Try 2: Auto-detect structure and apply smart filters
    try:
        print(f"[SMART INGEST] Try 2: Auto-detecting filters from structure")
        structure = get_dataset_structure(dataset_code)
        if structure:
            filters = detect_dimensions(structure)
            if filters:
                print(f"[SMART INGEST] Detected filters: {filters}")
                df = ingest_dataset(cfg, dataset_code, filters=filters)
                if len(df) > 0:
                    print(f"[SMART INGEST] ✓ Success with auto filters: {len(df)} rows")
                    return df
    except Exception as e:
        print(f"[SMART INGEST] ✗ Auto-detect failed: {str(e)[:100]}")
    
    # Try 3: Common filter combinations
    common_filters = [
        {'geo': 'EU27_2020'},
        {'geo': 'EU28'},
        {'geo': 'TOTAL'},
        {'geo': 'EU27_2020', 'unit': 'EUR'},
        {},  # Empty as final fallback
    ]
    
    for i, filters in enumerate(common_filters, 3):
        try:
            print(f"[SMART INGEST] Try {i}: Filters {filters}")
            df = ingest_dataset(cfg, dataset_code, filters=filters)
            if len(df) > 0:
                print(f"[SMART INGEST] ✓ Success: {len(df)} rows")
                return df
        except Exception as e:
            print(f"[SMART INGEST] ✗ Failed: {str(e)[:100]}")
    
    # No data found after all attempts
    print(f"[SMART INGEST] ✗✗ FAILED: No data found for {dataset_code} after all attempts")
    return pd.DataFrame()
