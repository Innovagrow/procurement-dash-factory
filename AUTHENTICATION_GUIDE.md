# Authentication Implementation Guide

## What's Been Added ✅

### 1. **Login Required for Reports**
- All "View Report" buttons now check authentication before proceeding
- If user is NOT logged in → Shows login modal popup
- If user IS logged in → Proceeds to report page
- Pending report URL is saved and user is redirected after login

### 2. **Login Modal Popup**
- Beautiful Bootstrap modal with purple gradient header
- Two tabs: Login & Sign Up
- Email/password forms
- Google login button
- Appears when user tries to access reports without authentication
- No page redirect needed - stays on same page

### 3. **Google OAuth Integration**
- "Continue with Google" button added
- Appears in both modal popup and standalone login page
- Google logo SVG with proper colors
- Ready for OAuth 2.0 implementation

### 4. **Fixed Encoding Issues**
- Changed `€` to `&euro;` HTML entity
- Prevents encoding issues in browsers
- Now displays correctly as "€600B+/year" instead of "â,¬600B+/year"

## How Authentication Works

### Frontend Flow:
1. User clicks "View Report" on any dashboard card
2. JavaScript checks `localStorage.getItem('auth_token')`
3. If token exists → Allow access to report
4. If no token → Show login modal
5. After successful login → Save token & redirect to pending report

### Modal Login Process:
```javascript
1. User fills form in modal
2. POST request to /api/auth/login
3. Server validates credentials
4. Returns { success: true, token: "...", user: {...} }
5. Save to localStorage
6. Redirect to pending report URL
7. Close modal
```

### Google OAuth Process:
```javascript
1. User clicks "Continue with Google"
2. Redirect to Google OAuth consent screen
3. User authorizes
4. Google redirects to /auth/google/callback
5. Backend exchanges code for user info
6. Create/login user
7. Return token
8. Redirect to pending report
```

## Backend Implementation Needed

### 1. Authentication Endpoints (app.py)

```python
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from datetime import datetime, timedelta
import jwt

SECRET_KEY = "your-secret-key-here"  # Change this!
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

security = HTTPBearer()

# In-memory user store (replace with database)
users_db = {}

@app.post("/api/auth/signup")
async def signup(data: dict):
    username = data.get('username')
    email = data.get('email')
    password = data.get('password')

    # Check if user exists
    if email in users_db:
        return JSONResponse({'success': False, 'error': 'Email already exists'})

    # Hash password (use bcrypt in production!)
    import hashlib
    hashed_password = hashlib.sha256(password.encode()).hexdigest()

    # Create user
    user = {
        'username': username,
        'email': email,
        'password': hashed_password,
        'created_at': datetime.now().isoformat()
    }
    users_db[email] = user

    # Generate token
    token = jwt.encode({
        'email': email,
        'exp': datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    }, SECRET_KEY, algorithm=ALGORITHM)

    return JSONResponse({
        'success': True,
        'token': token,
        'user': {'username': username, 'email': email}
    })

@app.post("/api/auth/login")
async def login(data: dict):
    email = data.get('email')
    password = data.get('password')

    # Check if user exists
    if email not in users_db:
        return JSONResponse({'success': False, 'error': 'Invalid credentials'})

    user = users_db[email]

    # Verify password
    import hashlib
    hashed_password = hashlib.sha256(password.encode()).hexdigest()

    if user['password'] != hashed_password:
        return JSONResponse({'success': False, 'error': 'Invalid credentials'})

    # Generate token
    token = jwt.encode({
        'email': email,
        'exp': datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    }, SECRET_KEY, algorithm=ALGORITHM)

    return JSONResponse({
        'success': True,
        'token': token,
        'user': {'username': user['username'], 'email': email}
    })

def verify_token(credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        token = credentials.credentials
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        email = payload.get('email')
        if email is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        return email
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.JWTError:
        raise HTTPException(status_code=401, detail="Invalid token")
```

### 2. Google OAuth Setup

