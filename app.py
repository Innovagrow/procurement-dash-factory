"""
Procurement Intelligence Platform - Main Application
FastAPI web server for procurement analytics dashboards
"""
from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
import sys
from pathlib import Path

# Add connectors to path
sys.path.append(str(Path(__file__).parent))

from connectors.ted_eu import TEDConnector
from dashboards.generator import DashboardGenerator

app = FastAPI(
    title="Procurement Intelligence Platform",
    description="Multi-source government procurement analytics",
    version="1.0.0"
)

# Initialize connectors
ted_connector = TEDConnector()
dashboard_gen = DashboardGenerator()

# Templates (we'll create these)
templates = Jinja2Templates(directory="site")


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    """Homepage"""
    
    html = """
    <!DOCTYPE html>
    <html>
    <head>
        <title>Procurement Intelligence Platform</title>
        <style>
            body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                max-width: 1200px;
                margin: 0 auto;
                padding: 20px;
                background: #f5f5f5;
            }
            .header {
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 40px;
                border-radius: 10px;
                margin-bottom: 30px;
            }
            h1 { margin: 0; font-size: 2.5em; }
            .subtitle { opacity: 0.9; margin-top: 10px; }
            .dashboard-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
                gap: 20px;
                margin-top: 30px;
            }
            .dashboard-card {
                background: white;
                padding: 30px;
                border-radius: 10px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                transition: transform 0.2s;
            }
            .dashboard-card:hover {
                transform: translateY(-5px);
                box-shadow: 0 4px 8px rgba(0,0,0,0.2);
            }
            .dashboard-card h3 {
                margin-top: 0;
                color: #667eea;
            }
            .btn {
                display: inline-block;
                padding: 10px 20px;
                background: #667eea;
                color: white;
                text-decoration: none;
                border-radius: 5px;
                margin-top: 15px;
            }
            .btn:hover {
                background: #764ba2;
            }
            .stats {
                display: grid;
                grid-template-columns: repeat(3, 1fr);
                gap: 20px;
                margin: 30px 0;
            }
            .stat-card {
                background: white;
                padding: 20px;
                border-radius: 10px;
                text-align: center;
            }
            .stat-value {
                font-size: 2em;
                font-weight: bold;
                color: #667eea;
            }
            .stat-label {
                color: #666;
                margin-top: 5px;
            }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>🌍 Procurement Intelligence Platform</h1>
            <p class="subtitle">Multi-source government tender analytics • EU + US + Greece</p>
        </div>
        
        <div class="stats">
            <div class="stat-card">
                <div class="stat-value">€600B+</div>
                <div class="stat-label">EU Procurement Annually</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">27</div>
                <div class="stat-label">EU Countries</div>
            </div>
            <div class="stat-card">
                <div class="stat-value">Live</div>
                <div class="stat-label">Real-time Data</div>
            </div>
        </div>
        
        <div class="dashboard-grid">
            <div class="dashboard-card">
                <h3>📊 Tender Overview</h3>
                <p>Browse and analyze current EU procurement opportunities</p>
                <a href="/dashboard/tenders" class="btn">View Dashboard →</a>
            </div>
            
            <div class="dashboard-card">
                <h3>🎯 IT Tenders</h3>
                <p>Software, cloud computing, and IT services tenders</p>
                <a href="/dashboard/it-tenders" class="btn">View Dashboard →</a>
            </div>
            
            <div class="dashboard-card">
                <h3>🌍 Country Analysis</h3>
                <p>Procurement trends by EU member state</p>
                <a href="/dashboard/countries" class="btn">View Dashboard →</a>
            </div>
            
            <div class="dashboard-card">
                <h3>💰 Value Analysis</h3>
                <p>Tender values, trends, and forecasts</p>
                <a href="/dashboard/value-analysis" class="btn">View Dashboard →</a>
            </div>
            
            <div class="dashboard-card">
                <h3>🔍 Search API</h3>
                <p>Programmatic access to procurement data</p>
                <a href="/api/search?limit=10" class="btn">Try API →</a>
            </div>
            
            <div class="dashboard-card">
                <h3>📖 Documentation</h3>
                <p>API docs, guides, and examples</p>
                <a href="/docs" class="btn">Read Docs →</a>
            </div>
        </div>
        
        <div style="margin-top: 50px; padding: 20px; background: white; border-radius: 10px;">
            <h2>🚀 Quick Start</h2>
            <pre style="background: #f5f5f5; padding: 15px; border-radius: 5px; overflow-x: auto;">
# Search for IT tenders in Germany
GET /api/search?country=DE&cpv_code=48&limit=10

# Get tender statistics
GET /api/stats?cpv_code=72

# View IT dashboard
GET /dashboard/it-tenders
            </pre>
        </div>
    </body>
    </html>
    """
    
    return html


@app.get("/api/search")
async def search_tenders(
    country: str = Query(None, description="ISO 2-letter country code (e.g., DE, FR)"),
    cpv_code: str = Query(None, description="CPV category code (e.g., 48 for IT)"),
    min_value: int = Query(None, description="Minimum tender value in EUR"),
    max_value: int = Query(None, description="Maximum tender value in EUR"),
    limit: int = Query(100, description="Number of results (max 1000)")
):
    """Search for procurement tenders"""
    
    filters = {}
    if country:
        filters['country'] = country
    if cpv_code:
        filters['cpv_code'] = cpv_code
    if min_value:
        filters['min_value'] = min_value
    if max_value:
        filters['max_value'] = max_value
    filters['limit'] = min(limit, 1000)
    
    tenders = ted_connector.search_tenders(filters)
    
    return JSONResponse({
        'total': len(tenders),
        'filters': filters,
        'tenders': tenders.to_dict('records')
    })


