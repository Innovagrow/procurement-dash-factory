# Google OAuth Setup Guide

## Step-by-Step Instructions

### 1. Create Google Cloud Project

1. **Go to Google Cloud Console**
   - Visit: https://console.cloud.google.com/
   - Sign in with your Google account

2. **Create New Project**
   - Click the project dropdown at the top
   - Click "New Project"
   - Name: "Procurement Intelligence Platform"
   - Click "Create"
   - Wait for project to be created
   - Select the new project from dropdown

### 2. Configure OAuth Consent Screen

1. **Navigate to OAuth Consent**
   - In the left menu, go to: "APIs & Services" → "OAuth consent screen"

2. **Choose User Type**
   - Select "External" (for public use)
   - Click "Create"

3. **Fill App Information**
   - **App name:** Procurement Intelligence Platform
   - **User support email:** Your email
   - **App logo:** (Optional) Upload your logo
   - **Application home page:** http://localhost:8002
   - **Authorized domains:** (leave empty for localhost testing)
   - **Developer contact:** Your email
   - Click "Save and Continue"

4. **Scopes**
   - Click "Add or Remove Scopes"
   - Select:
     - `userinfo.email`
     - `userinfo.profile`
   - Click "Update"
   - Click "Save and Continue"

5. **Test Users** (for development)
   - Click "Add Users"
   - Add your email address
   - Click "Save and Continue"

6. **Summary**
   - Review and click "Back to Dashboard"

### 3. Create OAuth 2.0 Credentials

1. **Navigate to Credentials**
   - In left menu: "APIs & Services" → "Credentials"
   - Click "+ CREATE CREDENTIALS"
   - Select "OAuth client ID"

2. **Application Type**
   - Choose: "Web application"
   - Name: "Procurement Platform Web Client"

3. **Authorized JavaScript origins**
   - Click "Add URI"
   - Add: `http://localhost:8002`

4. **Authorized redirect URIs**
   - Click "Add URI"
   - Add: `http://localhost:8002/auth/google/callback`
   - Click "Create"

5. **Save Your Credentials**
   - **Copy the Client ID** - looks like: `123456789-abc123.apps.googleusercontent.com`
   - **Copy the Client Secret** - looks like: `GOCSPX-abc123def456`
   - Click "OK"

### 4. Update Your Code

#### A. Create `.env` file in project root:

```bash
# .env
GOOGLE_CLIENT_ID=your-client-id-here.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-your-client-secret-here
SECRET_KEY=your-super-secret-jwt-key-change-this
```

#### B. Update `site/index.qmd`:

Find the `loginWithGoogle()` function and replace:
```javascript
const clientId = 'YOUR_GOOGLE_CLIENT_ID';
```

With your actual Client ID:
```javascript
const clientId = '123456789-abc123.apps.googleusercontent.com';
```

#### C. Update `site/login.html`:

Same as above - replace `'YOUR_GOOGLE_CLIENT_ID'` with your actual Client ID.

### 5. Install Required Python Packages

```bash
pip install python-jose[cryptography] passlib[bcrypt] python-multipart httpx python-dotenv
```

### 6. Add Backend Code to `app.py`

Add this at the top of `app.py`:

```python
import os
from dotenv import load_dotenv
from datetime import datetime, timedelta
import jwt
import httpx
from passlib.context import CryptContext

# Load environment variables
load_dotenv()

# Password hashing
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# JWT Configuration
SECRET_KEY = os.getenv("SECRET_KEY", "change-this-secret-key")
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 7  # 7 days

# In-memory user database (replace with real database)
users_db = {}

def hash_password(password: str) -> str:
    return pwd_context.hash(password)

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return pwd_context.verify(plain_password, hashed_password)

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt
```

Add these endpoints:

