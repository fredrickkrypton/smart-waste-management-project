from flask import Flask, render_template, jsonify, request, session
import time
import random
import firebase_admin
from firebase_admin import credentials, firestore

app = Flask(__name__)
app.secret_key = "eco-tech-secret" 

# -----------------------------
# FIREBASE SETUP
# -----------------------------
try:
    cred = credentials.Certificate("serviceAccountKey.json")
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("✅ Firebase Connected Successfully")
except Exception as e:
    print(f"❌ Firebase Error: {e}")

# -----------------------------
# MOCK USERS
# -----------------------------
users = {
    "admin": {"password": "123", "role": "admin"},
    "manager": {"password": "123", "role": "manager"},
    "operator": {"password": "123", "role": "operator"}
}

# -----------------------------
# WINDOWS-SAFE HARDWARE MOCKING
# -----------------------------
try:
    import RPi.GPIO as GPIO
    GPIO.setmode(GPIO.BCM)
    HAS_GPIO = True
except ImportError:
    HAS_GPIO = False
    print("⚠️ Running on Windows: Hardware sensors are DISABLED. Using mock data.")

def get_distance():
    if not HAS_GPIO:
        return random.randint(5, 50) 
    
    TRIG = 23 
    ECHO = 24
    GPIO.setup(TRIG, GPIO.OUT)
    GPIO.setup(ECHO, GPIO.IN)
    GPIO.output(TRIG, True)
    time.sleep(0.00001)
    GPIO.output(TRIG, False)
    
    pulse_start, pulse_end = time.time(), time.time()
    while GPIO.input(ECHO) == 0: pulse_start = time.time()
    while GPIO.input(ECHO) == 1: pulse_end = time.time()
    
    return round((pulse_end - pulse_start) * 17150, 2)

# New helper function to sync data to the cloud
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
def home():
    return render_template('index.html')

@app.route('/login', methods=['POST'])
def login():
    data = request.json
    user = users.get(data.get("username"))
    if user and user["password"] == data.get("password"):
        session['user'] = data.get("username")
        session['role'] = user["role"]
        return jsonify({"message": "Login successful", "role": user["role"]})
    return jsonify({"error": "Invalid credentials"}), 401

@app.route('/api/bins')
def get_bins():
    dist = get_distance()
    bin_height = 50
    level_pct = max(0, min(100, round(((bin_height - dist) / bin_height) * 100)))

    # Define our live bin data
    bin_id = "KLA-01"
    lat, lng = 0.3476, 32.5825
    
    # 🔥 SYNC TO FIREBASE: This pushes the data to the cloud
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