#### Step 1: Get Google OAuth Credentials
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create new project or select existing
3. Enable "Google+ API"
4. Create OAuth 2.0 credentials
5. Add authorized redirect URI: `http://localhost:8002/auth/google/callback`
6. Get Client ID and Client Secret

#### Step 2: Add to Environment
```bash
# .env file
GOOGLE_CLIENT_ID=your-client-id-here
GOOGLE_CLIENT_SECRET=your-client-secret-here
```

#### Step 3: Implement Callback Endpoint
```python
from fastapi import Request
import httpx

@app.get("/auth/google/callback")
async def google_callback(code: str, request: Request):
    # Exchange code for access token
    token_url = "https://oauth2.googleapis.com/token"
    data = {
        'code': code,
        'client_id': os.getenv('GOOGLE_CLIENT_ID'),
        'client_secret': os.getenv('GOOGLE_CLIENT_SECRET'),
        'redirect_uri': str(request.base_url) + 'auth/google/callback',
        'grant_type': 'authorization_code'
    }

    async with httpx.AsyncClient() as client:
        token_response = await client.post(token_url, data=data)
        tokens = token_response.json()

        # Get user info
        user_info_response = await client.get(
            'https://www.googleapis.com/oauth2/v2/userinfo',
            headers={'Authorization': f'Bearer {tokens["access_token"]}'}
        )
        user_info = user_info_response.json()

    # Create or login user
    email = user_info['email']
    username = user_info.get('name', email.split('@')[0])

    if email not in users_db:
        users_db[email] = {
            'username': username,
            'email': email,
            'google_id': user_info['id'],
            'created_at': datetime.now().isoformat()
        }

    # Generate our token
    token = jwt.encode({
        'email': email,
        'exp': datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    }, SECRET_KEY, algorithm=ALGORITHM)

    # Redirect to home with token
    return HTMLResponse(f"""
    <html>
    <script>
        localStorage.setItem('auth_token', '{token}');
        localStorage.setItem('user', JSON.stringify({{username: '{username}', email: '{email}'}}));
        const pendingReport = sessionStorage.getItem('pending_report');
        if (pendingReport) {{
            window.location.href = pendingReport;
            sessionStorage.removeItem('pending_report');
        }} else {{
            window.location.href = '/';
        }}
    </script>
    </html>
    """)
```

### 3. Update Client ID in Frontend

Replace `YOUR_GOOGLE_CLIENT_ID` in:
- `site/index.qmd` (line in loginWithGoogle function)
- `site/login.html` (line in loginWithGoogle function)

```javascript
const clientId = 'your-actual-client-id.apps.googleusercontent.com';
```

## Testing

### Test Authentication Flow:
1. Open `http://localhost:8002`
2. Click any "View Report" button
3. Login modal should appear
4. Enter credentials or click Google login
5. After login → should redirect to report

### Test Google Login:
1. Get Google OAuth credentials
2. Update CLIENT_ID in code
3. Click "Continue with Google"
4. Authorize on Google
5. Should redirect back and login automatically

## Security Notes

- ⚠️ Store JWT secret in environment variables
- ⚠️ Use bcrypt or Argon2 for password hashing (not SHA256)
- ⚠️ Implement rate limiting on auth endpoints
- ⚠️ Use HTTPS in production
- ⚠️ Set secure HttpOnly cookies for tokens instead of localStorage
- ⚠️ Add CSRF protection
- ⚠️ Implement token refresh mechanism

## Files Modified

1. **site/index.qmd**
   - Fixed € encoding (`&euro;`)
   - Added login modal HTML
   - Added authentication check JavaScript
   - Added Google login function

2. **site/login.html**
   - Added Google login buttons (login & signup tabs)
   - Added Google OAuth function
   - Google logo SVG

3. **app.py** (needs updates)
   - Add `/api/auth/login` endpoint
   - Add `/api/auth/signup` endpoint
   - Add `/auth/google/callback` endpoint
   - Add token verification middleware
