"""
Build permanent filter database for all 7,616 datasets
Run once, use forever!
"""
import json
import time
from pathlib import Path
import sys

def load_catalog_datasets():
    """Get all dataset codes from catalog.json"""
    catalog_path = Path('site/_site/catalog.json')
    if not catalog_path.exists():
        print("ERROR: catalog.json not found. Run 'py update_catalog.py' first")
        sys.exit(1)
    
    catalog = json.loads(catalog_path.read_text())
    return [ds['code'] for ds in catalog['datasets']]

def test_filters(dataset_code, filters):
    """Test if filters work for a dataset (just check API, don't ingest)"""
    import requests
    
    # Build Eurostat API URL
    base_url = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset_code}"
    
    # Add filters to URL
    if filters:
        filter_str = '&'.join([f"{k}={v}" for k, v in filters.items()])
        url = f"{base_url}?{filter_str}&format=JSON&compressed=false"
    else:
        url = f"{base_url}?format=JSON&compressed=false"
    
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            data = response.json()
            # Check if has actual data values
            if 'value' in data and len(data['value']) > 0:
                return True
        return False
    except:
        return False

def get_dataset_dimensions(dataset_code):
    """Get available dimensions for a dataset"""
    import requests
    
    url = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset_code}?format=JSON&compressed=false"
    
    try:
        response = requests.get(url, timeout=10)
        if response.status_code == 200:
            data = response.json()
            return data.get('dimension', {})
        return {}
    except:
        return {}

def find_working_filters(dataset_code):
    """Find working filters for a dataset"""
    print(f"\n[{dataset_code}]")
    
    # Try 1: No filters
    print(f"  [1/4] No filters...")
    if test_filters(dataset_code, {}):
        print(f"    ✓ Success")
        return {}
    
    # Try 2: Get dimensions and auto-select
    print(f"  [2/4] Auto-detecting dimensions...")
    dimensions = get_dataset_dimensions(dataset_code)
    
    if dimensions:
        # Build smart filters
        filters = {}
        for dim_id, dim_data in dimensions.items():
            if dim_id in ['time', 'freq']:
                continue
            
            category = dim_data.get('category', {})
            index = category.get('index', {})
            
            if isinstance(index, dict):
                keys = list(index.keys())
                
                # Priority values
                for pref in ['TOTAL', '_T', 'T', 'EU27_2020', 'EU28']:
                    if pref in keys:
                        filters[dim_id] = pref
                        break
                else:
                    if keys:
                        filters[dim_id] = keys[0]
        
        if filters:
            print(f"    Testing: {filters}")
            if test_filters(dataset_code, filters):
                print(f"    ✓ Success")
                return filters
    
    # Try 3: Common patterns
    patterns = [
        {'geo': 'EU27_2020'},
        {'geo': 'EU28'},
        {'geo': 'TOTAL'},
    ]
    
    print(f"  [3/4] Common patterns...")
    for filters in patterns:
        if test_filters(dataset_code, filters):
            print(f"    ✓ Success with {filters}")
            return filters
    
    # Failed
    print(f"    ✗ No working filters found")
    return None

def build_database():
    """Build the filter database"""
    
    # Load existing database
    db_path = Path('dataset_filters.json')
    if db_path.exists():
        filter_db = json.loads(db_path.read_text())
        print(f"Loaded {len(filter_db)} existing entries\n")
    else:
        filter_db = {}
    
    # Get all datasets
    all_datasets = load_catalog_datasets()
    print(f"Total datasets: {len(all_datasets)}\n")
    
    # Process each
    success = 0
    failed = 0
    skipped = 0
    
    for i, dataset_code in enumerate(all_datasets, 1):
        # Skip if already done
        if dataset_code in filter_db:
            print(f"[{i}/{len(all_datasets)}] {dataset_code} - Already done")
            skipped += 1
            continue
        
        print(f"[{i}/{len(all_datasets)}] Testing {dataset_code}")
        
        try:
            filters = find_working_filters(dataset_code)
            
            if filters is not None:
                filter_db[dataset_code] = filters
                success += 1
            else:
                filter_db[dataset_code] = {"_no_data": True}
                failed += 1
            
            # Save every 5 datasets
            if i % 5 == 0:
                db_path.write_text(json.dumps(filter_db, indent=2))
                print(f"\n[SAVED] Progress: {i}/{len(all_datasets)} | Success: {success} | Failed: {failed} | Skipped: {skipped}\n")
            
            # Rate limit - don't hammer API
            time.sleep(1)
            
        except KeyboardInterrupt:
            print(f"\n\n[INTERRUPTED] Saving...")
            db_path.write_text(json.dumps(filter_db, indent=2))
            print(f"Saved {len(filter_db)} entries")
            return
        except Exception as e:
            print(f"  ERROR: {e}")
            filter_db[dataset_code] = {"_error": str(e)[:100]}
            failed += 1
    
    # Final save
    db_path.write_text(json.dumps(filter_db, indent=2))
    
    print("\n" + "="*60)
    print("COMPLETE!")
    print("="*60)
    print(f"Success: {success}")
    print(f"Failed: {failed}")
    print(f"Skipped: {skipped}")
    print(f"Total: {len(filter_db)}")
    print("="*60)

if __name__ == '__main__':
    print("="*60)
    print("FILTER DATABASE BUILDER")
    print("="*60)
    print("Testing all datasets to find working filters...")
    print("Time: ~2-3 hours")
    print("="*60)
    print()
    
    time.sleep(2)
    build_database()
