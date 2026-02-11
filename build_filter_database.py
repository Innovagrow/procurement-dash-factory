"""
One-time script to build permanent filter database for all 7,616 datasets
Run once, use forever - no more guessing!
"""
import json
import time
from pathlib import Path
from eurodash.config import Config
from eurodash.smart_ingest import get_dataset_structure, detect_dimensions
from eurodash.ingest import ingest_dataset
import duckdb

def load_all_datasets():
    """Get all dataset codes from catalog"""
    cfg = Config.load('config.yml')
    con = duckdb.connect(cfg.get('warehouse', 'duckdb_path'), read_only=True)
    
    datasets = con.execute("""
        SELECT DISTINCT dataset_code 
        FROM catalog_registry 
        ORDER BY dataset_code
    """).fetchall()
    
    con.close()
    return [d[0] for d in datasets]

def test_filter_combination(cfg, dataset_code, filters):
    """Test if a filter combination returns data"""
    try:
        df = ingest_dataset(cfg, dataset_code, filters=filters, max_rows=10)
        return len(df) > 0
    except:
        return False

def find_working_filters(cfg, dataset_code):
    """Find working filters for a dataset"""
    print(f"\n[{dataset_code}] Testing...")
    
    # Strategy 1: No filters
    print(f"  Try 1: No filters")
    if test_filter_combination(cfg, dataset_code, {}):
        print(f"  ✓ Works with no filters")
        return {}
    
    # Strategy 2: Get structure and detect smart filters
    print(f"  Try 2: Auto-detect from structure")
    structure = get_dataset_structure(dataset_code)
    if structure:
        filters = detect_dimensions(structure)
        if filters:
            print(f"  Testing: {filters}")
            if test_filter_combination(cfg, dataset_code, filters):
                print(f"  ✓ Works with auto-detected filters")
                return filters
    
    # Strategy 3: Common patterns
    common_patterns = [
        {'geo': 'EU27_2020'},
        {'geo': 'EU28'},
        {'geo': 'TOTAL'},
        {'geo': 'EU27_2020', 'time': 'last(5)'},
    ]
    
    for i, filters in enumerate(common_patterns, 3):
        print(f"  Try {i}: {filters}")
        if test_filter_combination(cfg, dataset_code, filters):
            print(f"  ✓ Works with {filters}")
            return filters
    
    # No working combination found
    print(f"  ✗ No working filters found")
    return None

def build_filter_database(resume_from=None):
    """Build complete filter database for all datasets"""
    cfg = Config.load('config.yml')
    
    # Load or create filter database
    db_path = Path('dataset_filters.json')
    if db_path.exists():
        filter_db = json.loads(db_path.read_text())
        print(f"Loaded existing database with {len(filter_db)} entries")
    else:
        filter_db = {}
    
    # Get all datasets
    all_datasets = load_all_datasets()
    print(f"\nTotal datasets to process: {len(all_datasets)}")
    
    # Resume from specific dataset if provided
    start_index = 0
    if resume_from:
        try:
            start_index = all_datasets.index(resume_from)
            print(f"Resuming from {resume_from} (index {start_index})")
        except ValueError:
            print(f"Warning: {resume_from} not found, starting from beginning")
    
    # Process each dataset
    processed = 0
    failed = 0
    
    for i, dataset_code in enumerate(all_datasets[start_index:], start_index):
        # Skip if already processed
        if dataset_code in filter_db:
            print(f"\n[{i+1}/{len(all_datasets)}] {dataset_code} - Already processed, skipping")
            continue
        
        print(f"\n[{i+1}/{len(all_datasets)}] Processing {dataset_code}")
        
        try:
            filters = find_working_filters(cfg, dataset_code)
            
            if filters is not None:
                filter_db[dataset_code] = filters
                processed += 1
            else:
                filter_db[dataset_code] = {"_no_data": True}
                failed += 1
            
            # Save every 10 datasets
            if (i + 1) % 10 == 0:
                db_path.write_text(json.dumps(filter_db, indent=2))
                print(f"\n[CHECKPOINT] Saved {len(filter_db)} entries")
                print(f"  Success: {processed}, Failed: {failed}")
            
            # Rate limiting - don't hammer Eurostat API
            time.sleep(0.5)
            
        except KeyboardInterrupt:
            print(f"\n\n[INTERRUPTED] Saving progress...")
            db_path.write_text(json.dumps(filter_db, indent=2))
            print(f"Saved {len(filter_db)} entries. Resume with: {dataset_code}")
            return
        except Exception as e:
            print(f"  ERROR: {e}")
            filter_db[dataset_code] = {"_error": str(e)}
            failed += 1
    
    # Final save
    db_path.write_text(json.dumps(filter_db, indent=2))
    
    print("\n" + "="*60)
    print("FILTER DATABASE BUILD COMPLETE")
    print("="*60)
    print(f"Total datasets: {len(all_datasets)}")
    print(f"Successfully mapped: {processed}")
    print(f"Failed/No data: {failed}")
    print(f"Database saved to: {db_path}")
    print("="*60)

if __name__ == '__main__':
    import sys
    
    resume_from = sys.argv[1] if len(sys.argv) > 1 else None
    
    print("="*60)
    print("BUILDING PERMANENT FILTER DATABASE")
    print("="*60)
    print()
    print("This will test all 7,616 datasets and record working filters.")
    print("Estimated time: 2-3 hours")
    print()
    print("You can interrupt (Ctrl+C) at any time and resume later.")
    print("="*60)
    print()
    
    input("Press Enter to start...")
    
    build_filter_database(resume_from)
