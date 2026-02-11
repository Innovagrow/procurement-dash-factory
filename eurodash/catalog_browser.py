"""
Dynamic catalog browser - shows all datasets without pre-rendering
"""
import duckdb
from pathlib import Path
from typing import List, Dict
import json


def extract_category(dataset_code: str) -> str:
    """Extract category from dataset code prefix"""
    categories = {
        'nama': 'National Accounts',
        'prc': 'Prices',
        'ei': 'Economic Indicators',
        'bop': 'Balance of Payments',
        'gov': 'Government Finance',
        'une': 'Unemployment',
        'demo': 'Demography',
        'hlth': 'Health',
        'educ': 'Education',
        'tran': 'Transport',
        'ener': 'Energy',
        'env': 'Environment',
        'agr': 'Agriculture',
        'for': 'Forestry',
        'fish': 'Fisheries',
        'tour': 'Tourism',
        'sbs': 'Structural Business Statistics',
        'htec': 'High-tech',
        'inn': 'Innovation',
        'rd': 'Research & Development',
        'pat': 'Patents',
        'ict': 'ICT',
        'dig': 'Digital Economy',
        'isoc': 'Information Society',
        'ext': 'External Trade',
        'comext': 'COMEXT Trade',
        't2020': 'Europe 2020',
        'sdg': 'Sustainable Development Goals',
    }
    
    prefix = dataset_code.split('_')[0]
    return categories.get(prefix, 'Other Statistics')


def extract_tags(dataset_code: str, title: str) -> List[str]:
    """Extract tags from dataset code and title"""
    tags = set()
    
    # Frequency tags
    if '_m' in dataset_code or 'monthly' in title.lower():
        tags.add('monthly')
    if '_q' in dataset_code or 'quarterly' in title.lower():
        tags.add('quarterly')
    if '_a' in dataset_code or 'annual' in title.lower():
        tags.add('annual')
    
    # Geographic tags
    if 'eu' in title.lower():
        tags.add('EU')
    if 'euro' in title.lower() and 'area' in title.lower():
        tags.add('Euro Area')
    
    # Subject tags from title keywords
    keywords = {
        'gdp': 'GDP',
        'employment': 'Employment',
        'inflation': 'Inflation',
        'trade': 'Trade',
        'price': 'Prices',
        'population': 'Population',
        'energy': 'Energy',
        'environment': 'Environment',
        'health': 'Health',
        'education': 'Education',
    }
    
    title_lower = title.lower()
    for keyword, tag in keywords.items():
        if keyword in title_lower:
            tags.add(tag)
    
    return sorted(list(tags))


def get_all_datasets(db_path: str) -> List[Dict]:
    """Get ALL datasets - smart filtering detects structure on-demand"""
    con = duckdb.connect(db_path, read_only=True)
    
    # Show ALL datasets - smart filter detection happens when user clicks
    df = con.execute("""
        SELECT 
            dataset_code,
            title,
            dataset_type,
            last_update_data,
            last_update_structure
        FROM catalog_registry
        ORDER BY last_update_data DESC
    """).df()
    
    con.close()
    
    datasets = []
    for _, row in df.iterrows():
        code = row['dataset_code']
        title = row['title']
        
        datasets.append({
            'code': code,
            'title': title,
            'type': row['dataset_type'],
            'last_updated': str(row['last_update_data']),
            'category': extract_category(code),
            'tags': extract_tags(code, title),
            'source': 'estat',  # Eurostat
            'url': f'/report.html?dataset={code}'  # On-demand generation
        })
    
    return datasets


def get_category_stats(datasets: List[Dict]) -> Dict:
    """Get statistics by category"""
    stats = {}
    for ds in datasets:
        cat = ds['category']
        stats[cat] = stats.get(cat, 0) + 1
    return dict(sorted(stats.items(), key=lambda x: x[1], reverse=True))


def get_data_source_stats(datasets: List[Dict]) -> Dict:
    """Get statistics by data source"""
    stats = {}
    for ds in datasets:
        source = ds['source']
        stats[source] = stats.get(source, 0) + 1
    return stats


def generate_catalog_json(db_path: str, output_path: Path):
    """Generate JSON catalog for frontend"""
    datasets = get_all_datasets(db_path)
    
    catalog = {
        'total': len(datasets),
        'categories': get_category_stats(datasets),
        'sources': get_data_source_stats(datasets),
        'datasets': datasets
    }
    
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(catalog, indent=2), encoding='utf-8')
    
    return catalog


if __name__ == '__main__':
    from eurodash.config import Config
    
    cfg = Config.load('config.yml')
    db_path = cfg.get('warehouse', 'duckdb_path')
    output = Path('site/_site/catalog.json')
    
    catalog = generate_catalog_json(db_path, output)
    print(f"Generated catalog with {catalog['total']} datasets")
    print(f"Categories: {len(catalog['categories'])}")
    print(f"Data sources: {catalog['sources']}")
