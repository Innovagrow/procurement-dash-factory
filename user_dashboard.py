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
            <title>My Dashboard - Procurement Intelligence</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css">
            <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css">
            <style>
                * {{ margin: 0; padding: 0; box-sizing: border-box; }}
                body {{ 
                    background: #f5f7fa; 
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
                }}
                
                /* Header with Profile */
                .top-header {{
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 1rem 0;
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                }}
                .header-content {{
                    max-width: 1400px;
                    margin: 0 auto;
                    padding: 0 2rem;
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }}
                .logo {{ 
                    font-size: 1.5rem; 
                    font-weight: bold; 
                    display: flex; 
                    align-items: center; 
                    gap: 0.5rem;
                    transition: all 0.3s;
                }}
                .logo:hover {{
                    transform: scale(1.05);
                    opacity: 0.9;
                }}
                
                /* Profile Dropdown */
                .profile-dropdown {{
                    position: relative;
                    display: inline-block;
                }}
                .profile-btn {{
                    background: rgba(255,255,255,0.2);
                    border: none;
                    color: white;
                    padding: 0.5rem 1rem;
                    border-radius: 25px;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    transition: all 0.3s;
                }}
                .profile-btn:hover {{ background: rgba(255,255,255,0.3); }}
                .profile-menu {{
                    display: none;
                    position: absolute;
                    right: 0;
                    top: 100%;
                    margin-top: 0.5rem;
                    background: white;
                    border-radius: 10px;
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                    min-width: 200px;
                    z-index: 1000;
                }}
                .profile-menu.show {{ display: block; }}
                .profile-menu a {{
                    display: block;
                    padding: 0.75rem 1.25rem;
                    color: #333;
                    text-decoration: none;
                    transition: background 0.2s;
                }}
                .profile-menu a:hover {{ background: #f5f7fa; }}
                .profile-menu a:first-child {{ border-radius: 10px 10px 0 0; }}
                .profile-menu a:last-child {{ border-radius: 0 0 10px 10px; border-top: 1px solid #e2e8f0; }}
                
                /* Main Container - Full Width */
                .main-container {{
                    max-width: 1400px;
                    margin: 2rem auto;
                    padding: 0 2rem;
                }}
                
                /* Stats Grid */
                .stats-grid {{
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
                    gap: 1.5rem;
                    margin-bottom: 2rem;
                }}
                .stat-card {{
                    background: white;
                    border-radius: 12px;
                    padding: 1.5rem;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                    transition: transform 0.2s;
                }}
                .stat-card:hover {{ transform: translateY(-4px); box-shadow: 0 4px 12px rgba(0,0,0,0.12); }}
                .stat-icon {{
                    width: 48px;
                    height: 48px;
                    border-radius: 10px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 1.5rem;
                    margin-bottom: 1rem;
                }}
                .stat-value {{ font-size: 2rem; font-weight: bold; color: #2d3748; }}
                .stat-label {{ color: #718096; font-size: 0.875rem; margin-top: 0.25rem; }}
                
                /* Report Cards */
                .report-card {{
                    background: white;
                    border-radius: 12px;
                    padding: 1.5rem;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.08);
                    margin-bottom: 1.5rem;
                    transition: all 0.2s;
                    cursor: pointer;
                }}
                .report-card:hover {{ 
                    transform: translateY(-4px); 
                    box-shadow: 0 8px 16px rgba(0,0,0,0.12);
                }}
                .report-badge {{
                    display: inline-block;
                    padding: 0.25rem 0.75rem;
                    border-radius: 20px;
                    font-size: 0.75rem;
                    font-weight: 600;
                    margin-right: 0.5rem;
                }}
                .badge-trending {{ background: #fed7d7; color: #c53030; }}
                .badge-new {{ background: #c6f6d5; color: #2f855a; }}
                .badge-popular {{ background: #feebc8; color: #c05621; }}
                
                .section-title {{
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: #2d3748;
                    margin-bottom: 1.5rem;
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                }}
                
                .btn-primary {{
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    border: none;
                    padding: 0.75rem 1.5rem;
                    border-radius: 8px;
                    color: white;
                    font-weight: 600;
                    transition: all 0.3s;
                }}
                .btn-primary:hover {{ transform: translateY(-2px); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }}
                .btn-favorite {{
                    background: #f56565;
                    color: white;
                    border: none;
                    padding: 0.5rem 1rem;
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
            <!-- Top Header with Profile -->
            <div class="top-header">
                <div class="header-content">
                    <a href="/user/dashboard" class="logo" style="text-decoration: none; color: white; cursor: pointer;">
                        <i class="fas fa-gavel"></i>
                        <span>Procurement Intelligence</span>
                    </a>
                    <div class="profile-dropdown">
                        <button class="profile-btn" onclick="toggleProfile()">
                            <i class="fas fa-user-circle"></i>
                            <span>{user_email.split("@")[0].title()}</span>
                            <i class="fas fa-chevron-down" style="font-size: 0.75rem;"></i>
                        </button>
                        <div class="profile-menu" id="profileMenu">
                            <a href="/user/dashboard"><i class="fas fa-home"></i> Dashboard</a>
                            <a href="/user/settings"><i class="fas fa-cog"></i> Settings</a>
                            <a href="/" onclick="logout(event)"><i class="fas fa-sign-out-alt"></i> Logout</a>
                        </div>
                    </div>
                </div>
            </div>
            
            <!-- Main Content -->
            <div class="main-container">
                <!-- Quick Stats -->
                <div class="stats-grid">
                    <div class="stat-card">
                        <div class="stat-icon" style="background: #ebf8ff; color: #3182ce;">
                            <i class="fas fa-star"></i>
                        </div>
                        <div class="stat-value">{len(favorites)}</div>
                        <div class="stat-label">Saved Favorites</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon" style="background: #fef5e7; color: #f39c12;">
                            <i class="fas fa-fire"></i>
                        </div>
                        <div class="stat-value">12</div>
                        <div class="stat-label">Trending Reports</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon" style="background: #e8f5e9; color: #2e7d32;">
                            <i class="fas fa-bell"></i>
                        </div>
                        <div class="stat-value">3</div>
                        <div class="stat-label">Active Alerts</div>
                    </div>
                    <div class="stat-card">
                        <div class="stat-icon" style="background: #fce4ec; color: #c2185b;">
                            <i class="fas fa-chart-line"></i>
                        </div>
                        <div class="stat-value">5</div>
                        <div class="stat-label">Recent Views</div>
                    </div>
                </div>
                
                <!-- Trending Reports -->
                <div style="margin-bottom: 3rem;">
                    <h2 class="section-title">
                        <i class="fas fa-fire" style="color: #f39c12;"></i>
                        Trending Reports
                    </h2>
                    <div class="row">
                        <div class="col-md-6">
                            <div class="report-card" onclick="window.location.href='/dashboard/it-tenders'">
                                <div style="margin-bottom: 1rem;">
                                    <span class="report-badge badge-trending"><i class="fas fa-fire"></i> Trending</span>
                                    <span class="report-badge badge-new"><i class="fas fa-sparkles"></i> New</span>
                                </div>
                                <h4 style="margin-bottom: 0.5rem;">IT & Digital Services Tenders</h4>
                                <p style="color: #718096; font-size: 0.875rem; margin-bottom: 1rem;">
                                    Latest technology procurement opportunities across EU and US markets
                                </p>
                                <div style="display: flex; gap: 1rem; font-size: 0.875rem; color: #a0aec0;">
                                    <span><i class="fas fa-eye"></i> 1,234 views</span>
                                    <span><i class="fas fa-chart-line"></i> +25% this week</span>
                                </div>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <div class="report-card" onclick="window.location.href='/dashboard/value-analysis'">
                                <div style="margin-bottom: 1rem;">
                                    <span class="report-badge badge-popular"><i class="fas fa-star"></i> Popular</span>
                                </div>
                                <h4 style="margin-bottom: 0.5rem;">Value Analysis Dashboard</h4>
                                <p style="color: #718096; font-size: 0.875rem; margin-bottom: 1rem;">
                                    Contract value trends, distribution analysis, and budget insights
                                </p>
                                <div style="display: flex; gap: 1rem; font-size: 0.875rem; color: #a0aec0;">
                                    <span><i class="fas fa-eye"></i> 892 views</span>
                                    <span><i class="fas fa-chart-line"></i> +15% this week</span>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Report Gallery -->
                <div style="margin-bottom: 3rem;">
                    <h2 class="section-title">
                        <i class="fas fa-th"></i>
                        Report Gallery
                    </h2>
                    <div class="row">
                        <div class="col-md-4 mb-3">
                            <div class="report-card" onclick="window.location.href='/dashboard/tenders'">
                                <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); height: 120px; border-radius: 8px; margin-bottom: 1rem; display: flex; align-items: center; justify-content: center;">
                                    <i class="fas fa-briefcase" style="font-size: 3rem; color: white;"></i>
                                </div>
                                <h5>All Tenders</h5>
                                <p style="color: #718096; font-size: 0.875rem;">Comprehensive tender database</p>
                            </div>
                        </div>
                        <div class="col-md-4 mb-3">
                            <div class="report-card" onclick="window.location.href='/dashboard/countries'">
                                <div style="background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%); height: 120px; border-radius: 8px; margin-bottom: 1rem; display: flex; align-items: center; justify-content: center;">
                                    <i class="fas fa-globe-americas" style="font-size: 3rem; color: white;"></i>
                                </div>
                                <h5>Geographic Analysis</h5>
                                <p style="color: #718096; font-size: 0.875rem;">Country and region insights</p>
                            </div>
                        </div>
                        <div class="col-md-4 mb-3">
                            <div class="report-card" onclick="window.location.href='/dashboard/awards'">
                                <div style="background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%); height: 120px; border-radius: 8px; margin-bottom: 1rem; display: flex; align-items: center; justify-content: center;">
                                    <i class="fas fa-trophy" style="font-size: 3rem; color: white;"></i>
                                </div>
                                <h5>Contract Awards</h5>
                                <p style="color: #718096; font-size: 0.875rem;">Winner analysis and trends</p>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- My Favorites & Quick Actions -->
                <div class="row">
                    <div class="col-md-8">
                        <h2 class="section-title">
                            <i class="fas fa-star" style="color: #f39c12;"></i>
                            My Favorites
                        </h2>
                        {UserDashboard._render_favorites(favorites)}
                    </div>
                    
                    <div class="col-md-4">
                        <h2 class="section-title">
                            <i class="fas fa-bolt" style="color: #805ad5;"></i>
                            Quick Actions
                        </h2>
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
                
                // Profile dropdown toggle
                function toggleProfile() {{
                    const menu = document.getElementById('profileMenu');
                    menu.classList.toggle('show');
                }}
                
                // Close dropdown when clicking outside
                window.onclick = function(event) {{
                    if (!event.target.matches('.profile-btn') && !event.target.closest('.profile-btn')) {{
                        const menu = document.getElementById('profileMenu');
                        if (menu.classList.contains('show')) {{
                            menu.classList.remove('show');
                        }}
                    }}
                }}
                
                // Logout function
                function logout(event) {{
                    event.preventDefault();
                    localStorage.removeItem('auth_token');
                    localStorage.removeItem('user');
                    window.location.href = '/';
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
