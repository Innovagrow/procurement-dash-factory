"""
SMART Filter Database Builder
Auto-detects ALL mandatory dimensions and filters for each dataset
"""
import json
import requests
from pathlib import Path
import sys

sys.stdout.reconfigure(line_buffering=True)

print("="*60, flush=True)
print("SMART FILTER DATABASE BUILDER", flush=True)
print("Auto-detects mandatory dimensions for ALL datasets", flush=True)
print("="*60, flush=True)

# Load catalog
catalog_path = Path('site/_site/catalog.json')
catalog = json.loads(catalog_path.read_text())
all_datasets = [ds['code'] for ds in catalog['datasets']]

# Load existing database
db_path = Path('dataset_filters.json')
if db_path.exists():
    filter_db = json.loads(db_path.read_text())
else:
    filter_db = {}

print(f"\nTotal datasets: {len(all_datasets)}", flush=True)
print(f"Already processed: {len(filter_db)}", flush=True)
print(f"Remaining: {len(all_datasets) - len(filter_db)}", flush=True)
print("="*60, flush=True)
print("", flush=True)

def get_dataset_metadata(code):
    """Fetch dataset metadata/structure from Eurostat"""
    url = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{code}"
    params = {'format': 'JSON', 'compressed': 'false'}
    
    try:
        r = requests.get(url, params=params, timeout=8)
        if r.status_code == 200:
            return r.json()
    except:
        pass
    return None

def test_with_filters(code, filters):
    """Test if dataset returns data with given filters"""
    url = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{code}"
    params = {'format': 'JSON', 'compressed': 'false'}
    params.update(filters)
    
    try:
        r = requests.get(url, params=params, timeout=8)
        if r.status_code == 200:
            data = r.json()
            if 'value' in data and len(data['value']) > 0:
                return True
    except:
        pass
    return False

def smart_detect_filters(code):
    """Intelligently detect required filters for a dataset"""
    
    # Step 1: Try no filters first
    if test_with_filters(code, {}):
        return {}
    
    # Step 2: Get metadata to understand dimensions
    metadata = get_dataset_metadata(code)
    if not metadata or 'dimension' not in metadata:
        return None
    
    dimensions = metadata['dimension']
    filters = {}
    
    # Step 3: Analyze each dimension and select appropriate values
    for dim_id, dim_data in dimensions.items():
        # Skip time and freq dimensions (handled separately)
        if dim_id in ['time', 'freq']:
            continue
        
        category = dim_data.get('category', {})
        index = category.get('index', {})
        
        if not index:
            continue
        
        # Get available values
        if isinstance(index, dict):
            values = list(index.keys())
        elif isinstance(index, list):
            values = index
        else:
            continue
        
        if not values:
            continue
        
        # Priority selection logic
        selected = None
        
        # For 'geo' dimension - prefer EU aggregates
        if dim_id == 'geo':
            for pref in ['EU27_2020', 'EU28', 'EU27', 'EA19', 'EA20', 'TOTAL', '_T', 'T']:
                if pref in values:
                    selected = pref
                    break
            if not selected:
                selected = values[0]
        
        # For unit/measure dimensions - prefer totals
        elif dim_id in ['unit', 'measure', 'indic']:
            for pref in ['TOTAL', '_T', 'T', 'PC', 'EUR', 'INX']:
                if pref in values:
                    selected = pref
                    break
            if not selected:
                selected = values[0]
        
        # For product/classification dimensions - prefer totals
        elif 'prod' in dim_id.lower() or 'coicop' in dim_id.lower() or 'nace' in dim_id.lower() or 'sitc' in dim_id.lower():
            for pref in ['TOTAL', '_T', 'T', 'CP00', 'A', 'A10']:
                if pref in values:
                    selected = pref
                    break
            if not selected:
                selected = values[0]
        
        # Default - pick first value
        else:
            selected = values[0]
        
        if selected:
            filters[dim_id] = selected
    
    # Step 4: Test with detected filters
    if filters and test_with_filters(code, filters):
        return filters
    
    # Step 5: If complex filters didn't work, try simple geo patterns
    for geo in ['EU27_2020', 'EU28', 'TOTAL']:
        if test_with_filters(code, {'geo': geo}):
            return {'geo': geo}
    
    # No working combination found
    return None

# Process datasets
success = 0
failed = 0
skipped = 0

for i, code in enumerate(all_datasets, 1):
    # Skip if already done
    if code in filter_db:
        skipped += 1
        if skipped % 100 == 0:
            print(f"[{i}/{len(all_datasets)}] Skipped {skipped} already processed datasets", flush=True)
        continue
    
    print(f"[{i}/{len(all_datasets)}] {code}...", end=' ', flush=True)
    
    try:
        filters = smart_detect_filters(code)
        
        if filters is not None:
            filter_db[code] = filters
            success += 1
            if filters:
                print(f"OK with {filters}", flush=True)
            else:
                print("OK (no filters)", flush=True)
        else:
            filter_db[code] = {'_no_data': True}
            failed += 1
            print("NO DATA", flush=True)
        
        # Save every 10 datasets
        if (i - skipped) % 10 == 0:
            db_path.write_text(json.dumps(filter_db, indent=2))
            print(f"\n[SAVED] {len(filter_db)}/{len(all_datasets)} | Data:{success} NoData:{failed} Skip:{skipped}\n", flush=True)
        
    except KeyboardInterrupt:
        print("\n\n[INTERRUPTED] Saving...", flush=True)
        db_path.write_text(json.dumps(filter_db, indent=2))
        print(f"Saved {len(filter_db)} entries", flush=True)
        sys.exit(0)
    except Exception as e:
        print(f"ERROR: {str(e)[:50]}", flush=True)
        filter_db[code] = {'_error': str(e)[:100]}
        failed += 1

# Final save
db_path.write_text(json.dumps(filter_db, indent=2))

print("", flush=True)
print("="*60, flush=True)
print("COMPLETE!", flush=True)
print("="*60, flush=True)
print(f"Total processed: {len(filter_db)}", flush=True)
print(f"With data: {success} ({success/len(filter_db)*100:.1f}%)", flush=True)
print(f"No data: {failed} ({failed/len(filter_db)*100:.1f}%)", flush=True)
print("="*60, flush=True)
