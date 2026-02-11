"""
User authentication system with JWT tokens
"""
import jwt
import bcrypt
import duckdb
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional, Dict
import secrets

# Secret key for JWT (in production, use environment variable)
SECRET_KEY = secrets.token_hex(32)
ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24  # 24 hours

class AuthService:
    """Handle user authentication and authorization"""
    
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._init_users_table()
    
    def _init_users_table(self):
        """Create users table if it doesn't exist"""
        con = duckdb.connect(self.db_path)
        con.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY,
                username VARCHAR UNIQUE NOT NULL,
                email VARCHAR UNIQUE NOT NULL,
                password_hash VARCHAR NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_login TIMESTAMP,
                is_active BOOLEAN DEFAULT TRUE
            )
        """)
        con.close()
    
    def hash_password(self, password: str) -> str:
        """Hash a password using bcrypt"""
        salt = bcrypt.gensalt()
        return bcrypt.hashpw(password.encode('utf-8'), salt).decode('utf-8')
    
    def verify_password(self, password: str, hashed: str) -> bool:
        """Verify a password against its hash"""
        return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))
    
    def create_user(self, username: str, email: str, password: str) -> Dict:
        """Create a new user"""
        con = duckdb.connect(self.db_path)
        
        # Check if user exists
        existing = con.execute(
            "SELECT id FROM users WHERE username = ? OR email = ?",
            [username, email]
        ).fetchone()
        
        if existing:
            con.close()
            raise ValueError("Username or email already exists")
        
        # Hash password and insert user
        password_hash = self.hash_password(password)
        
        result = con.execute("""
            INSERT INTO users (username, email, password_hash)
            VALUES (?, ?, ?)
            RETURNING id, username, email, created_at
        """, [username, email, password_hash]).fetchone()
        
        con.close()
        
        return {
            'id': result[0],
            'username': result[1],
            'email': result[2],
            'created_at': str(result[3])
        }
    
    def authenticate_user(self, username: str, password: str) -> Optional[Dict]:
        """Authenticate a user and return user data if valid"""
        con = duckdb.connect(self.db_path)
        
        user = con.execute("""
            SELECT id, username, email, password_hash, is_active
            FROM users
            WHERE username = ? OR email = ?
        """, [username, username]).fetchone()
        
        if not user:
            con.close()
            return None
        
        user_id, username, email, password_hash, is_active = user
        
        if not is_active:
            con.close()
            return None
        
        if not self.verify_password(password, password_hash):
            con.close()
            return None
        
        # Update last login
        con.execute(
            "UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?",
            [user_id]
        )
        con.close()
        
        return {
            'id': user_id,
            'username': username,
            'email': email
        }
    
    def create_access_token(self, user_data: Dict) -> str:
        """Create a JWT access token"""
        expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
        
        to_encode = {
            'user_id': user_data['id'],
            'username': user_data['username'],
            'email': user_data['email'],
            'exp': expire
        }
        
        encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
        return encoded_jwt
    
    def verify_token(self, token: str) -> Optional[Dict]:
        """Verify a JWT token and return user data"""
        try:
            payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
            return {
                'id': payload.get('user_id'),
                'username': payload.get('username'),
                'email': payload.get('email')
            }
        except jwt.ExpiredSignatureError:
            return None
        except jwt.JWTError:
            return None
    
    def get_user_by_id(self, user_id: int) -> Optional[Dict]:
        """Get user by ID"""
        con = duckdb.connect(self.db_path, read_only=True)
        
        user = con.execute("""
            SELECT id, username, email, created_at, last_login
            FROM users
            WHERE id = ? AND is_active = TRUE
        """, [user_id]).fetchone()
        
        con.close()
        
        if not user:
            return None
        
        return {
            'id': user[0],
            'username': user[1],
            'email': user[2],
            'created_at': str(user[3]),
            'last_login': str(user[4]) if user[4] else None
        }
