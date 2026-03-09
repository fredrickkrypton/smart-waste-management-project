from flask import Flask, render_template, jsonify, request, session, redirect, url_for
import time
import random
import firebase_admin
from firebase_admin import credentials, firestore, auth
from functools import wraps

app = Flask(__name__)
app.secret_key = "eco-tech-secret-key-uganda" # Change this for production

# -----------------------------
# FIREBASE SETUP
# -----------------------------
try:
    # Use your new serviceAccountKey.json
    cred = credentials.Certificate("serviceAccountKey.json")
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("✅ Firebase & Auth Connected Successfully")
except Exception as e:
    print(f"❌ Firebase Error: {e}")

# -----------------------------
# ROLE-BASED ACCESS CONTROL (RBAC) DECORATORS
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
# HARDWARE / MOCKING LOGIC
# -----------------------------
try:
    import RPi.GPIO as GPIO
    GPIO.setmode(GPIO.BCM)
    HAS_GPIO = True
except ImportError:
    HAS_GPIO = False
    print("⚠️ Running on Windows: Using mock data for sensors.")

def get_distance():
    if not HAS_GPIO:
        return random.randint(5, 45) # Mock distance in cm
    
    TRIG, ECHO = 23, 24
    GPIO.setup(TRIG, GPIO.OUT)
    GPIO.setup(ECHO, GPIO.IN)
    GPIO.output(TRIG, True)
    time.sleep(0.00001)
    GPIO.output(TRIG, False)
    
    pulse_start, pulse_end = time.time(), time.time()
    while GPIO.input(ECHO) == 0: pulse_start = time.time()
    while GPIO.input(ECHO) == 1: pulse_end = time.time()
    
    return round((pulse_end - pulse_start) * 17150, 2)

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
    # Only logged-in users can see the dashboard
    return render_template('index.html', role=session.get('role'))

@app.route('/login')
def login_page():
    return render_template('login.html')

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    """Verifies Firebase ID Token and checks for Admin claims"""
    data = request.json
    id_token = data.get("idToken")

    try:
        # Verify the token and extract claims
        decoded_token = auth.verify_id_token(id_token)
        uid = decoded_token['uid']
        
        # Check for the custom 'role' claim we set via set_admin.py
        role = decoded_token.get('role', 'viewer') 
        
        # Save to session
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
    dist = get_distance()
    bin_height = 50
    level_pct = max(0, min(100, round(((bin_height - dist) / bin_height) * 100)))

    bin_id = "KLA-01"
    lat, lng = 0.3476, 32.5825
    
    # Push to Firebase Firestore
    sync_to_cloud(bin_id, level_pct, lat, lng)

    data = [
        {"id": bin_id, "lat": lat, "lng": lng, "level": level_pct, "status": "OK"},
        {"id": "KLA-02", "lat": 0.3490, "lng": 32.5800, "level": 40, "status": "OK"}
    ]
    return jsonify(data)

if __name__ == '__main__':
    try:
        app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)
    finally:
        if HAS_GPIO: GPIO.cleanup()