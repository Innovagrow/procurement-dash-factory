"""
User Authentication & Authorization
JWT-based auth with PostgreSQL user storage
"""
import os
import jwt
import bcrypt
from datetime import datetime, timedelta
from typing import Optional, Dict
from pydantic import BaseModel, EmailStr
import duckdb

# JWT Secret (use environment variable in production)
JWT_SECRET = os.getenv('JWT_SECRET', 'your-secret-key-change-in-production')
JWT_ALGORITHM = 'HS256'
JWT_EXPIRATION_HOURS = 24

class User(BaseModel):
    """User model"""
    id: Optional[int] = None
    email: EmailStr
    username: str
    password_hash: str
    created_at: Optional[datetime] = None
    is_active: bool = True

class UserLogin(BaseModel):
    """Login request"""
    email: EmailStr
    password: str

class UserSignup(BaseModel):
    """Signup request"""
    email: EmailStr
    username: str
    password: str

def init_auth_db(db_path: str = 'eurodash.duckdb'):
    """Initialize authentication tables"""
    con = duckdb.connect(db_path)
    
    # Drop existing tables to recreate with proper schema
    try:
        con.execute("DROP TABLE IF EXISTS user_sessions")
        con.execute("DROP TABLE IF EXISTS users")
    except:
        pass
    
    con.execute("""
        CREATE SEQUENCE IF NOT EXISTS users_id_seq START 1
    """)
    
    con.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY DEFAULT nextval('users_id_seq'),
            email VARCHAR UNIQUE NOT NULL,
            username VARCHAR NOT NULL,
            password_hash VARCHAR NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            is_active BOOLEAN DEFAULT TRUE
        )
    """)
    
    con.execute("""
        CREATE SEQUENCE IF NOT EXISTS sessions_id_seq START 1
    """)
    
    con.execute("""
        CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY DEFAULT nextval('sessions_id_seq'),
            user_id INTEGER NOT NULL,
            token VARCHAR NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    """)
    
    con.close()

def hash_password(password: str) -> str:
    """Hash password with bcrypt"""
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(password.encode('utf-8'), salt).decode('utf-8')

def verify_password(password: str, password_hash: str) -> bool:
    """Verify password against hash"""
    return bcrypt.checkpw(password.encode('utf-8'), password_hash.encode('utf-8'))

def create_jwt_token(user_id: int, email: str) -> str:
    """Create JWT token"""
    payload = {
        'user_id': user_id,
        'email': email,
        'exp': datetime.utcnow() + timedelta(hours=JWT_EXPIRATION_HOURS),
        'iat': datetime.utcnow()
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)

def verify_jwt_token(token: str) -> Optional[Dict]:
    """Verify JWT token and return payload"""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except jwt.ExpiredSignatureError:
        return None  # Token expired
    except jwt.InvalidTokenError:
        return None  # Invalid token

def signup_user(signup: UserSignup, db_path: str = 'eurodash.duckdb') -> Dict:
    """Create new user account"""
    con = duckdb.connect(db_path)
    
    # Check if user exists
    existing = con.execute(
        "SELECT id FROM users WHERE email = ?", 
        [signup.email]
    ).fetchone()
    
    if existing:
        con.close()
        return {'success': False, 'error': 'Email already registered'}
    
    # Hash password
    password_hash = hash_password(signup.password)
    
    # Insert user
    try:
        con.execute("""
            INSERT INTO users (email, username, password_hash)
            VALUES (?, ?, ?)
        """, [signup.email, signup.username, password_hash])
        
        # Get new user ID
        user = con.execute(
            "SELECT id, email, username FROM users WHERE email = ?",
            [signup.email]
        ).fetchone()
        
        con.close()
        
        # Create JWT token
        token = create_jwt_token(user[0], user[1])
        
        return {
            'success': True,
            'token': token,
            'user': {
                'id': user[0],
                'email': user[1],
                'username': user[2]
            }
        }
    except Exception as e:
        con.close()
        return {'success': False, 'error': str(e)}

def login_user(login: UserLogin, db_path: str = 'eurodash.duckdb') -> Dict:
    """Authenticate user and return JWT token"""
    con = duckdb.connect(db_path)
    
    # Get user
    user = con.execute("""
        SELECT id, email, username, password_hash, is_active
        FROM users WHERE email = ?
    """, [login.email]).fetchone()
    
    con.close()
    
    if not user:
        return {'success': False, 'error': 'Invalid email or password'}
    
    # Check if active
    if not user[4]:
        return {'success': False, 'error': 'Account disabled'}
    
    # Verify password
    if not verify_password(login.password, user[3]):
        return {'success': False, 'error': 'Invalid email or password'}
    
    # Create JWT token
    token = create_jwt_token(user[0], user[1])
    
    return {
        'success': True,
        'token': token,
        'user': {
            'id': user[0],
            'email': user[1],
            'username': user[2]
        }
    }

def get_current_user(token: str, db_path: str = 'eurodash.duckdb') -> Optional[Dict]:
    """Get current user from JWT token"""
    payload = verify_jwt_token(token)
    
    if not payload:
        return None
    
    con = duckdb.connect(db_path, read_only=True)
    user = con.execute("""
        SELECT id, email, username, is_active
        FROM users WHERE id = ?
    """, [payload['user_id']]).fetchone()
    con.close()
    
    if not user or not user[3]:
        return None
    
    return {
        'id': user[0],
        'email': user[1],
        'username': user[2]
    }
