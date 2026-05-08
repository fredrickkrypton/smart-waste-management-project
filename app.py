from flask import Flask, render_template, jsonify, request, session, redirect, url_for
import base64
import time
import random
import secrets
import json
import sqlite3
from datetime import datetime
import firebase_admin
from firebase_admin import credentials, firestore, auth
from functools import wraps

app = Flask(__name__)
app.secret_key = "eco-tech-secret-key-uganda" 

# Shared secret for Raspberry Pi requests
PI_API_KEY = "eco_tech_pi_secret_key_2024"

# Local persistence for cycle history (kept across restarts)
CYCLE_DB_PATH = "cycle_history.db"

def init_cycle_store():
    with sqlite3.connect(CYCLE_DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cycle_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                bin_id TEXT NOT NULL,
                time TEXT NOT NULL,
                level REAL,
                cycle_number INTEGER,
                historical_avg REAL,
                trend TEXT,
                waste_composition TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_cycle_bin_time ON cycle_history (bin_id, time)")

def append_cycle_history(bin_id, entry):
    with sqlite3.connect(CYCLE_DB_PATH) as conn:
        conn.execute(
            """
            INSERT INTO cycle_history (bin_id, time, level, cycle_number, historical_avg, trend, waste_composition)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                bin_id,
                entry.get('time'),
                entry.get('level'),
                entry.get('cycle_number'),
                entry.get('historical_avg'),
                entry.get('trend'),
                json.dumps(entry.get('waste_composition') or {})
            )
        )

def get_cycle_history(bin_id, limit=10):
    with sqlite3.connect(CYCLE_DB_PATH) as conn:
        cursor = conn.execute(
            """
            SELECT time, level, cycle_number, historical_avg, trend, waste_composition
            FROM cycle_history
            WHERE bin_id = ?
            ORDER BY time DESC
            LIMIT ?
            """,
            (bin_id, limit)
        )
        rows = cursor.fetchall()

    history = []
    for time_value, level, cycle_number, historical_avg, trend, waste_composition in rows[::-1]:
        try:
            composition = json.loads(waste_composition) if waste_composition else {}
        except json.JSONDecodeError:
            composition = {}
        history.append({
            'time': time_value,
            'level': level,
            'cycle_number': cycle_number,
            'historical_avg': historical_avg,
            'trend': trend,
            'waste_composition': composition
        })
    return history

init_cycle_store()

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
            'bin_id': bin_id,
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
        print(f"📦 Received keys: {list(data.keys())}")

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
        lat = data.get('lat', 0.3476)
        lng = data.get('lng', 32.5825)

        # New fields from Pi (use exact payload values)
        cycle_number = data.get('cycle_number')
        historical_avg = data.get('historical_avg')
        trend = data.get('trend')

        # Handle image if present
        image_base64 = data.get('image_base64', None)

        if image_base64:
            image_payload = image_base64
            try:
                decoded_image = base64.b64decode(image_payload.split(',')[-1])
                print(f"   📸 Image received: {len(decoded_image)} bytes")
            except Exception as image_error:
                print(f"   ⚠️ Image decode warning: {image_error}")

        print(f"📝 Writing to Firestore - Bin: {bin_id}")
        print(f"   Cycle: {cycle_number}, Fill: {fill_level}%, Trend: {trend}")
        print(f"   Historical avg: {historical_avg}")

        update_data = {
            'bin_id': bin_id,
            'level': fill_level,
            'lat': lat,
            'lng': lng,
            'ultrasonic_cm': ultrasonic_cm,
            'waste_composition': waste_composition,
            'status': status,
            'alert_triggered': alert_triggered,
            'cycle_number': cycle_number,
            'trend': trend,
            'last_classification': firestore.SERVER_TIMESTAMP,
            'last_updated': firestore.SERVER_TIMESTAMP
        }

        update_data['historical_avg'] = historical_avg

        if image_base64:
            update_data['latest_image_base64'] = f"data:image/jpeg;base64,{image_base64}"
            update_data['image_timestamp'] = firestore.SERVER_TIMESTAMP

        # Persist last cycles locally to avoid Firestore overwrite loss
        cache_entry = {
            'time': datetime.utcnow().isoformat(),
            'level': fill_level,
            'cycle_number': cycle_number,
            'historical_avg': historical_avg,
            'trend': trend,
            'waste_composition': waste_composition
        }
        append_cycle_history(bin_id, cache_entry)

        # Get bin label from existing Firestore document
        bin_doc = db.collection('bins').document(bin_id).get()
        if bin_doc.exists:
            existing = bin_doc.to_dict() or {}
            update_data['label'] = existing.get('label', bin_id)
        else:
            update_data['label'] = data.get('label', bin_id)

        # Update Firestore with Pi data
        doc_ref = db.collection('bins').document(bin_id)
        doc_ref.set(update_data, merge=True)

        print("✅ Firestore write successful!")
        print(f"✅ Cycle {cycle_number} data saved for {bin_id}")
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
    skip_sim = request.args.get('skip_sim') == '1'
    bin_id = "KLA-01"
    lat, lng = 0.3476, 32.5825
    
    if user_role in ['admin', 'operator'] and not skip_sim:
        dist = get_distance()
        bin_height = 50
        level_pct = max(0, min(100, round(((bin_height - dist) / bin_height) * 100)))
        sync_to_cloud(bin_id, level_pct, lat, lng)
    
    bins_ref = db.collection('bins').stream()
    bins_data = []
    for doc in bins_ref:
        doc_data = doc.to_dict() or {}
        cache_key = doc_data.get('bin_id') or doc.id
        cached_history = get_cycle_history(cache_key, limit=10)
        doc_data['cycle_history'] = cached_history if cached_history else []
        raw_label = doc_data.get('label') or doc_data.get('bin_id') or doc_data.get('bin_code') or doc_data.get('code') or doc_data.get('location_name') or doc_data.get('name')
        if raw_label and (raw_label != doc.id or len(str(raw_label)) < 18):
            doc_data['display_label'] = raw_label
        else:
            doc_data['display_label'] = None
        doc_data.setdefault('label', raw_label or doc.id)
        bins_data.append({"id": doc.id, **doc_data})
        
    return jsonify(bins_data)

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True, use_reloader=False)