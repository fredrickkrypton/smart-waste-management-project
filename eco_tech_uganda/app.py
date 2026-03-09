from flask import Flask, render_template, jsonify, request, session, redirect, url_for
import time
import random
import firebase_admin
from firebase_admin import credentials, firestore, auth
from functools import wraps

app = Flask(__name__)
app.secret_key = "eco-tech-secret-key-uganda" 

# -----------------------------
# FIREBASE SETUP
# -----------------------------
try:
    cred = credentials.Certificate("serviceAccountKey.json")
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("✅ Firebase & Auth Connected Successfully")
except Exception as e:
    print(f"❌ Firebase Error: {e}")

# -----------------------------
# RBAC DECORATORS
# -----------------------------
def login_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if 'user' not in session:
            return redirect(url_for('login_page'))
        return f(*args, **kwargs)
    return decorated_function

def admin_required(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if session.get('role') != 'admin':
            return jsonify({"error": "Unauthorized: Admin access required"}), 403
        return f(*args, **kwargs)
    return decorated_function

# -----------------------------
# SENSOR LOGIC
# -----------------------------
try:
    import RPi.GPIO as GPIO
    GPIO.setmode(GPIO.BCM)
    HAS_GPIO = True
except ImportError:
    HAS_GPIO = False

def get_distance():
    if not HAS_GPIO:
        return random.randint(5, 45) 
    # (GPIO logic remains the same as your previous version)
    return 25 

def sync_to_cloud(bin_id, level, lat, lng):
    try:
        doc_ref = db.collection('bins').document(bin_id)
        doc_ref.set({
            'level': level,
            'lat': lat,
            'lng': lng,
            'last_updated': firestore.SERVER_TIMESTAMP,
            'status': "CRITICAL" if level > 80 else "OK"
        }, merge=True)
    except Exception as e:
        print(f"Cloud Sync Error: {e}")

# -----------------------------
# ROUTES
# -----------------------------

@app.route('/')
@login_required
def home():
    # Passes the role to index.html for UI filtering
    return render_template('index.html', role=session.get('role'))

@app.route('/login')
def login_page():
    return render_template('login.html')

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    data = request.json
    id_token = data.get("idToken")
    try:
        # Verify Token and extract Custom Claims
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']
        role = decoded_token.get('role', 'viewer') 
        
        session['user'] = uid
        session['role'] = role
        return jsonify({"status": "success", "role": role})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)}), 401

@app.route('/logout')
def logout():
    session.clear()
    return redirect(url_for('login_page'))

@app.route('/api/bins')
@login_required
def get_bins():
    """
    Role-Based Data Logic: 
    - Admin/Operator: Triggers sensor read & Cloud Sync.
    - Viewer: Only reads existing data.
    """
    user_role = session.get('role')
    bin_id = "KLA-01"
    lat, lng = 0.3476, 32.5825
    
    # Only allow 'admin' or 'operator' to trigger hardware/sync
    if user_role in ['admin', 'operator']:
        dist = get_distance()
        bin_height = 50
        level_pct = max(0, min(100, round(((bin_height - dist) / bin_height) * 100)))
        sync_to_cloud(bin_id, level_pct, lat, lng)
    
    # Fetch all bins for the map display
    bins_ref = db.collection('bins').stream()
    bins_data = []
    for doc in bins_ref:
        bins_data.append({"id": doc.id, **doc.to_dict()})
        
    return jsonify(bins_data)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)