@app.get("/api/stats")
async def get_statistics(
    country: str = Query(None),
    cpv_code: str = Query(None)
):
    """Get procurement statistics"""
    
    filters = {}
    if country:
        filters['country'] = country
    if cpv_code:
        filters['cpv_code'] = cpv_code
    
    stats = ted_connector.get_statistics(filters)
    
    return JSONResponse(stats)


@app.get("/dashboard/tenders", response_class=HTMLResponse)
async def tender_dashboard(
    country: str = Query(None),
    cpv_code: str = Query(None),
    limit: int = Query(100)
):
    """Tender overview dashboard"""
    
    filters = {'limit': limit}
    if country:
        filters['country'] = country
    if cpv_code:
        filters['cpv_code'] = cpv_code
    
    tenders = ted_connector.search_tenders(filters)
    dashboard = dashboard_gen.create_tender_overview(tenders)
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Tender Overview Dashboard</title>
        <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
        <style>
            body {{
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                margin: 0;
                padding: 20px;
                background: #f5f5f5;
            }}
            .header {{
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 30px;
                border-radius: 10px;
                margin-bottom: 30px;
            }}
            .kpi-grid {{
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-bottom: 30px;
            }}
            .kpi-card {{
                background: white;
                padding: 20px;
                border-radius: 10px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }}
            .kpi-value {{
                font-size: 2em;
                font-weight: bold;
                color: #667eea;
            }}
            .kpi-label {{
                color: #666;
                margin-top: 5px;
            }}
            .chart {{
                background: white;
                padding: 20px;
                border-radius: 10px;
                margin-bottom: 20px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }}
        </style>
    </head>
    <body>
        <div class="header">
            <h1>📊 Tender Overview Dashboard</h1>
            <p>EU Procurement Intelligence</p>
            <a href="/" style="color: white;">← Back to Home</a>
        </div>
        
        <div class="kpi-grid">
            <div class="kpi-card">
                <div class="kpi-value">{dashboard['kpis']['total_tenders']}</div>
                <div class="kpi-label">Total Tenders</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-value">{dashboard['kpis']['total_value']}</div>
                <div class="kpi-label">Total Value</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-value">{dashboard['kpis']['average_value']}</div>
                <div class="kpi-label">Average Value</div>
            </div>
        </div>
        
        <div class="chart">
            {dashboard['charts']['timeline']}
        </div>
        
        <div class="chart">
            {dashboard['charts']['geography']}
        </div>
        
        <div class="chart">
            {dashboard['charts']['value_dist']}
        </div>
        
        <div class="chart">
            {dashboard['charts']['categories']}
        </div>
    </body>
    </html>
    """
    
    return html


@app.get("/dashboard/it-tenders", response_class=HTMLResponse)
async def it_dashboard():
    """IT-specific tender dashboard"""
    
    tenders = ted_connector.search_tenders({'cpv_code': '48', 'limit': 100})
    dashboard = dashboard_gen.create_tender_overview(tenders)
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>IT Tenders Dashboard</title>
        <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
        <style>
            body {{
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                margin: 0;
                padding: 20px;
                background: #f5f5f5;
            }}
            .header {{
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                padding: 30px;
                border-radius: 10px;
                margin-bottom: 30px;
            }}
            .kpi-grid {{
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 20px;
                margin-bottom: 30px;
            }}
            .kpi-card {{
                background: white;
                padding: 20px;
                border-radius: 10px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }}
            .kpi-value {{
                font-size: 2em;
                font-weight: bold;
                color: #667eea;
            }}
            .kpi-label {{
                color: #666;
                margin-top: 5px;
            }}
            .chart {{
                background: white;
                padding: 20px;
                border-radius: 10px;
                margin-bottom: 20px;
                box-shadow: 0 2px 4px rgba(0,0,0,0.1);
            }}
        </style>
    </head>
    <body>
        <div class="header">
            <h1>💻 IT Tenders Dashboard</h1>
            <p>Software, Cloud Computing & IT Services</p>
            <a href="/" style="color: white;">← Back to Home</a>
        </div>
        
        <div class="kpi-grid">
            <div class="kpi-card">
                <div class="kpi-value">{dashboard['kpis']['total_tenders']}</div>
                <div class="kpi-label">IT Tenders</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-value">{dashboard['kpis']['total_value']}</div>
                <div class="kpi-label">Total IT Spend</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-value">{dashboard['kpis']['average_value']}</div>
                <div class="kpi-label">Average Contract</div>
            </div>
        </div>
        
        <div class="chart">
            {dashboard['charts']['timeline']}
        </div>
        
        <div class="chart">
            {dashboard['charts']['geography']}
        </div>
        
        <div class="chart">
            {dashboard['charts']['categories']}
        </div>
    </body>
    </html>
    """
    
    return html


if __name__ == '__main__':
    import uvicorn
    print("="*60)
    print("PROCUREMENT INTELLIGENCE PLATFORM")
    print("="*60)
    print("\nStarting server...")
    print("Dashboard: http://localhost:8000")
    print("API: http://localhost:8000/api/search")
    print("Docs: http://localhost:8000/docs")
    print("\nPress Ctrl+C to stop")
    print("="*60)
    
    uvicorn.run(app, host="0.0.0.0", port=8000)
