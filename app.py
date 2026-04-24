from flask import Flask, render_template, jsonify, request, session, redirect, url_for
import base64
import time
import random
import secrets
from datetime import datetime
import firebase_admin
from firebase_admin import credentials, firestore, auth
from functools import wraps

app = Flask(__name__)
app.secret_key = "eco-tech-secret-key-uganda" 

# Shared secret for Raspberry Pi requests
PI_API_KEY = "eco_tech_pi_secret_key_2024"

# -----------------------------
# FIREBASE SETUP
# -----------------------------
try:
    cred = credentials.Certificate("serviceAccountKey.json")
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("✅ Firebase & Auth Connected Successfully")
    print(f"📁 Firebase Project: {firebase_admin.get_app().project_id}")
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
# SENSOR LOGIC (for simulation)
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
    return 25

def sync_to_cloud(bin_id, level, lat, lng):
    try:
        doc_ref = db.collection('bins').document(bin_id)
        existing_doc = doc_ref.get()
        label = bin_id
        if existing_doc.exists:
            existing_data = existing_doc.to_dict() or {}
            label = existing_data.get('label') or existing_data.get('location_name') or existing_data.get('name') or bin_id
        doc_ref.set({
            'label': label,
            'level': level,
            'lat': lat,
            'lng': lng,
            'last_updated': firestore.SERVER_TIMESTAMP,
            'status': "CRITICAL" if level > 80 else "OK"
        }, merge=True)
    except Exception as e:
        print(f"Cloud Sync Error: {e}")

# -----------------------------
# PI DATA ENDPOINT
# -----------------------------
@app.route('/api/pi/update', methods=['POST'])
def pi_update():
    print("=" * 50)
    print("🔵 Pi update endpoint called!")
    print("=" * 50)

    try:
        data = request.json or {}
        print(f"📦 Received data: {data.keys()}")

        # Verify the Raspberry Pi is authorized
        api_key = request.headers.get('X-API-Key')
        if not api_key or not secrets.compare_digest(api_key, PI_API_KEY):
            print("❌ Unauthorized request: invalid X-API-Key")
            return jsonify({"error": "Unauthorized"}), 401

        if not firebase_admin._apps:
            print("❌ Firebase NOT initialized!")
            return jsonify({"error": "Firebase not ready"}), 500
        else:
            print("✅ Firebase is initialized")

        # Required fields from Pi
        bin_id = data.get('bin_id', 'KLA-01')
        fill_level = data.get('fill_level', 0)
        ultrasonic_cm = data.get('ultrasonic_cm', 0)
        waste_composition = data.get('waste_composition', {})
        status = data.get('status', 'OK')
        alert_triggered = data.get('alert_triggered', False)

        # Handle image if present
        if data.get('image_base64'):
            image_payload = data['image_base64']
            try:
                decoded_image = base64.b64decode(image_payload.split(',')[-1])
                print(f"   📸 Image received: {len(decoded_image)} bytes")
            except Exception as image_error:
                print(f"   ⚠️ Image decode warning: {image_error}")

        update_data = {
            'level': fill_level,
            'ultrasonic_cm': ultrasonic_cm,
            'waste_composition': waste_composition,
            'status': status,
            'alert_triggered': alert_triggered,
            'last_updated': firestore.SERVER_TIMESTAMP,
            'last_classification': firestore.SERVER_TIMESTAMP
        }

        if data.get('image_base64'):
            update_data['latest_image_base64'] = data['image_base64'].split(',')[-1]
            update_data['has_image'] = True
            update_data['image_timestamp'] = firestore.SERVER_TIMESTAMP

        # Get bin coordinates from existing Firestore document
        bin_doc = db.collection('bins').document(bin_id).get()
        if bin_doc.exists:
            existing = bin_doc.to_dict()
            update_data['label'] = existing.get('label', bin_id)
            update_data['lat'] = existing.get('lat', 0.3476)
            update_data['lng'] = existing.get('lng', 32.5825)
        else:
            update_data['label'] = data.get('label', bin_id)
            update_data['lat'] = data.get('lat', 0.3476)
            update_data['lng'] = data.get('lng', 32.5825)

        print(f"📝 Writing to Firestore - Bin: {bin_id}, Level: {fill_level}% at {datetime.utcnow().isoformat()}Z")

        # Update Firestore with Pi data
        doc_ref = db.collection('bins').document(bin_id)
        doc_ref.set(update_data, merge=True)

        print("✅ Firestore write successful!")
        print(f"✅ Pi data received for {bin_id}: {fill_level}% full")
        return jsonify({"success": True, "message": "Data synced to Firestore"}), 200

    except Exception as e:
        print(f"❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "error": str(e)}), 500

# -----------------------------
# ROUTES
# -----------------------------
@app.route('/')
@login_required
def home():
    return render_template('index.html', role=session.get('role'))

@app.route('/login')
def login_page():
    return render_template('login.html')

@app.route('/api/auth/login', methods=['POST'])
def auth_login():
    data = request.json
    id_token = data.get("idToken")
    try:
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
    user_role = session.get('role')
    bin_id = "KLA-01"
    lat, lng = 0.3476, 32.5825
    
    if user_role in ['admin', 'operator']:
        dist = get_distance()
        bin_height = 50
        level_pct = max(0, min(100, round(((bin_height - dist) / bin_height) * 100)))
        sync_to_cloud(bin_id, level_pct, lat, lng)
    
    bins_ref = db.collection('bins').stream()
    bins_data = []
    for doc in bins_ref:
        doc_data = doc.to_dict() or {}
        doc_data.setdefault('label', doc_data.get('location_name') or doc_data.get('name') or doc.id)
        bins_data.append({"id": doc.id, **doc_data})
        
    return jsonify(bins_data)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)