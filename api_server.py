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
from functools import wraps

app = Flask(__name__)
CORS(app)

# Import auth service
from eurodash.auth import AuthService
from eurodash.config import Config

cfg = Config.load('config.yml')
auth_service = AuthService(cfg.get('warehouse', 'duckdb_path'))

def token_required(f):
    """Decorator to require authentication"""
    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.headers.get('Authorization')
        
        if not token:
            return jsonify({'error': 'Token is missing'}), 401
        
        if token.startswith('Bearer '):
            token = token[7:]
        
        user_data = auth_service.verify_token(token)
        
        if not user_data:
            return jsonify({'error': 'Token is invalid or expired'}), 401
        
        return f(user_data, *args, **kwargs)
    
    return decorated

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


if __name__ == '__main__':
    print("=" * 60)
    print("Dashboard API Server Starting")
    print("=" * 60)
    print()
    print("Features:")
    print("  * On-demand dashboard generation with AI")
    print("  * Auto-analyzes data for optimal insights")
    print("  * Proposes best report structure")
    print("  * Real-time generation progress")
    print()
    print("Server running at: http://localhost:5000")
    print("Serving from: site/_site/")
    print()
    print("Press Ctrl+C to stop")
    print("=" * 60)
    
    app.run(debug=True, port=5000, threaded=True)
