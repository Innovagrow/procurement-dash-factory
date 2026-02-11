"""
Simple API server for on-demand dashboard generation
"""
from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
import subprocess
import os
from pathlib import Path
import threading
import time
import json
from eurodash.auth import init_auth_db, signup_user, login_user, get_current_user, UserLogin, UserSignup

app = Flask(__name__)
CORS(app)

# Initialize authentication database
init_auth_db()

# Track generation status
generation_status = {}

def generate_dashboard_async(dataset_code):
    """Run fast dashboard generation with parallel processing"""
    try:
        from eurodash.config import Config
        from eurodash.parallel_processor import fetch_and_analyze_parallel
        from eurodash.ingest import upsert_fact
        from eurodash.ai_planner import build_ai_enhanced_plan
        from eurodash.fast_render import render_fast_dashboard
        
        generation_status[dataset_code] = {
            'status': 'running',
            'progress': 10,
            'message': 'Fetching data with smart filtering...'
        }
        
        cfg = Config.load('config.yml')
        
        # Parallel: Fetch data + prepare for AI
        generation_status[dataset_code]['progress'] = 30
        df, ai_result = fetch_and_analyze_parallel(cfg, dataset_code)
        
        if df.empty:
            generation_status[dataset_code]['status'] = 'failed'
            generation_status[dataset_code]['message'] = 'This dataset has no data available. Try a different dataset.'
            return
        
        # Save data
        generation_status[dataset_code]['progress'] = 50
        generation_status[dataset_code]['message'] = 'Saving data and running AI analysis...'
        upsert_fact(cfg, df, dataset_code)
        
        # Build AI plan
        generation_status[dataset_code]['progress'] = 70
        generation_status[dataset_code]['message'] = 'Building dashboard structure...'
        
        plan = build_ai_enhanced_plan(cfg, dataset_code)
        plan_path = Path('plans') / f'{dataset_code}_ai.json'
        plan_path.parent.mkdir(exist_ok=True)
        plan_path.write_text(json.dumps(plan, indent=2), encoding='utf-8')
        
        # Fast render (no Quarto - direct HTML)
        generation_status[dataset_code]['progress'] = 90
        generation_status[dataset_code]['message'] = 'Rendering dashboard...'
        
        output_html = Path(f'site/_site/dashboards/{dataset_code}_ai.html')
        db_path = cfg.get('warehouse', 'duckdb_path')
        
        render_fast_dashboard(dataset_code, db_path, plan_path, output_html)
        
        generation_status[dataset_code]['progress'] = 100
        generation_status[dataset_code]['status'] = 'completed'
        generation_status[dataset_code]['message'] = 'Dashboard ready!'
        generation_status[dataset_code]['url'] = f'/dashboards/{dataset_code}_ai.html'
            
    except Exception as e:
        generation_status[dataset_code]['status'] = 'failed'
        generation_status[dataset_code]['message'] = f'Error: {str(e)}'


@app.route('/api/generate-dashboard', methods=['POST'])
def generate_dashboard():
    """Trigger dashboard generation"""
    dataset_code = request.args.get('dataset')
    
    if not dataset_code:
        return jsonify({'success': False, 'error': 'Missing dataset parameter'}), 400
    
    # Check if already exists
    dashboard_path = Path(f'site/_site/dashboards/{dataset_code}_ai.html')
    if dashboard_path.exists():
        return jsonify({
            'success': True,
            'url': f'/dashboards/{dataset_code}_ai.html',
            'cached': True
        })
    
    # Check if already generating
    if dataset_code in generation_status:
        status = generation_status[dataset_code]
        if status['status'] == 'running':
            return jsonify({
                'success': True,
                'generating': True,
                'progress': status['progress'],
                'message': status['message']
            })
        elif status['status'] == 'completed':
            return jsonify({
                'success': True,
                'url': status['url']
            })
        elif status['status'] == 'failed':
            # Clear failed status and retry
            del generation_status[dataset_code]
    
    # Start generation in background thread
    thread = threading.Thread(target=generate_dashboard_async, args=(dataset_code,))
    thread.daemon = True
    thread.start()
    
    return jsonify({
        'success': True,
        'generating': True,
        'message': 'Dashboard generation started'
    })


@app.route('/api/status/<dataset_code>')
def check_status(dataset_code):
    """Check generation status"""
    if dataset_code not in generation_status:
        # Check if file exists
        dashboard_path = Path(f'site/_site/dashboards/{dataset_code}_ai.html')
        if dashboard_path.exists():
            return jsonify({
                'status': 'completed',
                'progress': 100,
                'url': f'/dashboards/{dataset_code}_ai.html'
            })
        return jsonify({
            'status': 'not_found',
            'progress': 0
        })
    
    status = generation_status[dataset_code]
    return jsonify(status)


@app.route('/')
def serve_home():
    """Redirect home to catalog.html"""
    return send_from_directory('site/_site', 'catalog.html')

@app.route('/<path:path>')
def serve_static(path):
    """Serve static files"""
    return send_from_directory('site/_site', path)


@app.route('/api/auth/signup', methods=['POST'])
def api_signup():
    """User signup endpoint"""
    try:
        data = request.get_json()
        signup = UserSignup(**data)
        result = signup_user(signup)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400

@app.route('/api/auth/login', methods=['POST'])
def api_login():
    """User login endpoint"""
    try:
        data = request.get_json()
        login = UserLogin(**data)
        result = login_user(login)
        return jsonify(result)
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 400

@app.route('/api/auth/me', methods=['GET'])
def api_get_user():
    """Get current user from token"""
    auth_header = request.headers.get('Authorization')
    if not auth_header or not auth_header.startswith('Bearer '):
        return jsonify({'error': 'No token provided'}), 401
    
    token = auth_header.split(' ')[1]
    user = get_current_user(token)
    
    if not user:
        return jsonify({'error': 'Invalid token'}), 401
    
    return jsonify({'success': True, 'user': user})


if __name__ == '__main__':
    import os
    port = int(os.environ.get('PORT', 5000))
    
    print("=" * 60)
    print("Dashboard API Server Starting")
    print("=" * 60)
    print()
    print("Features:")
    print("  * On-demand dashboard generation with AI")
    print("  * Auto-analyzes data for optimal insights")
    print("  * Proposes best report structure")
    print("  * Real-time generation progress")
    print("  * User authentication (JWT)")
    print()
    print(f"Server running on port: {port}")
    print("Serving from: site/_site/")
    print()
    print("Endpoints:")
    print("  - POST /api/auth/signup")
    print("  - POST /api/auth/login")
    print("  - GET  /api/auth/me")
    print()
    print("Press Ctrl+C to stop")
    print("=" * 60)
    
    app.run(host='0.0.0.0', port=port, debug=False, threaded=True)