```python
@app.post("/api/auth/signup")
async def signup(data: dict):
    username = data.get('username')
    email = data.get('email')
    password = data.get('password')

    if not all([username, email, password]):
        return JSONResponse({
            'success': False,
            'error': 'Missing required fields'
        }, status_code=400)

    if email in users_db:
        return JSONResponse({
            'success': False,
            'error': 'Email already registered'
        }, status_code=400)

    # Hash password
    hashed_password = hash_password(password)

    # Create user
    user = {
        'username': username,
        'email': email,
        'password': hashed_password,
        'created_at': datetime.now().isoformat(),
        'provider': 'email'
    }
    users_db[email] = user

    # Generate token
    token = create_access_token({'email': email})

    return JSONResponse({
        'success': True,
        'token': token,
        'user': {'username': username, 'email': email}
    })


@app.post("/api/auth/login")
async def login(data: dict):
    email = data.get('email')
    password = data.get('password')

    if not all([email, password]):
        return JSONResponse({
            'success': False,
            'error': 'Missing email or password'
        }, status_code=400)

    if email not in users_db:
        return JSONResponse({
            'success': False,
            'error': 'Invalid email or password'
        }, status_code=401)

    user = users_db[email]

    if not verify_password(password, user['password']):
        return JSONResponse({
            'success': False,
            'error': 'Invalid email or password'
        }, status_code=401)

    # Generate token
    token = create_access_token({'email': email})

    return JSONResponse({
        'success': True,
        'token': token,
        'user': {'username': user['username'], 'email': email}
    })


@app.get("/auth/google/callback")
async def google_callback(code: str, request: Request):
    """Handle Google OAuth callback"""

    try:
        # Exchange code for access token
        token_url = "https://oauth2.googleapis.com/token"
        data = {
            'code': code,
            'client_id': os.getenv('GOOGLE_CLIENT_ID'),
            'client_secret': os.getenv('GOOGLE_CLIENT_SECRET'),
            'redirect_uri': str(request.base_url).rstrip('/') + '/auth/google/callback',
            'grant_type': 'authorization_code'
        }

        async with httpx.AsyncClient() as client:
            token_response = await client.post(token_url, data=data)
            token_response.raise_for_status()
            tokens = token_response.json()

            # Get user info from Google
            user_info_response = await client.get(
                'https://www.googleapis.com/oauth2/v2/userinfo',
                headers={'Authorization': f'Bearer {tokens["access_token"]}'}
            )
            user_info_response.raise_for_status()
            user_info = user_info_response.json()

        # Extract user details
        email = user_info.get('email')
        name = user_info.get('name', email.split('@')[0])
        google_id = user_info.get('id')

        # Create or update user
        if email not in users_db:
            users_db[email] = {
                'username': name,
                'email': email,
                'google_id': google_id,
                'provider': 'google',
                'created_at': datetime.now().isoformat()
            }

        # Generate our JWT token
        token = create_access_token({'email': email})

        # Redirect to home with token (stored via JavaScript)
        return HTMLResponse(f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Login Successful</title>
            <style>
                body {{
                    font-family: Arial, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    margin: 0;
                }}
                .loading {{
                    text-align: center;
                }}
                .spinner {{
                    border: 4px solid rgba(255,255,255,0.3);
                    border-top: 4px solid white;
                    border-radius: 50%;
                    width: 40px;
                    height: 40px;
                    animation: spin 1s linear infinite;
                    margin: 20px auto;
                }}
                @keyframes spin {{
                    0% {{ transform: rotate(0deg); }}
                    100% {{ transform: rotate(360deg); }}
                }}
            </style>
        </head>
        <body>
            <div class="loading">
                <div class="spinner"></div>
                <h2>Login Successful!</h2>
                <p>Redirecting...</p>
            </div>
            <script>
                // Store auth token and user info
                localStorage.setItem('auth_token', '{token}');
                localStorage.setItem('user', JSON.stringify({{
                    username: '{name}',
                    email: '{email}'
                }}));

                // Check for pending report
                const pendingReport = sessionStorage.getItem('pending_report');
                sessionStorage.removeItem('pending_report');

                // Redirect
                setTimeout(() => {{
                    if (pendingReport) {{
                        window.location.href = pendingReport;
                    }} else {{
                        window.location.href = '/';
                    }}
                }}, 1000);
            </script>
        </body>
        </html>
        """)

    except Exception as e:
        print(f"Google OAuth error: {e}")
        return HTMLResponse(f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Login Failed</title>
            <style>
                body {{
                    font-family: Arial, sans-serif;
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    height: 100vh;
                    background: #f5f5f5;
                    margin: 0;
                }}
                .error {{
                    background: white;
                    padding: 40px;
                    border-radius: 10px;
                    text-align: center;
                    max-width: 400px;
                }}
                .error h2 {{ color: #e53e3e; }}
                .btn {{
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    padding: 12px 24px;
                    border-radius: 8px;
                    text-decoration: none;
                    display: inline-block;
                    margin-top: 20px;
                }}
            </style>
        </head>
        <body>
            <div class="error">
                <h2>❌ Login Failed</h2>
                <p>Unable to complete Google login.</p>
                <p><small>{str(e)}</small></p>
                <a href="/" class="btn">Back to Home</a>
            </div>
        </body>
        </html>
        """)
```

### 7. Test the Integration

1. **Start the server:**
   ```bash
   py -m uvicorn app:app --host 0.0.0.0 --port 8002 --reload
   ```

2. **Open browser:**
   ```
   http://localhost:8002
   ```

3. **Test Google Login:**
   - Click "View Report" on any dashboard
   - Login modal appears
   - Click "Continue with Google"
   - Google consent screen appears
   - Authorize the app
   - Redirected back to your site
   - Should be logged in and redirected to report

### 8. Production Deployment

For production (Railway, Heroku, etc.):

1. **Update Authorized Redirect URIs in Google Console:**
   - Add: `https://your-domain.com/auth/google/callback`

2. **Update Authorized JavaScript origins:**
   - Add: `https://your-domain.com`

3. **Set Environment Variables on your hosting:**
   ```
   GOOGLE_CLIENT_ID=your-client-id
   GOOGLE_CLIENT_SECRET=your-secret
   SECRET_KEY=your-jwt-secret
   ```

4. **Update the clientId in your frontend files:**
   - Use the same Client ID for both localhost and production
   - Google will validate the origin automatically

## Troubleshooting

### Error: "redirect_uri_mismatch"
- Make sure the redirect URI in Google Console EXACTLY matches: `http://localhost:8002/auth/google/callback`
- Check for trailing slashes
- Verify port number

### Error: "invalid_client"
- Check that Client ID and Secret are correct in `.env` file
- Make sure `.env` file is in the project root
- Verify `python-dotenv` is installed

### Google Login Button Does Nothing
- Open browser console (F12)
- Check if Client ID is set correctly
- Make sure the Google Cloud project is active

### Users Can't Access After Login
- Check browser localStorage (F12 → Application → Local Storage)
- Verify `auth_token` is stored
- Check server logs for errors

## Security Best Practices

1. **Never commit `.env` file**
   - Add `.env` to `.gitignore`

2. **Use strong SECRET_KEY**
   - Generate with: `python -c "import secrets; print(secrets.token_urlsafe(32))"`

3. **Use HTTPS in production**
   - Required by Google OAuth in production

4. **Implement token refresh**
   - Current tokens expire after 7 days
   - Add refresh token mechanism for better UX

5. **Store tokens securely**
   - Consider HttpOnly cookies instead of localStorage
   - Protects against XSS attacks
