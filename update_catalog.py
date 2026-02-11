from eurodash.catalog_browser import generate_catalog_json
from pathlib import Path

catalog = generate_catalog_json(
    'warehouse/duckdb/eurodash.duckdb',
    Path('site/_site/catalog.json')
)

print('=' * 60)
print('CATALOG UPDATED')
print('=' * 60)
print(f'Total datasets: {catalog["total"]}')
print(f'Categories: {len(catalog["categories"])}')
print(f'\nDatasets available:')
for i, ds in enumerate(catalog['datasets'], 1):
    print(f'  {i}. {ds["code"]} - {ds["title"][:50]}...')
