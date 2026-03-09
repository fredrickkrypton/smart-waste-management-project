import firebase_admin
from firebase_admin import credentials, auth

# 1. Initialize (only if not already initialized)
cred = credentials.Certificate("serviceAccountKey.json")
if not firebase_admin._apps:
    firebase_admin.initialize_app(cred)

def assign_user_role(uid, role_name):
    """
    Assigns a specific role to a user UID.
    Roles: 'admin', 'operator', or 'viewer'
    """
    try:
        # Attach the 'role' claim permanently to the user's token
        auth.set_custom_user_claims(uid, {'role': role_name})
        print(f"✅ Success! User {uid} is now assigned the role: {role_name}")
    except Exception as e:
        print(f"❌ Error assigning role: {e}")

# --- EXECUTION AREA ---
# Replace these with the actual UIDs you created in the Firebase Console
assign_user_role("B1EfrEBZJNboYa1aCOodNQzCkwd2", "admin")      # Already done for you
assign_user_role("SS5q5GG1tWQvW3B0CIADpzP3nF73", "operator")           # For the Truck Driver
assign_user_role("7lhFes1SAOZjD5y0FCQG1QcFhqG2", "viewer")           # For the Public Resident