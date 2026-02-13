"""
Procurement Intelligence Platform - Main Application
FastAPI web server for procurement analytics dashboards
"""
from fastapi import FastAPI, Query, Request, Depends, HTTPException, status
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.middleware.cors import CORSMiddleware
import sys
import os
from pathlib import Path
from datetime import datetime, timedelta
import jwt
from dotenv import load_dotenv
import httpx

# Load environment variables
load_dotenv()

# Add connectors to path
sys.path.append(str(Path(__file__).parent))

from connectors.ted_eu import TEDConnector
from dashboards.generator import DashboardGenerator
from dashboards.powerbi_layout import PowerBIDashboard
from user_dashboard import UserDashboard, add_favorite, remove_favorite, get_favorites
from user_dashboard_enhanced import generate_enhanced_dashboard

# Configuration
SECRET_KEY = os.getenv("SECRET_KEY", "change-this-secret-key-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 30  # 30 days (user stays logged in for 1 month)

# Google OAuth Configuration
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
# Railway sets PORT, so we build the redirect URI properly
if os.getenv("RAILWAY_ENVIRONMENT"):
    # Production on Railway
    GOOGLE_REDIRECT_URI = "https://web-production-7a78a.up.railway.app/auth/google/callback"
else:
    # Local development
    GOOGLE_REDIRECT_URI = "http://localhost:8002/auth/google/callback"

print(f"Google OAuth Redirect URI: {GOOGLE_REDIRECT_URI}")
print(f"Google OAuth Configured: {bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)}")

app = FastAPI(
    title="Procurement Intelligence Platform",
    description="Multi-source government procurement analytics with AI insights",
    version="2.0.0"
)

# CORS middleware for API access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files from _site directory (if it exists)
site_libs_path = Path(__file__).parent / "site" / "_site" / "site_libs"
if site_libs_path.exists():
    app.mount("/site_libs", StaticFiles(directory="site/_site/site_libs"), name="site_libs")

# Initialize connectors
ted_connector = TEDConnector()
dashboard_gen = DashboardGenerator()
powerbi_dashboard = PowerBIDashboard()

# Security
security = HTTPBearer()

# In-memory storage (replace with database in production)
users_db = {}

# Templates
templates = Jinja2Templates(directory="site")


@app.get("/", response_class=HTMLResponse)
async def home(request: Request):
    """Homepage - redirect to dashboard if logged in, otherwise show landing page"""
    
    # Check if user is already logged in
    auth_header = request.headers.get('Authorization')
    if auth_header and auth_header.startswith('Bearer '):
        token = auth_header.replace('Bearer ', '')
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            # User is logged in, redirect to dashboard
            return RedirectResponse(url="/user/dashboard", status_code=302)
        except:
            pass  # Invalid token, show landing page
    
    # Serve the Quarto-rendered index.html
    index_path = Path(__file__).parent / "site" / "_site" / "index.html"
    
    if index_path.exists():
        return HTMLResponse(content=index_path.read_text(), status_code=200)
    
    # Fallback if Quarto not rendered yet
    return HTMLResponse(content="""
    <html>
    <head><title>Procurement Platform</title></head>
    <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1>Procurement Intelligence Platform</h1>
        <p>Rendering site... Please run: <code>cd site && quarto render</code></p>
        <p>Or visit: <a href="/dashboard/it-tenders">IT Tenders Dashboard</a></p>
    </body>
    </html>
    """, status_code=200)


@app.get("/login.html", response_class=HTMLResponse)
async def login_page():
    """Serve login page"""
    login_path = Path(__file__).parent / "site" / "_site" / "login.html"
    if login_path.exists():
        return HTMLResponse(content=login_path.read_text(), status_code=200)
    return HTMLResponse(content="<h1>Login page not found</h1>", status_code=404)


@app.get("/report.html", response_class=HTMLResponse)
async def report_page():
    """Serve report loading page"""
    report_path = Path(__file__).parent / "site" / "_site" / "report.html"
    if report_path.exists():
        return HTMLResponse(content=report_path.read_text(), status_code=200)
    return HTMLResponse(content="<h1>Report page not found</h1>", status_code=404)


@app.get("/api/auth/google-config")
async def google_config():
    """Return Google OAuth configuration"""
    return JSONResponse({
        'client_id': GOOGLE_CLIENT_ID,
        'configured': bool(GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET)
    })


@app.post("/api/auth/login")
async def login(request: Request):
    """Login with email and password"""
    try:
        data = await request.json()
        email = data.get("email")
        password = data.get("password")
        
        if not email or not password:
            return JSONResponse({
                'success': False,
                'error': 'Email and password are required'
            }, status_code=400)
        
        # Check if user exists
        if email not in users_db:
            return JSONResponse({
                'success': False,
                'error': 'Invalid email or password'
            }, status_code=401)
        
        user = users_db[email]
        
        # Verify password - EXACT SAME AS EUROSTAT PROJECT
        import bcrypt as bcrypt_lib
        
        if "hashed_password" not in user or not bcrypt_lib.checkpw(password.encode('utf-8'), user["hashed_password"].encode('utf-8')):
            return JSONResponse({
                'success': False,
                'error': 'Invalid email or password'
            }, status_code=401)
        
        # Create JWT token
        token_payload = {
            "email": email,
            "username": user.get("username", email.split("@")[0]),
            "exp": datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        }
        token = jwt.encode(token_payload, SECRET_KEY, algorithm=ALGORITHM)
        
        return JSONResponse({
            'success': True,
            'token': token,
            'user': {
                'email': email,
                'username': user.get("username", email.split("@")[0])
            }
        })
    
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"Login error: {str(e)}")
        print(f"Full traceback: {error_details}")
        return JSONResponse({
            'success': False,
            'error': f'Login failed: {str(e)}'
        }, status_code=500)


