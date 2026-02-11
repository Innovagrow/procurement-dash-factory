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
        response = http_get(url, timeout=10)
        return response.json()
    except:
        return {}

def detect_dimensions(structure: Dict[str, Any]) -> Dict[str, str]:
    """Auto-detect dimension filters from structure"""
    if not structure or 'dimension' not in structure:
        return {}
    
    dimensions = structure.get('dimension', {})
    filters = {}
    
    for dim_name, dim_data in dimensions.items():
        if dim_name in ['time', 'geo', 'freq']:
            continue  # Handle these separately
        
        # Get categories for this dimension
        category = dim_data.get('category', {})
        index = category.get('index', {})
        
        if not index:
            continue
        
        # Try to find TOTAL, T, or first value
        if isinstance(index, dict):
            keys = list(index.keys())
            
            # Priority order for common values
            for preferred in ['TOTAL', 'T', 'TOT', 'EU27_2020', 'EU28']:
                if preferred in keys:
                    filters[dim_name] = preferred
                    break
            else:
                # Use first available value
                if keys:
                    filters[dim_name] = keys[0]
    
    return filters

def smart_ingest_dataset(cfg, dataset_code: str) -> 'pd.DataFrame':
    """Ingest with auto-detected filters"""
    from .ingest import ingest_dataset
    
    # Try 1: Default filters (what we do now)
    try:
        df = ingest_dataset(cfg, dataset_code)
        if not df.empty:
            return df
    except:
        pass
    
    # Try 2: Get structure and auto-detect filters
    structure = get_dataset_structure(dataset_code)
    filters = detect_dimensions(structure)
    
    if filters:
        try:
            df = ingest_dataset(cfg, dataset_code, filters=filters)
            if not df.empty:
                return df
        except:
            pass
    
    # Try 3: Without any filters (some datasets need this)
    try:
        df = ingest_dataset(cfg, dataset_code, filters={})
        if not df.empty:
            return df
    except:
        pass
    
    # Give up - no data available
    import pandas as pd
    return pd.DataFrame()
