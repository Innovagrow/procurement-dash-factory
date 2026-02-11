"""Debug prc_hicp_midx dataset"""
from eurodash.config import Config
from eurodash.discovery import discover_structure

cfg = Config.load('config.yml')

print("Discovering structure for prc_hicp_midx...")
struct = discover_structure(cfg, 'prc_hicp_midx', time_hint=None)

print("\nDataset structure:")
print(f"  Dimensions: {struct.dimensions}")
print(f"  Time periods: {len(struct.time_values)}")
print(f"  Sample time values: {struct.time_values[:10] if struct.time_values else 'None'}")
print(f"  Geo values: {len(struct.geo_values)} regions")
print(f"  Sample geo: {list(struct.geo_values)[:10] if struct.geo_values else 'None'}")

print("\nOther dimensions:")
for dim in struct.dimensions:
    if dim not in ['time', 'geo', 'unit', 'freq']:
        vals = getattr(struct, f"{dim}_values", [])
        print(f"  {dim}: {len(vals) if vals else 0} values - {list(vals)[:5] if vals else 'None'}")

# Try manual API call
print("\n\nTrying manual API call without filters...")
import requests
from datetime import datetime

year = datetime.now().year
years = [str(y) for y in range(year-5, year+1)]

url = f"https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/prc_hicp_midx"
params = {
    "format": "JSON",
    "lang": "EN",
    "time": years[:3],  # Just 3 years
    "geoLevel": "country"
}

print(f"URL: {url}")
print(f"Params: {params}")

try:
    r = requests.get(url, params=params, timeout=30)
    print(f"Status: {r.status_code}")
    if r.status_code == 200:
        data = r.json()
        print(f"Response keys: {data.keys()}")
        if 'value' in data:
            print(f"Number of values: {len(data['value'])}")
        if 'dimension' in data:
            print(f"Dimensions: {list(data['dimension'].keys())}")
    else:
        print(f"Error: {r.text[:500]}")
except Exception as e:
    print(f"Error: {e}")