@app.post("/api/auth/signup")
async def signup(request: Request):
    """Create new account with email and password"""
    try:
        data = await request.json()
        username = data.get("username")
        email = data.get("email")
        password = data.get("password")
        
        if not email or not password or not username:
            return JSONResponse({
                'success': False,
                'error': 'Username, email and password are required'
            }, status_code=400)
        
        # Strong password validation
        if len(password) < 12:
            return JSONResponse({
                'success': False,
                'error': 'Password must be at least 12 characters'
            }, status_code=400)
        
        # Check for uppercase, lowercase, number, and special character
        import re
        if not re.search(r'[A-Z]', password):
            return JSONResponse({
                'success': False,
                'error': 'Password must include at least one uppercase letter'
            }, status_code=400)
        
        if not re.search(r'[a-z]', password):
            return JSONResponse({
                'success': False,
                'error': 'Password must include at least one lowercase letter'
            }, status_code=400)
        
        if not re.search(r'[0-9]', password):
            return JSONResponse({
                'success': False,
                'error': 'Password must include at least one number'
            }, status_code=400)
        
        if not re.search(r'[!@#$%^&*(),.?":{}|<>]', password):
            return JSONResponse({
                'success': False,
                'error': 'Password must include at least one special character (!@#$%^&*...)'
            }, status_code=400)
        
        # Check if user already exists
        if email in users_db:
            return JSONResponse({
                'success': False,
                'error': 'You already have an account! Please login instead.'
            }, status_code=400)
        
        # Hash password - EXACT SAME AS EUROSTAT PROJECT
        import bcrypt as bcrypt_lib
        salt = bcrypt_lib.gensalt()
        hashed_password = bcrypt_lib.hashpw(password.encode('utf-8'), salt).decode('utf-8')
        
        # Create user
        users_db[email] = {
            "email": email,
            "username": username,
            "hashed_password": hashed_password,
            "provider": "email",
            "created_at": datetime.now().isoformat()
        }
        
        # Create JWT token
        token_payload = {
            "email": email,
            "username": username,
            "exp": datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        }
        token = jwt.encode(token_payload, SECRET_KEY, algorithm=ALGORITHM)
        
        return JSONResponse({
            'success': True,
            'token': token,
            'user': {
                'email': email,
                'username': username
            }
        })
    
    except Exception as e:
        import traceback
        error_details = traceback.format_exc()
        print(f"Signup error: {str(e)}")
        print(f"Full traceback: {error_details}")
        return JSONResponse({
            'success': False,
            'error': f'Signup failed: {str(e)}'
        }, status_code=500)


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
            <a href="/user/dashboard" style="color: white;">← Back to My Dashboard</a>
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
            <a href="/user/dashboard" style="color: white;">← Back to My Dashboard</a>
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


