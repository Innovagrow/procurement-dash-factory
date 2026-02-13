"""
User Personal Dashboard with Favorites
"""
from fastapi import Request, Depends, HTTPException
from fastapi.responses import HTMLResponse
import json
from pathlib import Path

# In-memory storage (replace with database)
user_favorites = {}
user_preferences = {}

class UserDashboard:
    """Manage user personal dashboards and favorites"""
    
    @staticmethod
    def get_user_dashboard_html(user_email: str):
        """Generate personalized dashboard for logged-in user"""
        
        favorites = user_favorites.get(user_email, [])
        prefs = user_preferences.get(user_email, {})
        
        html = f'''
        <!DOCTYPE html>
        <html>
        <head>
            <title>My Dashboard</title>
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
            <style>
                body {{ background: #f5f7fa; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; }}
                .header {{
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 30px;
                    margin-bottom: 30px;
                }}
                .stat-card {{
                    background: white;
                    border-radius: 10px;
                    padding: 25px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    margin-bottom: 20px;
                }}
                .stat-value {{ font-size: 36px; font-weight: bold; color: #667eea; }}
                .stat-label {{ color: #64748b; margin-top: 5px; }}
                .favorite-card {{
                    background: white;
                    border-radius: 10px;
                    padding: 20px;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    margin-bottom: 15px;
                    transition: transform 0.2s;
                }}
                .favorite-card:hover {{ transform: translateY(-2px); box-shadow: 0 4px 8px rgba(0,0,0,0.15); }}
                .btn-favorite {{
                    background: #f56565;
                    color: white;
                    border: none;
                    padding: 8px 15px;
                    border-radius: 5px;
                    cursor: pointer;
                }}
                .btn-favorite:hover {{ background: #e53e3e; }}
                .section-title {{ font-size: 24px; font-weight: bold; margin: 30px 0 20px; }}
                .quick-action {{
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 20px;
                    border-radius: 10px;
                    text-decoration: none;
                    display: block;
                    margin-bottom: 15px;
                    text-align: center;
                    font-weight: 600;
                    transition: opacity 0.2s;
                }}
                .quick-action:hover {{ opacity: 0.9; color: white; }}
            </style>
        </head>
        <body>
            <div class="header">
                <h1><i class="fas fa-user-circle"></i> Welcome, {user_email.split("@")[0].title()}!</h1>
                <p>Your personal procurement intelligence dashboard</p>
            </div>
            
            <div class="container">
                <div class="row">
                    <div class="col-md-8">
                        <h2 class="section-title"><i class="fas fa-star"></i> My Favorites</h2>
                        
                        {UserDashboard._render_favorites(favorites)}
                        
                        <h2 class="section-title"><i class="fas fa-clock"></i> Recent Activity</h2>
                        <div class="stat-card">
                            <p class="text-muted">No recent activity yet. Start exploring tenders!</p>
                        </div>
                    </div>
                    
                    <div class="col-md-4">
                        <h2 class="section-title"><i class="fas fa-chart-line"></i> Quick Stats</h2>
                        
                        <div class="stat-card">
                            <div class="stat-value">{len(favorites)}</div>
                            <div class="stat-label">Saved Favorites</div>
                        </div>
                        
                        <div class="stat-card">
                            <div class="stat-value">0</div>
                            <div class="stat-label">Alerts Set</div>
                        </div>
                        
                        <div class="stat-card">
                            <div class="stat-value">0</div>
                            <div class="stat-label">Bids Submitted</div>
                        </div>
                        
                        <h2 class="section-title"><i class="fas fa-bolt"></i> Quick Actions</h2>
                        
                        <a href="/dashboard/tenders" class="quick-action">
                            <i class="fas fa-search"></i> Browse All Tenders
                        </a>
                        
                        <a href="/dashboard/it-tenders" class="quick-action">
                            <i class="fas fa-laptop-code"></i> IT Opportunities
                        </a>
                        
                        <a href="/dashboard/countries" class="quick-action">
                            <i class="fas fa-globe"></i> Geographic Analysis
                        </a>
                        
                        <a href="/user/settings" class="quick-action">
                            <i class="fas fa-cog"></i> Settings & Alerts
                        </a>
                    </div>
                </div>
            </div>
            
            <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
            <script>
                // Handle OAuth callback token from URL
                const urlParams = new URLSearchParams(window.location.search);
                const token = urlParams.get('token');
                const loginStatus = urlParams.get('login');
                
                if (token && loginStatus === 'success') {{
                    localStorage.setItem('auth_token', token);
                    // Clean URL
                    window.history.replaceState({{}}, document.title, window.location.pathname);
                }}
                
                function removeFavorite(tenderId) {{
                    fetch(`/api/favorites/${{tenderId}}`, {{
                        method: 'DELETE',
                        headers: {{
                            'Authorization': `Bearer ${{localStorage.getItem('auth_token')}}`
                        }}
                    }})
                    .then(response => response.json())
                    .then(data => {{
                        if (data.success) {{
                            location.reload();
                        }}
                    }});
                }}
            </script>
        </body>
        </html>
        '''
        
        return html
    
    @staticmethod
    def _render_favorites(favorites):
        """Render user's favorite tenders"""
        if not favorites:
            return '''
            <div class="stat-card">
                <p class="text-muted">No favorites yet. Click the star icon on any tender to save it here.</p>
            </div>
            '''
        
        html = ''
        for fav in favorites:
            html += f'''
            <div class="favorite-card">
                <h5>{fav['title']}</h5>
                <p class="text-muted mb-2">{fav.get('description', 'No description')[:150]}...</p>
                <div class="d-flex justify-content-between align-items-center">
                    <span class="badge bg-primary">{fav.get('country', 'N/A')}</span>
                    <span class="badge bg-success">EUR {fav.get('value', 0):,.0f}</span>
                    <button class="btn-favorite" onclick="removeFavorite('{fav['id']}')">
                        <i class="fas fa-trash"></i> Remove
                    </button>
                </div>
            </div>
            '''
        
        return html

# API endpoints for favorites
def add_favorite(user_email: str, tender_data: dict):
    """Add tender to user favorites"""
    if user_email not in user_favorites:
        user_favorites[user_email] = []
    
    # Check if already exists
    if not any(f['id'] == tender_data['id'] for f in user_favorites[user_email]):
        user_favorites[user_email].append(tender_data)
        return True
    return False

def remove_favorite(user_email: str, tender_id: str):
    """Remove tender from favorites"""
    if user_email in user_favorites:
        user_favorites[user_email] = [
            f for f in user_favorites[user_email] 
            if f['id'] != tender_id
        ]
        return True
    return False

def get_favorites(user_email: str):
    """Get user's favorites"""
    return user_favorites.get(user_email, [])
