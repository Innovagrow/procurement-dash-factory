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

# Configuration
SECRET_KEY = os.getenv("SECRET_KEY", "change-this-secret-key-in-production")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

# Google OAuth Configuration
GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID")
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET")
GOOGLE_REDIRECT_URI = os.getenv("HOST", "http://localhost:8002") + "/auth/google/callback"

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
    """Homepage - serves Quarto-rendered site"""
    
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
        
        # Verify password (using passlib for secure password hashing)
        from passlib.context import CryptContext
        pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
        
        if "hashed_password" not in user or not pwd_context.verify(password, user["hashed_password"]):
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
        print(f"Login error: {str(e)}")
        return JSONResponse({
            'success': False,
            'error': 'Login failed'
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
        
        if len(password) < 8:
            return JSONResponse({
                'success': False,
                'error': 'Password must be at least 8 characters'
            }, status_code=400)
        
        # Check if user already exists
        if email in users_db:
            return JSONResponse({
                'success': False,
                'error': 'Email already registered'
            }, status_code=400)
        
        # Hash password
        from passlib.context import CryptContext
        pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")
        hashed_password = pwd_context.hash(password)
        
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
        print(f"Signup error: {str(e)}")
        return JSONResponse({
            'success': False,
            'error': 'Signup failed'
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
            <a href="/" style="color: white;">← Back to Home</a>
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
        
        return HTMLResponse(content=UserDashboard.get_user_dashboard_html(email))
    
    except jwt.ExpiredSignatureError:
        return RedirectResponse(url="/login.html?error=token_expired", status_code=302)
    except jwt.JWTError:
        return RedirectResponse(url="/login.html?error=invalid_token", status_code=302)
    except Exception as e:
        print(f"Dashboard error: {str(e)}")
        return RedirectResponse(url="/login.html?error=server_error", status_code=302)


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