@app.get("/dashboard/countries", response_class=HTMLResponse)
async def countries_dashboard():
    """Geographic analysis dashboard"""
    tenders = ted_connector.search_tenders({'limit': 100})
    dashboard = dashboard_gen.create_tender_overview(tenders)
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Geographic Analysis Dashboard</title>
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
            <h1>🌍 Geographic Analysis Dashboard</h1>
            <p>Country & Regional Procurement Trends</p>
            <a href="/user/dashboard" style="color: white;">← Back to My Dashboard</a>
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
            {dashboard['charts']['geography']}
        </div>
        
        <div class="chart">
            {dashboard['charts']['categories']}
        </div>
    </body>
    </html>
    """
    return html


@app.get("/dashboard/value-analysis", response_class=HTMLResponse)
async def value_dashboard():
    """Value analysis dashboard"""
    tenders = ted_connector.search_tenders({'limit': 100})
    dashboard = dashboard_gen.create_tender_overview(tenders)
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Value Analysis Dashboard</title>
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
            <h1>💰 Value Analysis Dashboard</h1>
            <p>Contract Value Trends & Distribution</p>
            <a href="/user/dashboard" style="color: white;">← Back to My Dashboard</a>
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
            {dashboard['charts']['value_dist']}
        </div>
        
        <div class="chart">
            {dashboard['charts']['timeline']}
        </div>
    </body>
    </html>
    """
    return html


@app.get("/dashboard/awards", response_class=HTMLResponse)
async def awards_dashboard():
    """Award analytics dashboard"""
    tenders = ted_connector.search_awards({'limit': 100})
    dashboard = dashboard_gen.create_tender_overview(tenders)
    
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <title>Award Analytics Dashboard</title>
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
            <h1>🏆 Award Analytics Dashboard</h1>
            <p>Contract Award Analysis & Winners</p>
            <a href="/user/dashboard" style="color: white;">← Back to My Dashboard</a>
        </div>
        
        <div class="kpi-grid">
            <div class="kpi-card">
                <div class="kpi-value">{dashboard['kpis']['total_tenders']}</div>
                <div class="kpi-label">Total Awards</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-value">{dashboard['kpis']['total_value']}</div>
                <div class="kpi-label">Total Value</div>
            </div>
            <div class="kpi-card">
                <div class="kpi-value">{dashboard['kpis']['average_value']}</div>
                <div class="kpi-label">Average Award</div>
            </div>
        </div>
        
        <div class="chart">
            {dashboard['charts']['timeline']}
        </div>
        
        <div class="chart">
            {dashboard['charts']['categories']}
        </div>
    </body>
    </html>
    """
    return html


@app.get("/report/{tender_id}", response_class=HTMLResponse)
async def tender_report_page(request: Request, tender_id: str, token: str = Query(None)):
    """Individual tender report page"""
    try:
        # Get token from query parameter or Authorization header
        jwt_token = None
        if token:
            jwt_token = token
        else:
            auth_header = request.headers.get('Authorization')
            if auth_header and auth_header.startswith('Bearer '):
                jwt_token = auth_header.replace('Bearer ', '')
        
        if not jwt_token:
            return RedirectResponse(url="/login.html", status_code=302)
        
        payload = jwt.decode(jwt_token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get('email')
        
        if not email:
            return RedirectResponse(url="/login.html?error=invalid_token", status_code=302)
        
        # Sample tender data (replace with real database lookup)
        tender_details = {
            'id': tender_id,
            'title': 'Cloud Infrastructure Services',
            'description': 'Comprehensive cloud infrastructure setup and maintenance for government agency. Includes server setup, security implementation, and 24/7 support.',
            'value': 145000,
            'currency': 'EUR',
            'country': 'Germany',
            'deadline': '2024-03-15',
            'published': '2024-02-01',
            'cpv_code': '48',
            'cpv_description': 'IT Services & Software',
            'contracting_authority': 'Federal Ministry of Interior',
            'procedure_type': 'Open Procedure',
            'documents': ['Technical Specifications.pdf', 'Terms and Conditions.pdf'],
        }
        
        html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Tender Report - {tender_details['id']}</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                .gradient-bg {{ background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }}
            </style>
        </head>
        <body class="bg-gray-50">
            <div class="gradient-bg text-white shadow-lg">
                <div class="max-w-5xl mx-auto px-6 py-4">
                    <div class="flex justify-between items-center">
                        <div>
                            <div class="text-sm opacity-90">Tender ID: {tender_details['id']}</div>
                            <h1 class="text-2xl font-bold mt-1">{tender_details['title']}</h1>
                        </div>
                        <a href="/user/dashboard?token={jwt_token}" class="bg-white text-purple-600 px-4 py-2 rounded-lg hover:bg-purple-50">
                            <i class="fas fa-arrow-left mr-2"></i>Back to Dashboard
                        </a>
                    </div>
                </div>
            </div>

            <div class="max-w-5xl mx-auto px-6 py-8">
                <!-- Key Info Cards -->
                <div class="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
                    <div class="bg-white rounded-lg shadow-sm p-4">
                        <div class="text-sm text-gray-600 mb-1">Value</div>
                        <div class="text-2xl font-bold text-purple-600">€{tender_details['value']:,}</div>
                    </div>
                    <div class="bg-white rounded-lg shadow-sm p-4">
                        <div class="text-sm text-gray-600 mb-1">Country</div>
                        <div class="text-2xl font-bold text-gray-800">{tender_details['country']}</div>
                    </div>
                    <div class="bg-white rounded-lg shadow-sm p-4">
                        <div class="text-sm text-gray-600 mb-1">Deadline</div>
                        <div class="text-lg font-bold text-orange-600">{tender_details['deadline']}</div>
                    </div>
                    <div class="bg-white rounded-lg shadow-sm p-4">
                        <div class="text-sm text-gray-600 mb-1">CPV Code</div>
                        <div class="text-lg font-bold text-gray-800">{tender_details['cpv_code']}</div>
                    </div>
                </div>

                <!-- Main Content -->
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <div class="lg:col-span-2 space-y-6">
                        <!-- Description -->
                        <div class="bg-white rounded-lg shadow-sm p-6">
                            <h2 class="text-lg font-bold mb-4">Description</h2>
                            <p class="text-gray-700">{tender_details['description']}</p>
                        </div>

                        <!-- Details -->
                        <div class="bg-white rounded-lg shadow-sm p-6">
                            <h2 class="text-lg font-bold mb-4">Tender Details</h2>
                            <div class="space-y-3">
                                <div class="flex justify-between border-b pb-2">
                                    <span class="text-gray-600">Contracting Authority</span>
                                    <span class="font-semibold">{tender_details['contracting_authority']}</span>
                                </div>
                                <div class="flex justify-between border-b pb-2">
                                    <span class="text-gray-600">Procedure Type</span>
                                    <span class="font-semibold">{tender_details['procedure_type']}</span>
                                </div>
                                <div class="flex justify-between border-b pb-2">
                                    <span class="text-gray-600">Published Date</span>
                                    <span class="font-semibold">{tender_details['published']}</span>
                                </div>
                                <div class="flex justify-between border-b pb-2">
                                    <span class="text-gray-600">CPV Description</span>
                                    <span class="font-semibold">{tender_details['cpv_description']}</span>
                                </div>
                            </div>
                        </div>

                        <!-- Documents -->
                        <div class="bg-white rounded-lg shadow-sm p-6">
                            <h2 class="text-lg font-bold mb-4">Documents</h2>
                            <div class="space-y-2">
                                <div class="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50">
                                    <div class="flex items-center gap-3">
                                        <i class="fas fa-file-pdf text-red-500 text-2xl"></i>
                                        <span>Technical Specifications.pdf</span>
                                    </div>
                                    <button class="text-purple-600 hover:text-purple-700">
                                        <i class="fas fa-download"></i>
                                    </button>
                                </div>
                                <div class="flex items-center justify-between p-3 border rounded-lg hover:bg-gray-50">
                                    <div class="flex items-center gap-3">
                                        <i class="fas fa-file-pdf text-red-500 text-2xl"></i>
                                        <span>Terms and Conditions.pdf</span>
                                    </div>
                                    <button class="text-purple-600 hover:text-purple-700">
                                        <i class="fas fa-download"></i>
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Sidebar -->
                    <div class="space-y-6">
                        <!-- Actions -->
                        <div class="bg-white rounded-lg shadow-sm p-6">
                            <h3 class="font-bold mb-4">Quick Actions</h3>
                            <div class="space-y-2">
                                <button class="w-full gradient-bg text-white py-2 rounded-lg font-semibold hover:opacity-90">
                                    <i class="fas fa-file-alt mr-2"></i>Prepare Bid
                                </button>
                                <button onclick="addToFavorites('{tender_details['id']}')" class="w-full border border-purple-600 text-purple-600 py-2 rounded-lg font-semibold hover:bg-purple-50">
                                    <i class="fas fa-star mr-2"></i>Add to Favorites
                                </button>
                                <button onclick="setAlert('{tender_details['id']}')" class="w-full border border-gray-300 text-gray-700 py-2 rounded-lg font-semibold hover:bg-gray-50">
                                    <i class="fas fa-bell mr-2"></i>Set Alert
                                </button>
                                <button class="w-full border border-gray-300 text-gray-700 py-2 rounded-lg font-semibold hover:bg-gray-50">
                                    <i class="fas fa-share mr-2"></i>Share
                                </button>
                            </div>
                        </div>

                        <!-- Match Score -->
                        <div class="bg-gradient-to-br from-green-500 to-green-600 text-white rounded-lg shadow-sm p-6">
                            <h3 class="font-bold mb-2">Match Score</h3>
                            <div class="text-5xl font-bold mb-2">92%</div>
                            <p class="text-sm opacity-90">Perfect match for your profile!</p>
                        </div>

                        <!-- Competition -->
                        <div class="bg-white rounded-lg shadow-sm p-6">
                            <h3 class="font-bold mb-3">Competition Level</h3>
                            <div class="flex items-center gap-2 mb-2">
                                <span class="text-2xl">👥</span>
                                <span class="text-xl font-bold">Low</span>
                            </div>
                            <div class="text-sm text-gray-600">Estimated 3-5 bidders</div>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                function addToFavorites(tenderId) {{
                    alert('Added to favorites!');
                }}
                function setAlert(tenderId) {{
                    alert('Alert set for tender ' + tenderId);
                }}
            </script>
        </body>
        </html>
        """
        
        return HTMLResponse(content=html)
    
    except jwt.ExpiredSignatureError:
        return RedirectResponse(url="/login.html?error=token_expired", status_code=302)
    except jwt.InvalidTokenError:
        return RedirectResponse(url="/login.html?error=invalid_token", status_code=302)


@app.get("/user/dashboard", response_class=HTMLResponse)
async def user_personal_dashboard(
    request: Request,
    token: str = Query(None)
):
    """User's personal dashboard with favorites"""
    try:
        # Try to get token from query parameter (for OAuth redirects) or Authorization header
        jwt_token = None
        
        if token:
            # Token from OAuth redirect URL
            jwt_token = token
        else:
            # Try to get from Authorization header
            auth_header = request.headers.get('Authorization')
            if auth_header and auth_header.startswith('Bearer '):
                jwt_token = auth_header.replace('Bearer ', '')
        
        if not jwt_token:
            # No token provided, redirect to login
            return RedirectResponse(url="/login.html", status_code=302)
        
        # Decode and validate token
        payload = jwt.decode(jwt_token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get('email')
        
        if not email:
            return RedirectResponse(url="/login.html?error=invalid_token", status_code=302)
        
        username = payload.get('username', email.split('@')[0])
        
        # Use enhanced dashboard with all high-value features
        return HTMLResponse(content=generate_enhanced_dashboard(email, username))
    
    except jwt.ExpiredSignatureError:
        return RedirectResponse(url="/login.html?error=token_expired", status_code=302)
    except jwt.InvalidTokenError:
        # Catches all JWT-related errors (DecodeError, InvalidSignatureError, etc.)
        return RedirectResponse(url="/login.html?error=invalid_token", status_code=302)
    except Exception as e:
        print(f"Dashboard error: {str(e)}")
        return RedirectResponse(url="/login.html?error=server_error", status_code=302)


@app.get("/user/settings", response_class=HTMLResponse)
async def user_settings(request: Request, token: str = Query(None)):
    """User settings page"""
    try:
        # Get token from query parameter or Authorization header
        jwt_token = None
        if token:
            jwt_token = token
        else:
            auth_header = request.headers.get('Authorization')
            if auth_header and auth_header.startswith('Bearer '):
                jwt_token = auth_header.replace('Bearer ', '')
        
        if not jwt_token:
            return RedirectResponse(url="/login.html", status_code=302)
        
        payload = jwt.decode(jwt_token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get('email')
        username = payload.get('username', email.split('@')[0])
        
        if not email:
            return RedirectResponse(url="/login.html?error=invalid_token", status_code=302)
        
        # Settings page HTML
        html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Settings - Procurement Intelligence</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                .gradient-bg {{ background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }}
                .setting-card {{ background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }}
            </style>
        </head>
        <body class="bg-gray-50">
            <div class="min-h-screen">
                <!-- Header -->
                <div class="gradient-bg text-white p-6 shadow-lg">
                    <div class="max-w-6xl mx-auto flex justify-between items-center">
                        <div>
                            <h1 class="text-2xl font-bold">⚙️ Settings</h1>
                            <p class="text-purple-100">Manage your account and preferences</p>
                        </div>
                        <a href="/user/dashboard" class="bg-white text-purple-600 px-4 py-2 rounded-lg hover:bg-purple-50">
                            <i class="fas fa-arrow-left mr-2"></i>Back to Dashboard
                        </a>
                    </div>
                </div>

                <div class="max-w-6xl mx-auto p-6">
                    <!-- Account Settings -->
                    <div class="setting-card">
                        <h2 class="text-xl font-bold mb-4"><i class="fas fa-user mr-2"></i>Account Information</h2>
                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label class="block text-sm font-semibold text-gray-700 mb-2">Username</label>
                                <input type="text" value="{username}" class="w-full px-4 py-2 border rounded-lg" readonly>
                            </div>
                            <div>
                                <label class="block text-sm font-semibold text-gray-700 mb-2">Email</label>
                                <input type="text" value="{email}" class="w-full px-4 py-2 border rounded-lg" readonly>
                            </div>
                        </div>
                        <button class="mt-4 bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700">
                            Change Password
                        </button>
                    </div>

                    <!-- Notification Preferences -->
                    <div class="setting-card">
                        <h2 class="text-xl font-bold mb-4"><i class="fas fa-bell mr-2"></i>Notifications</h2>
                        <div class="space-y-3">
                            <label class="flex items-center">
                                <input type="checkbox" checked class="mr-3 h-5 w-5">
                                <span>Email notifications for new matching tenders</span>
                            </label>
                            <label class="flex items-center">
                                <input type="checkbox" checked class="mr-3 h-5 w-5">
                                <span>Alert me about bargain opportunities</span>
                            </label>
                            <label class="flex items-center">
                                <input type="checkbox" class="mr-3 h-5 w-5">
                                <span>Weekly market intelligence report</span>
                            </label>
                            <label class="flex items-center">
                                <input type="checkbox" class="mr-3 h-5 w-5">
                                <span>Competitor activity updates</span>
                            </label>
                        </div>
                    </div>

                    <!-- Display Preferences -->
                    <div class="setting-card">
                        <h2 class="text-xl font-bold mb-4"><i class="fas fa-palette mr-2"></i>Display</h2>
                        <div class="grid grid-cols-2 gap-4">
                            <div>
                                <label class="block text-sm font-semibold text-gray-700 mb-2">Theme</label>
                                <select class="w-full px-4 py-2 border rounded-lg">
                                    <option>Light</option>
                                    <option>Dark</option>
                                    <option>Auto</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-sm font-semibold text-gray-700 mb-2">Currency</label>
                                <select class="w-full px-4 py-2 border rounded-lg">
                                    <option>EUR (€)</option>
                                    <option>USD ($)</option>
                                    <option>GBP (£)</option>
                                </select>
                            </div>
                        </div>
                    </div>

                    <!-- API Access -->
                    <div class="setting-card">
                        <h2 class="text-xl font-bold mb-4"><i class="fas fa-key mr-2"></i>API Access</h2>
                        <p class="text-gray-600 mb-4">Use API keys to access data programmatically</p>
                        <button class="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700">
                            Generate API Key
                        </button>
                    </div>
                </div>
            </div>
        </body>
        </html>
        """
        return HTMLResponse(content=html)
    
    except jwt.ExpiredSignatureError:
        return RedirectResponse(url="/login.html?error=token_expired", status_code=302)
    except jwt.InvalidTokenError:
        return RedirectResponse(url="/login.html?error=invalid_token", status_code=302)


@app.get("/user/alerts", response_class=HTMLResponse)
async def user_alerts(request: Request, token: str = Query(None)):
    """User alerts management page"""
    try:
        # Get token
        jwt_token = None
        if token:
            jwt_token = token
        else:
            auth_header = request.headers.get('Authorization')
            if auth_header and auth_header.startswith('Bearer '):
                jwt_token = auth_header.replace('Bearer ', '')
        
        if not jwt_token:
            return RedirectResponse(url="/login.html", status_code=302)
        
        payload = jwt.decode(jwt_token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get('email')
        
        if not email:
            return RedirectResponse(url="/login.html?error=invalid_token", status_code=302)
        
        # Alerts page HTML
        html = """
        <!DOCTYPE html>
        <html>
        <head>
            <title>Alerts - Procurement Intelligence</title>
            <script src="https://cdn.tailwindcss.com"></script>
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
            <style>
                .gradient-bg { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
                .alert-card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
            </style>
        </head>
        <body class="bg-gray-50">
            <div class="min-h-screen">
                <!-- Header -->
                <div class="gradient-bg text-white p-6 shadow-lg">
                    <div class="max-w-6xl mx-auto flex justify-between items-center">
                        <div>
                            <h1 class="text-2xl font-bold">🔔 Smart Alerts</h1>
                            <p class="text-purple-100">Never miss an opportunity</p>
                        </div>
                        <a href="/user/dashboard" class="bg-white text-purple-600 px-4 py-2 rounded-lg hover:bg-purple-50">
                            <i class="fas fa-arrow-left mr-2"></i>Back to Dashboard
                        </a>
                    </div>
                </div>

                <div class="max-w-6xl mx-auto p-6">
                    <!-- Create New Alert -->
                    <div class="alert-card">
                        <h2 class="text-xl font-bold mb-4">Create New Alert</h2>
                        <div class="grid grid-cols-2 gap-4 mb-4">
                            <div>
                                <label class="block text-sm font-semibold text-gray-700 mb-2">Alert Type</label>
                                <select class="w-full px-4 py-2 border rounded-lg">
                                    <option>💰 Bargain Alert (below market price)</option>
                                    <option>🎯 Keyword Match</option>
                                    <option>📊 Value Threshold</option>
                                    <option>⏰ Deadline Reminder</option>
                                    <option>🏢 Competitor Activity</option>
                                    <option>📍 Geographic Alert</option>
                                </select>
                            </div>
                            <div>
                                <label class="block text-sm font-semibold text-gray-700 mb-2">Keywords (comma-separated)</label>
                                <input type="text" placeholder="IT services, cloud, software" class="w-full px-4 py-2 border rounded-lg">
                            </div>
                        </div>
                        <div class="grid grid-cols-3 gap-4 mb-4">
                            <div>
                                <label class="block text-sm font-semibold text-gray-700 mb-2">Min Value (€)</label>
                                <input type="number" placeholder="100000" class="w-full px-4 py-2 border rounded-lg">
                            </div>
                            <div>
                                <label class="block text-sm font-semibold text-gray-700 mb-2">Max Value (€)</label>
                                <input type="number" placeholder="5000000" class="w-full px-4 py-2 border rounded-lg">
                            </div>
                            <div>
                                <label class="block text-sm font-semibold text-gray-700 mb-2">Country</label>
                                <select class="w-full px-4 py-2 border rounded-lg">
                                    <option>All Countries</option>
                                    <option>Germany</option>
                                    <option>France</option>
                                    <option>Greece</option>
                                    <option>USA</option>
                                </select>
                            </div>
                        </div>
                        <div class="flex gap-4">
                            <button class="bg-purple-600 text-white px-6 py-2 rounded-lg hover:bg-purple-700">
                                <i class="fas fa-plus mr-2"></i>Create Alert
                            </button>
                        </div>
                    </div>

                    <!-- Active Alerts -->
                    <h2 class="text-xl font-bold mb-4">Active Alerts</h2>
                    
                    <!-- Example Alert 1 -->
                    <div class="alert-card border-l-4 border-green-500">
                        <div class="flex justify-between items-start">
                            <div>
                                <h3 class="font-bold text-lg">💰 IT Services Bargain Alert</h3>
                                <p class="text-gray-600 mt-2">Value: €50K - €500K | Keywords: software, cloud, IT</p>
                                <p class="text-sm text-gray-500 mt-1">Created 2 days ago • <span class="text-green-600 font-semibold">3 matches today</span></p>
                            </div>
                            <div class="flex gap-2">
                                <button class="text-blue-600 hover:text-blue-800"><i class="fas fa-edit"></i></button>
                                <button class="text-red-600 hover:text-red-800"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                    </div>

                    <!-- Example Alert 2 -->
                    <div class="alert-card border-l-4 border-orange-500">
                        <div class="flex justify-between items-start">
                            <div>
                                <h3 class="font-bold text-lg">🏢 Competitor Watch: TechCorp Inc</h3>
                                <p class="text-gray-600 mt-2">Notify when TechCorp Inc wins or bids on contracts</p>
                                <p class="text-sm text-gray-500 mt-1">Created 1 week ago • <span class="text-orange-600 font-semibold">1 match this week</span></p>
                            </div>
                            <div class="flex gap-2">
                                <button class="text-blue-600 hover:text-blue-800"><i class="fas fa-edit"></i></button>
                                <button class="text-red-600 hover:text-red-800"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                    </div>

                    <!-- Example Alert 3 -->
                    <div class="alert-card border-l-4 border-blue-500">
                        <div class="flex justify-between items-start">
                            <div>
                                <h3 class="font-bold text-lg">⏰ Deadline Reminder</h3>
                                <p class="text-gray-600 mt-2">Alert 3 days before deadlines for matching tenders</p>
                                <p class="text-sm text-gray-500 mt-1">Created 3 weeks ago • <span class="text-blue-600 font-semibold">Active</span></p>
                            </div>
                            <div class="flex gap-2">
                                <button class="text-blue-600 hover:text-blue-800"><i class="fas fa-edit"></i></button>
                                <button class="text-red-600 hover:text-red-800"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </body>
        </html>
        """
        return HTMLResponse(content=html)
    
    except jwt.ExpiredSignatureError:
        return RedirectResponse(url="/login.html?error=token_expired", status_code=302)
    except jwt.InvalidTokenError:
        return RedirectResponse(url="/login.html?error=invalid_token", status_code=302)


@app.post("/api/favorites")
async def add_to_favorites(
    tender_data: dict,
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    """Add tender to user favorites"""
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get('email')
        
        if not email:
            return JSONResponse({'success': False, 'error': 'Invalid token'}, status_code=401)
        
        success = add_favorite(email, tender_data)
        return JSONResponse({'success': success})
    
    except jwt.JWTError:
        return JSONResponse({'success': False, 'error': 'Invalid token'}, status_code=401)


@app.delete("/api/favorites/{tender_id}")
async def remove_from_favorites(
    tender_id: str,
    credentials: HTTPAuthorizationCredentials = Depends(security)
):
    """Remove tender from favorites"""
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get('email')
        
        if not email:
            return JSONResponse({'success': False, 'error': 'Invalid token'}, status_code=401)
        
        success = remove_favorite(email, tender_id)
        return JSONResponse({'success': success})
    
    except jwt.JWTError:
        return JSONResponse({'success': False, 'error': 'Invalid token'}, status_code=401)


@app.get("/api/favorites")
async def get_user_favorites(credentials: HTTPAuthorizationCredentials = Depends(security)):
    """Get user's favorites"""
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get('email')
        
        if not email:
            return JSONResponse({'success': False, 'error': 'Invalid token'}, status_code=401)
        
        favorites = get_favorites(email)
        return JSONResponse({'success': True, 'favorites': favorites})
    
    except jwt.JWTError:
        return JSONResponse({'success': False, 'error': 'Invalid token'}, status_code=401)


@app.get("/auth/google/callback")
async def google_oauth_callback(code: str = Query(None), state: str = Query(None)):
    """Handle Google OAuth callback"""
    
    if not code:
        return RedirectResponse(url="/login.html?error=no_code")
    
    if not GOOGLE_CLIENT_ID or not GOOGLE_CLIENT_SECRET:
        return RedirectResponse(url="/login.html?error=oauth_not_configured")
    
    try:
        # Exchange code for access token
        async with httpx.AsyncClient() as client:
            token_response = await client.post(
                "https://oauth2.googleapis.com/token",
                data={
                    "code": code,
                    "client_id": GOOGLE_CLIENT_ID,
                    "client_secret": GOOGLE_CLIENT_SECRET,
                    "redirect_uri": GOOGLE_REDIRECT_URI,
                    "grant_type": "authorization_code",
                }
            )
            
            if token_response.status_code != 200:
                error_body = token_response.text
                print(f"Google token exchange failed. Status: {token_response.status_code}")
                print(f"Response: {error_body}")
                print(f"Redirect URI used: {GOOGLE_REDIRECT_URI}")
                return RedirectResponse(url="/login.html?error=token_exchange_failed")
            
            token_data = token_response.json()
            access_token = token_data.get("access_token")
            
            # Get user info from Google
            user_response = await client.get(
                "https://www.googleapis.com/oauth2/v2/userinfo",
                headers={"Authorization": f"Bearer {access_token}"}
            )
            
            if user_response.status_code != 200:
                return RedirectResponse(url="/login.html?error=user_info_failed")
            
            user_data = user_response.json()
            email = user_data.get("email")
            name = user_data.get("name", email.split("@")[0])
            
            # Create or update user in database
            if email not in users_db:
                users_db[email] = {
                    "email": email,
                    "username": name,
                    "provider": "google",
                    "created_at": datetime.now().isoformat()
                }
            
            # Create JWT token
            token_payload = {
                "email": email,
                "username": name,
                "exp": datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
            }
            jwt_token = jwt.encode(token_payload, SECRET_KEY, algorithm=ALGORITHM)
            
            # Redirect to user dashboard with token in URL (frontend will save to localStorage)
            return RedirectResponse(url=f"/user/dashboard?token={jwt_token}&login=success")
    
    except Exception as e:
        print(f"Google OAuth error: {str(e)}")
        return RedirectResponse(url="/login.html?error=oauth_failed")


if __name__ == '__main__':
    import uvicorn
    port = int(os.getenv("PORT", 8002))
    print("="*60)
    print("PROCUREMENT INTELLIGENCE PLATFORM v2.0")
    print("="*60)
    print("\nStarting server...")
    print(f"Dashboard: http://localhost:{port}")
    print(f"Login: http://localhost:{port}/login.html")
    print(f"User Dashboard: http://localhost:{port}/user/dashboard")
    print(f"API: http://localhost:{port}/api/search")
    print(f"Docs: http://localhost:{port}/docs")
    print("\nPress Ctrl+C to stop")
    print("="*60)
    
    uvicorn.run(app, host="0.0.0.0", port=port)
